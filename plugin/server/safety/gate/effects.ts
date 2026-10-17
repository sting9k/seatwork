import { posix } from "node:path";
import { valueWord } from "./normalize";
import { type FileRow, type Findings, worse } from "./findings";
import { absolute, valueOf, within } from "./paths";
import { namesAll, throughLinks, whereOf, whereOfPath } from "./places";
import { literal, textWord, type Redirect, type Word } from "./shell";
import type { Scene, Value } from "./types";

/** What a command does to files: what it deletes, writes over, adds to, reads, and whose modes it changes, graded by where each lands. */

/** What the file effects ask of the disk: whether a path exists (lstat), is a symlink, is a folder; where it really leads; which paths git leaves out of the project. */
export interface FileTools {
  stat(path: string): { exists: boolean; link: boolean; dir: boolean };
  real(path: string): string | null;
  ignored(paths: string[]): Promise<ReadonlySet<string>>;
}

/** How a command writes a file; `link` is a link made to it, which lets a later write through the link in. */
type WriteMode = "write" | "append" | "remove" | "link";

/** One thing a command does to a path; `tree` when it takes a folder with what it holds, `inside` when it takes only some of what a folder holds, `link` when it only opens a way in. */
interface Touch {
  row: "delete" | "overwrite" | "append" | "mode" | "read";
  value: Value;
  tree: boolean;
  inside?: boolean;
  link?: boolean;
  how: string;
}

const READING = new Set<string>(["<", "<<<", "<&", "<>"]);
const TRASH = [".Trash", ".local/share/Trash"];
const READERS = new Set([
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "nl",
  "base64",
  "xxd",
  "od",
  "hexdump",
  "strings",
  "cut",
  "sort",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "awk",
  "sed",
  "jq",
  "yq",
  "cp",
  "scp",
  "rsync",
  "ditto",
  "tar",
  "zip",
  "7z",
  "gzip",
  "openssl",
  "gpg",
]);
const COPIES = new Set(["cp", "scp", "rsync", "ditto"]);
const MODES = new Set(["chmod", "chown", "chgrp", "chflags"]);

const operands = (words: Word[]) => words.filter((w) => !(literal(w) ?? "x").startsWith("-") || literal(w) === "-");
const recursive = (texts: (string | null)[]) =>
  texts.some((t) => t !== null && (t === "--recursive" || /^-[a-zA-Z]*[rR]/.test(t)));

/** Whether a redirect has a target the command writes to, not one it reads from. */
const putsInFile = (redirect: Redirect): redirect is Redirect & { target: Word } =>
  !!redirect.target && !redirect.heredoc && !READING.has(redirect.op);

