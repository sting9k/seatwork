import { posix } from "node:path";
import { literal, type Part, type Script, type Word } from "./shell";
import type { Known, Value, Variable } from "./types";

/** What a word names on disk: its value, the folder it stands in, and whether it is temporary. */

const GLOB = /[*?[]|[@!?*+]\(/;

/** A word's value, with `~`, `$HOME`, `$TMPDIR`, `$PWD` and earlier variables filled in. */
export function valueOf(word: Word, known: Known): Value {
  let text: string | null = "";
  let prefix = "";
  let quoted = false;
  let glob = false;
  let temp = false;
  const add = (piece: string) => {
    if (text !== null) text += piece;
    if (text !== null) prefix = text;
  };
  for (const part of word.parts) {
    if (part.kind === "text") {
      if (part.quote !== "none") quoted = true;
      else if (GLOB.test(part.text)) glob = true;
      add(part.text);
    } else if (part.kind === "tilde") {
      const home = part.user ? `~${part.user}` : homeOf(known);
      if (home === null) {
        if (text !== null) prefix = text;
        text = null;
      } else add(home);
    } else {
      const found = fill(part, known);
      if (found.temp) temp = true;
      if (found.text === null) {
        if (text !== null) prefix = text;
        text = null;
      } else add(found.text);
    }
  }
  return { text, prefix: text ?? prefix, quoted, glob, temp, word };
}

/** The folder `~` stands for: the machine's home unless the line set `HOME`; null when it set it to something not known. */
export function homeOf(known: Known): string | null {
  const set = known.vars.get("HOME");
  return set ? set.value : known.place.home;
}

/** What one run-time part of a word is worth: a variable's value, a substitution's text, or nothing known. */
function fill(part: Exclude<Part, { kind: "text" | "tilde" }>, known: Known): Variable & { text: string | null } {
  if (part.kind === "param") {
    if (!/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(part.raw)) return { text: null, value: null, temp: false };
    const set = known.vars.get(part.name);
    if (set) return { ...set, text: set.value };
    const builtin =
      part.name === "HOME"
        ? known.place.home
        : part.name === "PWD"
          ? known.cwd
          : part.name === "TMPDIR"
            ? known.place.tmp
            : null;
    return { text: builtin, value: builtin, temp: part.name === "TMPDIR" && builtin !== null };
  }
  if (part.kind === "command") return substitution(part.script, known);
  if (part.kind === "process") return { text: "/dev/fd/63", value: "/dev/fd/63", temp: false };
  return { text: null, value: null, temp: false };
}

/** What `$(...)` gives when known: `mktemp`, `pwd`, or the words of `echo`. */
export function substitution(script: Script, known: Known): Variable & { text: string | null } {
  const none = { text: null, value: null, temp: false };
  if (script.length !== 1 || script[0].pipelines.length !== 1 || script[0].pipelines[0].commands.length !== 1)
    return none;
  const command = script[0].pipelines[0].commands[0];
  if (command.kind !== "simple" || command.redirects.length) return none;
  const words = command.words.map((w) => literal(w));
  const name = words[0]?.split("/").pop();
  if (name === "mktemp") return { text: null, value: null, temp: true };
  if (name === "pwd" && words.length === 1) return { text: known.cwd, value: known.cwd, temp: false };
  const found = lookup(command.words, name, known);
  if (found !== null) return { text: found, value: found, temp: false };
  if (
    (name === "echo" || name === "printf") &&
    words.slice(1).every((w): w is string => w !== null && !w.includes("%"))
  ) {
    const args = (words.slice(1) as string[]).filter((w, i) => !(name === "echo" && i === 0 && /^-[neE]+$/.test(w)));
    const out = args.join(" ");
    return { text: out, value: out, temp: false };
  }
  return none;
}

/** The program a lookup command (`which`, `command -v`, `type -p`, `readlink`, `realpath`) names, standing for the path it prints; null for any other command. */
function lookup(words: Word[], name: string | undefined, known: Known): string | null {
  const flags = name === "command" ? ["-v"] : name === "type" ? ["-p", "-P"] : null;
  const start = flags ? (flags.includes(literal(words[1] ?? words[0]) ?? "") ? 2 : -1) : 1;
  if (start < 0 || !["which", "readlink", "greadlink", "realpath", "command", "type"].includes(name ?? "")) return null;
  const operands = words.slice(start).filter((w) => !(literal(w) ?? "x").startsWith("-"));
  return operands.length === 1 ? valueOf(operands[0], known).text : null;
}

/** The absolute path a value names, against the command's folder; null when unknown. */
export function absolute(value: Value, cwd: string | null): string | null {
  if (value.text === null) return null;
  if (value.text.startsWith("/")) return posix.normalize(value.text);
  if (value.text.startsWith("~")) return null;
  return cwd ? posix.join(cwd, value.text) : null;
}

const TEMP_ROOTS = ["/tmp/", "/var/tmp/", "/private/tmp/", "/private/var/tmp/"];

/** A path below one of the machine's temporary folders, with a real name and no `..`. */
export function tempPath(path: string): boolean {
  const root = TEMP_ROOTS.find((r) => path.startsWith(r));
  if (!root) return false;
  const rest = path
    .slice(root.length)
    .split("/")
    .filter((c) => c && c !== ".");
  return rest.length > 0 && !rest.includes("..");
}

/** True when the value is a temp path: a literal one, the seat's own folder, or mktemp's. */
export function isTemp(value: Value, known: Known): boolean {
  const tmp = known.place.tmp;
  if (value.text === null) {
    // a glob after a mktemp folder stays in it unless it climbs out
    if (value.temp && (!value.glob || !value.word.raw.includes("..")))
      return !value.prefix || (tmp !== null && within(value.prefix, tmp));
    return (
      tmp !== null &&
      value.prefix.length > tmp.length &&
      within(value.prefix, tmp) &&
      !value.prefix.slice(tmp.length).includes("..")
    );
  }
  if (/[{}\\]/.test(value.text) && !value.quoted) return false;
  if (tempPath(value.text)) return true;
  return (
    tmp !== null &&
    within(value.text, tmp) &&
    value.text.length > tmp.length + 1 &&
    !value.text.split("/").includes("..")
  );
}

/** True when `path` is `root` or lies below it. */
export function within(path: string, root: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(base);
}
