import { languageOf, scanEmbedded, type Language } from "./embedded";
import { baseName, programNames, invocationOf } from "./normalize";
import { absolute, isTemp, lossOf, valueOf } from "./paths";
import { paseoCommand, startsPaseo } from "./rules/paseo";
import { guardOf } from "./rules/protected";
import type { Part, Pipeline, Word } from "./shell";
import { fork, type Reader, type State } from "./state";
import type { Known, Scene } from "./types";

/** Reading what a shell or an interpreter runs when its program is text the room can see. */

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "ash", "yash"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c"]);

/** A word that a program runs as a shell line. */
export async function shellWord(rd: Reader, word: Word, state: State, depth: number, scene: Scene): Promise<void> {
  const value = valueOf(word, rd.known(state));
  if (value.text !== null) return rd.text(value.text, fork(state), depth);
  if (downloads(word.parts)) rd.out.add("room.software", "download-and-run", scene.text);
  else rd.out.doubt("a shell runs a line known only at run time", scene.text);
}

/** A script file run by a shell or interpreter: the Paseo CLI's own, or written earlier in the line, or changed since the last commit; `inShell` when it runs in the line's own shell. */
export async function scriptFile(
  rd: Reader,
  word: Word,
  language: Language | "shell" | null,
  state: State,
  depth: number,
  scene: Scene,
  inShell = false,
): Promise<void> {
  if (word.parts.some((p) => p.kind === "process")) {
    if (downloads(word.parts)) rd.out.add("room.software", "download-and-run", scene.text);
    else rd.out.doubt("a shell runs the output of a command", scene.text);
    return;
  }
  const value = valueOf(word, rd.known(state));
  const path = absolute(value, state.cwd);
  if (startsPaseo(value.text, path, (target) => rd.real(target))) {
    const { command, args } = scene.call;
    const used = paseoCommand(command === word ? args : args.slice(args.indexOf(word) + 1));
    if (used !== null) rd.out.add("room.guard", "paseo-cli", scene.text, used);
    return;
  }
  if (!path) return;
  const text = state.written.get(path) ?? (await rd.changed(path));
  if (text === null) return;
  const lang = language ?? languageOfScript(path, text);
  if (lang === "shell") return rd.text(text, inShell ? state : fork(state), depth);
  if (lang) return program(rd, lang, null, state, depth, scene, text);
}

/** A program read from stdin: a heredoc, a here-string, or what a literal echo pipes in. */
export async function stdinProgram(
  rd: Reader,
  scene: Scene,
  language: Language | "shell",
  state: State,
  depth: number,
): Promise<void> {
  const fed = stdinText(scene, rd.known(state), state.written);
  if (fed === undefined) return;
  if (fed === null) {
    if (scene.stage > 0 && scene.pipeline && pipeDownloads(scene.pipeline, scene.stage))
      rd.out.add("room.software", "download-and-run", scene.text);
    else rd.out.doubt(`${language === "shell" ? "a shell" : language} runs input the room cannot read`, scene.text);
    return;
  }
  if (language === "shell") return rd.text(fed, fork(state), depth);
  return program(rd, language, null, state, depth, scene, fed);
}

/** The text a command reads on stdin; null when it reads something unseen, undefined if none. */
export function stdinText(scene: Scene, known: Known, written: ReadonlyMap<string, string>): string | null | undefined {
  for (const r of scene.simple.redirects) {
    if (r.heredoc) return r.heredoc.body;
    if (r.op === "<<<" && r.target) return valueOf(r.target, known).text;
    if (r.op === "<" && r.target) {
      const path = absolute(valueOf(r.target, known), known.cwd);
      return path ? (written.get(path) ?? null) : null;
    }
  }
  if (scene.stage === 0 || !scene.pipeline) return undefined;
  const producer = scene.pipeline.commands[scene.stage - 1];
  if (producer.kind !== "simple") return null;
  const call = invocationOf(producer);
  const words = call.args.map((w) => valueOf(w, known).text);
  if ((call.name === "echo" || call.name === "printf") && words.every((w) => w !== null))
    return (words as string[]).filter((w, i) => !(call.name === "echo" && i === 0 && /^-[neE]+$/.test(w))).join(" ");
  if (call.name === "cat" && !call.args.length) {
    const doc = producer.redirects.find((r) => r.heredoc)?.heredoc;
    if (doc) return doc.body;
    const here = producer.redirects.find((r) => r.op === "<<<");
    if (here?.target) return valueOf(here.target, known).text;
  }
  return null;
}

/** A program in an interpreter's language: its shell lines, deletes and writes, judged. */
export async function program(
  rd: Reader,
  language: Language,
  code: Word | null,
  state: State,
  depth: number,
  scene: Scene,
  text?: string,
): Promise<void> {
  const known = rd.known(state);
  const source = text ?? (code ? valueOf(code, known).text : null);
  if (source === null || source === undefined) return;
  const found = scanEmbedded(language, source);
  for (const line of found.shell) await rd.text(line, fork(state), depth);
  for (const del of found.deletes) {
    const value = valueOf(literalWord(del.path), known);
    const how = `${language} ${del.how} ${del.path}`;
    if (del.recursive) {
      if (isTemp(value, known)) continue;
      const severe = lossOf(value, known, known.place.project) === "critical";
      rd.out.add("core.filesystem", severe ? "rm-rf-root-home" : "rm-rf-general", scene.text, how);
    } else if (guardOf(value, "remove", known)) rd.out.add("core.filesystem", "rm-protected-file", scene.text, how);
  }
  for (const write of found.writes) {
    const guard = guardOf(valueOf(literalWord(write.path), known), write.append ? "append" : "write", known);
    if (guard) rd.out.add(guard.pack, guard.rule, scene.text, `${language} ${write.how} ${write.path}`);
  }
  if (found.dynamicExec.length)
    rd.out.add("core.filesystem", "interpreter-runs-dynamic-shell", scene.text, `${language} ${found.dynamicExec[0]}`);
}

const literalWord = (path: string): Word => ({
  raw: path,
  start: 0,
  end: 0,
  parts: [{ kind: "text", text: path, quote: "single" }],
});

/** True when a stage before `stage` of the pipeline downloads something. */
function pipeDownloads(pipeline: Pipeline, stage: number): boolean {
  return pipeline.commands
    .slice(0, stage)
    .some((c) => c.kind === "simple" && DOWNLOADERS.has(invocationOf(c).name ?? ""));
}

/** True when a command or process substitution in the word parts runs a downloader. */
function downloads(parts: readonly Part[]): boolean {
  return parts.some(
    (p) => (p.kind === "command" || p.kind === "process") && programNames(p.script).some((n) => DOWNLOADERS.has(n)),
  );
}

/** The language of a script by its first line, then its name; a bare file is shell, an unknown shebang nothing. */
function languageOfScript(path: string, text: string): Language | "shell" | null {
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
  const interpreter = shebang ? baseName(shebang[1] === "/usr/bin/env" ? (shebang[2] ?? "") : shebang[1]) : "";
  if (SHELLS.has(interpreter) || /\.(sh|bash|zsh)$/.test(path)) return "shell";
  const byName = languageOf(interpreter);
  if (byName) return byName;
  if (/\.py$/.test(path)) return "python";
  if (/\.(m?js|cjs|ts|mts)$/.test(path)) return "javascript";
  if (/\.rb$/.test(path)) return "ruby";
  if (/\.pl$/.test(path)) return "perl";
  if (/\.php$/.test(path)) return "php";
  return shebang ? null : "shell";
}