/** Every file a command writes, with how: redirects, tee, cp, mv, dd, sed -i, downloads; an mv's sources as removed. */
export function writesOf(scene: Scene): { value: Value; mode: WriteMode; how: string }[] {
  const out: { value: Value; mode: WriteMode; how: string }[] = [];
  const add = (word: Word, mode: WriteMode, how: string) => out.push({ value: valueOf(word, scene), mode, how });
  for (const r of scene.simple.redirects) {
    if (!putsInFile(r)) continue;
    if (r.op === ">&" && /^(\d+|-)$/.test(literal(r.target) ?? "")) continue;
    add(r.target, r.op === ">>" || r.op === "&>>" ? "append" : "write", r.op);
  }
  const args = scene.call.args;
  const texts = args.map(literal);
  const name = (scene.call.name ?? "").replace(/^g(?=(tee|cp|mv|ln|install|dd|sed)$)/, "");
  switch (name) {
    case "tee":
    case "sponge": {
      const appendMode = texts.some((t) => t === "--append" || (t !== null && /^-[a-z]*a/.test(t)));
      for (const w of operands(args)) if (literal(w) !== "-") add(w, appendMode ? "append" : "write", name);
      break;
    }
    case "cp":
    case "mv":
    case "install":
    case "ln": {
      if (name === "install" && texts.some((t) => t === "-d" || t === "--directory")) break;
      const files = operands(args);
      const targetFlag = texts.findIndex(
        (t) => t === "-t" || t === "--target-directory" || (t ?? "").startsWith("--target-directory="),
      );
      let dest: Word | null;
      let sources: Word[];
      if (targetFlag >= 0) {
        const t = texts[targetFlag]!;
        dest = t.includes("=") ? valueWord(args[targetFlag], t.indexOf("=") + 1) : (args[targetFlag + 1] ?? null);
        sources = files.filter((w) => w !== dest);
      } else {
        dest = files[files.length - 1] ?? null;
        sources = files.slice(0, -1);
      }
      if (!dest || (!sources.length && name !== "ln")) break;
      add(dest, "write", name);
      const destValue = valueOf(dest, scene);
      if (destValue.text !== null)
        for (const source of sources) {
          const base = literal(source);
          if (base === null) continue;
          const joined = posix.join(destValue.text, posix.basename(base));
          out.push({ value: { ...destValue, text: joined, prefix: joined }, mode: "write", how: name });
        }
      if (name === "mv") for (const source of sources) add(source, "remove", "mv");
      if (name === "ln") for (const source of sources) add(source, "link", "ln");
      break;
    }
    case "dd":
      for (const w of args) {
        const t = literal(w) ?? w.raw;
        if (t.startsWith("of="))
          add(
            valueWord(w, 3),
            texts.some((x) => (x ?? "").startsWith("oflag=") && (x ?? "").includes("append")) ? "append" : "write",
            "dd",
          );
      }
      break;
    case "sed":
    case "perl": {
      const inPlace = texts.some(
        (t) => t !== null && (t === "--in-place" || t.startsWith("--in-place=") || /^-[a-zA-Z]*[iI]/.test(t)),
      );
      if (!inPlace) break;
      let scriptSeen = false;
      for (let i = 0; i < args.length; i += 1) {
        const t = texts[i];
        if (t === "-e" || t === "-f" || t === "--expression" || t === "--file" || t === "-l") {
          scriptSeen = true;
          i += 1;
          continue;
        }
        if (t !== null && t.startsWith("-")) {
          if (/^-[a-zA-Z]*e$/.test(t)) {
            scriptSeen = true;
            i += 1;
          }
          continue;
        }
        if (!scriptSeen) {
          scriptSeen = true;
          continue;
        }
        add(args[i], "write", `${name} -i`);
      }
      break;
    }
    case "curl":
      for (let i = 0; i < args.length; i += 1) {
        const t = texts[i];
        if ((t === "-o" || t === "--output") && args[i + 1]) add(args[i + 1], "write", "curl -o");
        else if (t?.startsWith("--output=")) add(valueWord(args[i], 9), "write", "curl -o");
      }
      break;
    case "wget":
      for (let i = 0; i < args.length; i += 1) {
        const t = texts[i];
        if ((t === "-O" || t === "--output-document") && args[i + 1]) add(args[i + 1], "write", "wget -O");
        else if (t?.startsWith("--output-document=")) add(valueWord(args[i], 18), "write", "wget -O");
      }
      break;
    case "rsync": {
      const files = operands(args);
      const dest = files[files.length - 1];
      if (dest && files.length > 1 && !/^[^/]*:/.test(literal(dest) ?? "")) add(dest, "write", "rsync");
      break;
    }
    case "tar":
    case "bsdtar":
    case "unzip":
    case "7z":
    case "7za":
    case "7zr":
      for (let i = 0; i < args.length; i += 1) {
        const t = texts[i];
        if (t === null) continue;
        if ((t === "-C" || t === "--directory" || t === "-d") && args[i + 1] && (name !== "unzip" || t === "-d"))
          add(args[i + 1], "write", `${name} extract`);
        else if (t.startsWith("--directory=")) add(valueWord(args[i], 12), "write", `${name} extract`);
        else if (/^-o./.test(t) && name.startsWith("7z")) add(valueWord(args[i], 2), "write", `${name} extract`);
      }
      break;
  }
  return out;
}

