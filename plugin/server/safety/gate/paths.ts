import { posix } from "node:path";
import { literal, type Part, type Script, type Word } from "./shell";
import type { Known, Value, Variable } from "./types";

/** What a word names on disk, and the classes of path the file rules judge by. */

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
    } else if (part.kind === "tilde") add(part.user ? `~${part.user}` : known.place.home);
    else {
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

/** The absolute path a value names, against the command's folder; null when unknown. */
export function absolute(value: Value, cwd: string | null): string | null {
  if (value.text === null) return null;
  if (value.text.startsWith("/")) return posix.normalize(value.text);
  if (value.text.startsWith("~")) return null;
  return cwd ? posix.join(cwd, value.text) : null;
}

const TEMP_ROOTS = ["/tmp/", "/var/tmp/", "/private/tmp/", "/private/var/tmp/"];

/** A path below a temp root, with a real name and no `..`: DCG's only safe target. */
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
    if (value.temp && !value.glob) return !value.prefix || (tmp !== null && within(value.prefix, tmp));
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

export const SYSTEM_ROOTS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/root",
  "/boot",
  "/lib",
  "/lib64",
  "/var",
  "/sys",
  "/proc",
  "/dev",
  "/opt",
  "/System",
  "/Library",
];

const SYSTEM = new Set([
  ...SYSTEM_ROOTS.map((root) => root.slice(1).toLowerCase()),
  "applications",
  "volumes",
  "private",
  "program files",
  "program files (x86)",
  "programdata",
  "windows",
  "cores",
  "lib32",
  "libx32",
  "media",
  "mnt",
  "nix",
  "snap",
  "srv",
]);

const EXPANSION = /[$`*?[{~\\]/;

/** How bad losing a path is, by DCG's rm rule: critical for a system folder at any depth, a home and its dotfiles. */
export function lossOf(value: Value, known: Known, project: string | null): "critical" | "high" {
  const text = value.text ?? value.prefix;
  const unknownTail = value.text === null;
  if (text.startsWith("~")) {
    const slash = text.indexOf("/");
    if (slash < 0) return "critical";
    return deepUnder(text.slice(slash + 1), unknownTail) ? "high" : "critical";
  }
  if (!text.startsWith("/")) {
    if (!known.cwd || unknownTail) return "high";
    const path = posix.join(known.cwd, text);
    // in the seat's project a relative target is ordinary; outside it the real place counts
    if (project && within(path, project)) return "high";
    return lossOfAbsolute(path, false, known.place.home);
  }
  return lossOfAbsolute(text, unknownTail, known.place.home);
}

/** `lossOf` for an absolute path. */
function lossOfAbsolute(path: string, unknownTail: boolean, home: string): "critical" | "high" {
  const parts = path.split("/").filter((c) => c && c !== ".");
  if (parts.some((c) => c === ".." || EXPANSION.test(c))) return "critical";
  if (/^[a-z]$/i.test(parts[0] ?? "")) parts.shift();
  if (parts.length <= 1) return "critical";
  if (SYSTEM.has(parts[0].toLowerCase())) return "critical";
  const homeRoot = home.split("/").filter(Boolean);
  if (parts[0] === "home" || parts[0] === "Users" || (homeRoot.length && parts[0] === homeRoot[0])) {
    const rest = parts.slice(2);
    if (rest.length < 2 || rest[0].startsWith(".")) return "critical";
    return unknownTail && rest.length < 2 ? "critical" : "high";
  }
  return "high";
}

/** Two static names or more below a home, the first not a dotfile: DCG's "deep under home". */
function deepUnder(rest: string, unknownTail: boolean): boolean {
  const parts = rest.split("/").filter((c) => c && c !== ".");
  if (parts.some((c) => c === ".." || EXPANSION.test(c))) return false;
  if (unknownTail && parts.length < 2) return false;
  return parts.length >= 2 && !parts[0].startsWith(".");
}

const SENSITIVE = [...SYSTEM_ROOTS, "/home", "/Users", "/Applications", "/Volumes", "/private/etc", "/private/var"];

/** DCG's sensitive set for its file rules: `/`, the system's root folders, any home, and `~`. */
export function sensitive(value: Value, known: Known, resolveRelative: boolean): boolean {
  let text = value.text ?? value.prefix;
  if (!text) return false;
  if (text.startsWith("~")) return true;
  if (!text.startsWith("/")) {
    if (!resolveRelative || !known.cwd || value.text === null) return false;
    text = posix.join(known.cwd, text);
  }
  const path = posix.normalize(text);
  if (path === "/" || path === "//") return true;
  if (within(path, known.place.home)) return true;
  if (tempPath(path)) return path.startsWith("/var/") || path.startsWith("/private/var/");
  return SENSITIVE.some((root) => within(path, root));
}
