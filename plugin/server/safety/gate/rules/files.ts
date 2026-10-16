import { posix } from "node:path";
import { valueWord } from "../normalize";
import { absolute, isTemp, sensitive, SYSTEM_ROOTS, tempPath, valueOf, within } from "../paths";
import { literal, type Redirect, type Word } from "../shell";
import type { Scene, Value } from "../types";
import { guardOf, guardOfPath, type Guarded, type WriteMode } from "./protected";

/** DCG's core.filesystem rules besides rm, and every write to a protected file. */

interface FileHit {
  pack: string;
  rule: string;
  detail: string;
}

/** What the file rules ask of the disk: whether a path exists (lstat), is a symlink, is a folder, and where it really leads. */
export interface FileTools {
  stat(path: string): { exists: boolean; link: boolean; dir: boolean };
  real(path: string): string | null;
}

const PSEUDO_DEVICES = new Set(["/dev/null", "/dev/zero", "/dev/full", "/dev/tty"]);
const NET_DEVICE = /^\/dev\/(tcp|udp)\/[^/.][^/]*\/\d+$/;

const opts = (scene: Scene) => scene.call.args.map(literal);
const operands = (words: Word[]) => words.filter((w) => !(literal(w) ?? "x").startsWith("-") || literal(w) === "-");
const help = (texts: (string | null)[]) => texts.some((t) => t === "--help" || t === "--version");

/** The non-rm rules of core.filesystem for one command. */
export function fileRules(scene: Scene, tools: FileTools): FileHit[] {
  const hits: FileHit[] = [];
  const hit = (rule: string, detail: string) => hits.push({ pack: "core.filesystem", rule, detail });
  const name = scene.call.name;
  const texts = opts(scene);
  const values = scene.call.args.map((w) => valueOf(w, scene));
  const inS = (v: Value) => sensitive(v, scene, scene.moved);
  switch (name) {
    case "find": {
      const deletes = texts.includes("-delete");
      const execRm = findsExecRm(scene.call.args);
      if (!deletes && !execRm) break;
      const starts = startingPoints(scene.call.args).map((w) => valueOf(w, scene));
      if (
        starts.length &&
        starts.every((v) => v.text !== null && tempPath(v.text)) &&
        !values.some((v) => v.text !== null && inS(v) && !tempPath(v.text))
      )
        break;
      if (values.some(inS)) hit("find-delete-root-home", scene.text);
      else hit("find-delete-general", scene.text);
      break;
    }
    case "unlink": {
      if (help(texts)) break;
      const targets = values.filter((v) => !(v.text ?? "").startsWith("-"));
      if (targets.every((v) => isTemp(v, scene))) break;
      hit(targets.some(inS) ? "unlink-root-home" : "unlink-general", scene.text);
      break;
    }
    case "truncate": {
      if (help(texts)) break;
      const size = sizeOf(texts);
      if (size === null || size.startsWith("+")) break;
      const files = fileOperandsOfTruncate(scene.call.args).map((w) => valueOf(w, scene));
      if (!files.length || files.every((v) => isTemp(v, scene))) break;
      hit(files.some(inS) ? "truncate-zero-root-home" : "truncate-zero-general", scene.text);
      break;
    }
    case "shred": {
      if (help(texts)) break;
      const files = operands(scene.call.args).map((w) => valueOf(w, scene));
      if (!files.length || files.every((v) => isTemp(v, scene))) break;
      hit(files.some(inS) ? "shred-root-home" : "shred-general", scene.text);
      break;
    }
    case "tar":
    case "bsdtar":
    case "gtar": {
      if (!texts.includes("--remove-files")) break;
      const files = operands(scene.call.args).map((w) => valueOf(w, scene));
      if (files.length && files.every((v) => isTemp(v, scene))) break;
      hit(values.some(inS) ? "tar-remove-files-root-home" : "tar-remove-files-general", scene.text);
      break;
    }
    case "dd":
    case "gdd": {
      if (help(texts)) break;
      for (const word of scene.call.args) {
        const text = literal(word);
        if (!(text ?? word.raw).startsWith("of=")) continue;
        const target = valueOf(valueWord(word, 3), scene);
        if ((target.text ?? target.prefix).startsWith("/dev/")) continue;
        if (isTemp(target, scene)) continue;
        hit(inS(target) ? "dd-overwrite-root-home" : "dd-overwrite-general", scene.text);
      }
      break;
    }
    case "mv":
    case "gmv": {
      if (help(texts)) break;
      const files = operands(scene.call.args).map((w) => valueOf(w, scene));
      if (files.some((v) => v.text === null)) {
        hit("mv-dynamic-path", scene.text);
        break;
      }
      if (!files.some(inS) || mvSafe(files, scene)) break;
      hit("mv-sensitive-source-root-home", scene.text);
      break;
    }
    case "rsync": {
      const del = texts.some(
        (t) => t !== null && /^--del(e(t(e(-(after|before|during|delay|excluded))?)?)?)?$/.test(t),
      );
      const dry = texts.some((t) => t === "--dry-run" || (t !== null && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t)));
      if (!del || dry) break;
      const dest = operands(scene.call.args)
        .map((w) => valueOf(w, scene))
        .pop();
      if (dest && rsyncRootDest(dest, scene)) hit("rsync-delete-sensitive-dest", scene.text);
      break;
    }
  }
  for (const redirect of scene.simple.redirects) {
    const rule = redirectRule(redirect, scene, tools);
    if (rule) hit(rule, `${redirect.op} ${redirect.target?.raw ?? ""}`);
  }
  return hits;
}