/** Everything a command does to paths: its writes, and what it deletes, empties, reads or changes the modes of. */
function touchesOf(scene: Scene): Touch[] {
  const out: Touch[] = [];
  const name = (scene.call.name ?? "").replace(/^g(?=(rm|mv|tar|shred|truncate)$)/, "");
  const args = scene.call.args;
  const texts = args.map(literal);
  const writes = writesOf(scene);
  const trashed =
    name === "mv" && writes.some((w) => w.how === "mv" && w.mode === "write" && intoTrash(w.value, scene));
  for (const w of writes) {
    if (w.mode === "remove" && trashed) continue;
    const row = w.mode === "remove" ? "delete" : w.mode === "append" ? "append" : "overwrite";
    out.push({ row, value: w.value, tree: false, link: w.mode === "link", how: w.how });
  }
  const each = (words: Word[], row: Touch["row"], tree: boolean, inside = false) => {
    for (const word of words) out.push({ row, value: valueOf(word, scene), tree, inside, how: name });
  };
  if (texts.some((t) => t === "--help" || t === "--version")) return out;
  switch (name) {
    case "rm":
    case "rimraf":
      each(rmOperands(args), "delete", name === "rimraf" || recursive(texts));
      break;
    case "unlink":
      each(operands(args), "delete", false);
      break;
    case "shred":
      each(
        operands(args),
        texts.some((t) => t === "-u" || t === "--remove" || /^-[a-z]*u/.test(t ?? "")) ? "delete" : "overwrite",
        false,
      );
      break;
    case "truncate": {
      const size = sizeOf(texts);
      if (size !== null && !size.startsWith("+")) each(truncated(args), "overwrite", false);
      break;
    }
    case "find":
      if (texts.includes("-delete")) {
        const starts = startingPoints(args);
        each(starts.length ? starts : [textWord(".")], "delete", true, true);
      }
      break;
    case "rsync": {
      const deletes = texts.some((t) => t !== null && /^--del(ete(-\w+)?)?$/.test(t));
      const dry = texts.some((t) => t === "--dry-run" || (t !== null && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t)));
      const dest = operands(args).pop();
      if (deletes && !dry && dest && !/^[^/]*:/.test(literal(dest) ?? "")) each([dest], "delete", true, true);
      break;
    }
    case "tar":
    case "bsdtar":
      if (texts.includes("--remove-files")) each(operands(args), "delete", true);
      break;
  }
  if (MODES.has(name)) {
    const given = operands(args);
    each(texts.some((t) => (t ?? "").startsWith("--reference")) ? given : given.slice(1), "mode", recursive(texts));
  }
  if (READERS.has(name)) each(COPIES.has(name) ? operands(args).slice(0, -1) : operands(args), "read", false);
  for (const r of scene.simple.redirects)
    if ((r.op === "<" || r.op === "<>") && r.target)
      out.push({ row: "read", value: valueOf(r.target, scene), tree: false, how: r.op });
  return out;
}

/** rm's operands: every word that is not an option, and every word after `--`. */
function rmOperands(args: Word[]): Word[] {
  const end = args.findIndex((w) => literal(w) === "--");
  const before = end < 0 ? args : args.slice(0, end);
  return [...operands(before).filter((w) => literal(w) !== "-"), ...(end < 0 ? [] : args.slice(end + 1))];
}

/** Whether an mv moves into the owner's Trash, where what it moves can be taken back. */
function intoTrash(dest: Value, scene: Scene): boolean {
  const path = absolute(dest, scene.cwd);
  return path !== null && TRASH.some((folder) => within(path, posix.join(scene.place.home, folder)));
}

/** find's starting points: the words before its first expression. */
export function startingPoints(args: Word[]): Word[] {
  const out: Word[] = [];
  for (const word of args) {
    const text = literal(word);
    if (text !== null && (text.startsWith("-") || text === "(" || text === "!")) {
      if (["-H", "-L", "-P"].includes(text) || /^-O\d$/.test(text)) continue;
      break;
    }
    out.push(word);
  }
  return out;
}

/** The size `truncate` is given, null when there is none or a reference file gives it. */
function sizeOf(texts: (string | null)[]): string | null {
  for (let i = 0; i < texts.length; i += 1) {
    const t = texts[i];
    if (t === null) continue;
    if (t === "-r" || t.startsWith("--reference")) return null;
    if (t.startsWith("--size=")) return t.slice(7);
    if (t === "--size" || t === "-s") return texts[i + 1] ?? null;
    const cluster = /^-[co]*s(.*)$/.exec(t);
    if (cluster) return cluster[1] || (texts[i + 1] ?? null);
  }
  return null;
}

/** The files `truncate` acts on: its operands without the size and reference options. */
function truncated(args: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = literal(args[i]);
    if (t === "-s" || t === "--size" || t === "-r" || t === "--reference" || (t !== null && /^-[co]*s$/.test(t))) {
      i += 1;
      continue;
    }
    if (t !== null && t.startsWith("-")) continue;
    out.push(args[i]);
  }
  return out;
}

/** The row of the file table a touch falls in. */
function rowOf(touch: Touch): FileRow {
  const tree = touch.tree || namesAll(touch.value);
  if (touch.row === "delete") return tree ? "delete-tree" : "delete";
  if (touch.row === "mode") return tree ? "mode-tree" : "mode";
  return touch.row;
}

/** Keeps what a command does to files where the table grades it: a write or a read follows a link to where it leads, a delete, an mv or an ln acts on the link; a repository's folder or a .git removed whole is its history; a folder of the seat's tree that git ignores is built again, and is not kept. */
export async function judgeFiles(scene: Scene, tools: FileTools, out: Findings): Promise<void> {
  const inSeat: { path: string; detail: string }[] = [];
  for (const touch of touchesOf(scene)) {
    const row = rowOf(touch);
    let where = whereOf(touch.value, scene);
    const path = absolute(touch.value, scene.cwd);
    const spelled = touch.value.text ?? `${touch.value.prefix}…`;
    if (path && !touch.value.glob && touch.row !== "delete" && touch.how !== "ln" && touch.how !== "mv") {
      const real = throughLinks(path, (at) => tools.real(at));
      if (real) where = worse(row, where, whereOfPath(real, scene.place));
    }
    if (row === "read" && where !== "credentials") continue;
    if (touch.link && where !== "room" && where !== "startup" && where !== "credentials") continue;
    if (touch.row === "delete" && !touch.inside && path)
      if (where === "seat" && [scene.place.project, scene.place.start].includes(path)) where = "git";
      else if (where === "startup" && posix.basename(path).toLowerCase() === ".git") where = "git";
    if (row === "overwrite" && where === "outside" && path) {
      const file = tools.stat(path);
      if (!file.exists || file.dir) continue;
    }
    if (row === "delete-tree" && where === "seat" && path && !touch.value.glob) {
      inSeat.push({ path, detail: `${touch.how} ${spelled}` });
      continue;
    }
    out.effect(row, where, scene.text, `${touch.how} ${spelled}`);
  }
  if (!inSeat.length) return;
  const ignored = await tools.ignored(inSeat.map((one) => one.path));
  for (const one of inSeat) out.effect("delete-tree", ignored.has(one.path) ? "built" : "seat", scene.text, one.detail);
}

/** `:(){ :|:& };:` and renamed forms: a function that pipes itself into itself. */
export function forkBomb(name: string, body: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s;{])${escaped}\\s*\\|\\s*${escaped}\\s*&`).test(body);
}