/** True when a `find` runs `rm` on its matches. */
function findsExecRm(args: Word[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const text = literal(args[i]);
    if (text !== "-exec" && text !== "-execdir" && text !== "-ok" && text !== "-okdir") continue;
    const program = literal(args[i + 1] ?? args[i]);
    const tail = args.slice(i + 2).map(literal);
    if (program && /(^|\/)rm$/.test(program) && tail.includes("{}")) return true;
  }
  return false;
}

/** find's starting points: the words before its first expression. */
function startingPoints(args: Word[]): Word[] {
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
function fileOperandsOfTruncate(args: Word[]): Word[] {
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

const TRASH = [".Trash", ".local/share/Trash"];

/** The mv shapes DCG lets through: within temp, into the trash, and moves deep inside a home. */
function mvSafe(files: Value[], scene: Scene): boolean {
  if (files.every((v) => v.text !== null && tempPath(v.text))) return true;
  const paths = files.map((v) => v.text!);
  const dest = paths[paths.length - 1];
  const sources = paths.slice(0, -1);
  const home = scene.place.home;
  const rel = (p: string) => (within(p, home) ? p.slice(home.length + 1) : null);
  const homeRoot = (p: string) => p === home || /^\/(Users|home)\/[^/]+\/?$/.test(p);
  if (
    TRASH.some((t) => within(dest, posix.join(home, t))) &&
    sources.every((s) => !homeRoot(s) && (within(s, home) || tempPath(s) || !s.startsWith("/")))
  )
    return true;
  const deep = (p: string, min: number) => {
    const r = rel(p);
    if (r === null) return false;
    const parts = r.split("/").filter(Boolean);
    return parts.length >= min && !parts[0].startsWith(".") && !parts.includes("..");
  };
  if (scene.call.args.some((w) => ["-t", "--target-directory"].includes(literal(w) ?? ""))) return false;
  if (sources.every((s) => deep(s, 2)) && deep(dest, 1)) return true;
  return (
    sources.every((s) => !s.startsWith("/") && !s.startsWith("-") && !(s.startsWith(".") && !s.startsWith("./"))) &&
    deep(dest, 1)
  );
}

/** True when the destination of an `rsync --delete` is `/`, a home or a system folder; a remote one is not. */
function rsyncRootDest(dest: Value, scene: Scene): boolean {
  const text = dest.text;
  if (text === null || /^[^/]*:/.test(text)) return false;
  const path = posix.normalize(text.startsWith("/") ? text : scene.cwd ? posix.join(scene.cwd, text) : text);
  if (path === "/" || path === scene.place.home || /^\/(home|Users)(\/[^/]+)?\/?$/.test(path)) return true;
  return SYSTEM_ROOTS.some((r) => within(path, r));
}

const READING = new Set<string>(["<", "<<<", "<&", "<>"]);

/** Whether a redirect has a target the command writes to, not one it reads from. */
const putsInFile = (redirect: Redirect): redirect is Redirect & { target: Word } =>
  !!redirect.target && !redirect.heredoc && !READING.has(redirect.op);

/** DCG's redirect rules: truncating the system or a home, git internals, run-time targets. */
function redirectRule(redirect: Redirect, scene: Scene, tools: FileTools): string | null {
  if (!putsInFile(redirect)) return null;
  const target = valueOf(redirect.target, scene);
  if (redirect.op === ">&" && /^(\d+|-)$/.test(target.text ?? "")) return null;
  const append = redirect.op === ">>" || redirect.op === "&>>";
  const text = target.text;
  const parts = (text ?? target.prefix).split("/");
  if (parts.includes(".git") && !(text ?? "").startsWith("/"))
    return append ? "redirect-append-git-internals-relative" : "redirect-truncate-git-internals-relative";
  if (append) return null;
  if (text === null || target.glob || (text.startsWith("~") && text !== "~" && !text.startsWith("~/"))) {
    if (isTemp(target, scene)) return null;
    return "redirect-truncate-dynamic-path";
  }
  if (PSEUDO_DEVICES.has(text) || NET_DEVICE.test(text) || isTemp(target, scene)) return null;
  if (!sensitive(target, scene, scene.moved)) return null;
  const path = absolute(target, scene.cwd);
  if (path && within(path, scene.place.home) && newFileUnderHome(path, tools)) return null;
  return "redirect-truncate-root-home";
}

/** A new literal path under home in an existing folder: creating it destroys nothing. */
function newFileUnderHome(path: string, tools: FileTools): boolean {
  if (path.split("/").includes(".git")) return false;
  const file = tools.stat(path);
  if (file.exists || file.link) return false;
  const parent = tools.stat(posix.dirname(path));
  return parent.exists && parent.dir && !parent.link;
}

/** Every file a command writes, with how: redirects, tee, cp, mv, dd, sed -i, downloads. */
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
      // a link to a protected place lets a later write through it in
      if (name === "ln") for (const source of sources) add(source, "write", "ln");
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

/** The protected place a path really leads to, when a link on the way takes it there from a place that is not protected. */
export function guardThroughLinks(
  path: string,
  mode: WriteMode,
  scene: Pick<Scene, "place">,
  real: (path: string) => string | null,
): Guarded | null {
  const tail: string[] = [];
  let from = path;
  for (let step = 0; step < 64; step += 1) {
    const target = real(from);
    if (target !== null) {
      const resolved = posix.join(target, ...tail.reverse());
      return resolved === path ? null : guardOfPath(resolved, mode, scene);
    }
    const parent = posix.dirname(from);
    if (parent === from) return null;
    tail.push(posix.basename(from));
    from = parent;
  }
  return null;
}

/** The protected files a command writes into, directly or through a link. */
export function guardedWrites(scene: Scene, real: (path: string) => string | null): { found: Guarded; how: string }[] {
  const out: { found: Guarded; how: string }[] = [];
  for (const write of writesOf(scene)) {
    const path = absolute(write.value, scene.cwd);
    const found = guardOf(write.value, write.mode, scene) ?? (path && guardThroughLinks(path, write.mode, scene, real));
    if (found && !(found.pack === "core.filesystem" && write.mode === "remove")) out.push({ found, how: write.how });
  }
  if (["chmod", "chown", "chgrp", "chflags", "xattr", "rm", "unlink", "rmdir", "touch"].includes(scene.call.name ?? ""))
    for (const word of operands(scene.call.args)) {
      const found = guardOf(valueOf(word, scene), "write", scene);
      if (found?.pack === "room.guard") out.push({ found, how: scene.call.name! });
    }
  return out;
}

/** `:(){ :|:& };:` and renamed forms: a function that pipes itself into itself. */
export function forkBomb(name: string, body: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s;{])${escaped}\\s*\\|\\s*${escaped}\\s*&`).test(body);
}
