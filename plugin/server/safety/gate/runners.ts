import { posix } from "node:path";
import { INLINE_FLAGS, languageOf, type Language } from "./embedded";
import { baseName, programNames, valueWord } from "./normalize";
import { valueOf } from "./paths";
import { program, scriptFile, SHELLS, shellWord, stdinProgram } from "./programs";
import { literal, textWord, type Simple, type Word } from "./shell";
import { dynamicWord, fork, type Context, type Reader, type State } from "./state";
import type { Scene } from "./types";

/** Commands that run other commands: shells, interpreters, eval, xargs, find -exec, ssh, package scripts. */

const INIT_IDIOMS =
  /^(ssh-agent|direnv|pyenv|rbenv|nodenv|goenv|starship|zoxide|brew|fnm|mise|rtx|conda|thefuck|keychain|gpg-agent|opam|luarocks|jenv|atuin|fzf)$/;

const XARGS_VALUED = new Set([
  "-I",
  "-i",
  "-L",
  "-l",
  "-n",
  "-P",
  "-s",
  "-E",
  "-e",
  "-d",
  "-a",
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--replace",
  "--eof",
  "--max-lines",
]);

/** Reads what a command runs, by the command it is: the command word decides how its arguments are read. */
export async function runners(rd: Reader, scene: Scene, state: State, ctx: Context): Promise<void> {
  const name = scene.call.name ?? "";
  const args = scene.call.args;
  const texts = args.map(literal);
  const nested = ctx.depth + 1;
  for (const inline of scene.call.inline) await shellWord(rd, inline, state, nested, scene);
  if (SHELLS.has(name)) return shell(rd, scene, state, nested);
  const language = languageOf(name);
  if (language) return interpreter(rd, language, scene, state, nested);
  switch (name) {
    case "eval": {
      if (texts.every((t) => t !== null)) return rd.text(texts.join(" "), state, nested);
      const sub = args.length === 1 ? args[0].parts.find((p) => p.kind === "command") : undefined;
      const first = sub?.kind === "command" ? programNames(sub.script)[0] : undefined;
      if (first && INIT_IDIOMS.test(first)) return;
      rd.out.doubt("eval runs text known only at run time", scene.text);
      return;
    }
    case "source":
    case ".":
      if (args[0]) return scriptFile(rd, args[0], "shell", state, nested, scene, true);
      return;
    case "trap":
      if (args[0] && !(texts[0] ?? "").startsWith("-")) return shellWord(rd, args[0], state, nested, scene);
      return;
    case "xargs":
      return xargs(rd, scene, state, ctx);
    case "find":
      return findExec(rd, scene, state, ctx);
    case "watch":
    case "parallel":
    case "entr":
    case "hyperfine":
    case "nohup":
      return joined(rd, scene, name, state, nested);
    case "ssh":
      return remote(rd, scene, state, nested);
    case "scp":
    case "sftp":
      return sshLocal(rd, scene, state, nested);
    case "rsync":
      return rsyncShell(rd, scene, state, nested);
    case "awk":
    case "gawk":
    case "mawk":
    case "nawk":
      return awkProgram(rd, scene, state, nested);
    case "su":
    case "sg":
    case "runuser":
    case "nix-shell":
    case "flock":
    case "script": {
      const flag = name === "nix-shell" ? ["--run", "--command"] : ["-c", "--command"];
      const at = texts.findIndex((t) => t !== null && flag.includes(t));
      if (at >= 0 && args[at + 1]) return shellWord(rd, args[at + 1], state, nested, scene);
      if (name === "flock" || name === "script" || name === "sg") {
        const rest = args.slice(name === "script" ? 2 : 1);
        if (rest.length) await rd.text(rest.map((w) => w.raw).join(" "), fork(state), nested);
      }
      return;
    }
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packageScript(rd, scene, state, nested);
  }
  if (scene.call.command && (literal(scene.call.command) ?? "").includes("/"))
    return scriptFile(rd, scene.call.command, null, state, nested, scene);
}

/** A flag of sed or tar that runs a program: sed's `e`, tar's `--to-command` and its kin. */
export async function execFlags(rd: Reader, scene: Scene, state: State, ctx: Context): Promise<void> {
  const name = scene.call.name;
  if (name === "sed" || name === "gsed") await sedExec(rd, scene, state, ctx);
  if (name === "tar" || name === "gtar") await tarExec(rd, scene, state, ctx);
}

/** A shell: the line after `-c`, a script file, or a program read from stdin. */
async function shell(rd: Reader, scene: Scene, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  const texts = args.map(literal);
  const c = texts.findIndex((t) => t !== null && /^-[a-z]*c[a-z]*$/i.test(t) && !t.startsWith("--"));
  if (c >= 0 && args[c + 1]) return shellWord(rd, args[c + 1], state, depth, scene);
  const script = args.find((_, i) => texts[i] === null || !texts[i]!.startsWith("-"));
  if (script) return scriptFile(rd, script, "shell", state, depth, scene);
  return stdinProgram(rd, scene, "shell", state, depth);
}

/** An interpreter: its inline program, a script file, or a program read from stdin; `-m` runs a module, not read. */
async function interpreter(rd: Reader, language: Language, scene: Scene, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  const texts = args.map(literal);
  const flags = INLINE_FLAGS[language];
  const at = texts.findIndex(
    (t) =>
      t !== null && flags.some((f) => t === f || (f.length === 2 && t.startsWith(f) && t.length > 2 && f !== "-e")),
  );
  if (at >= 0) {
    const t = texts[at]!;
    const code = t.length > 2 && !t.startsWith("--") ? valueWord(args[at], 2) : args[at + 1];
    if (code) return program(rd, language, code, state, depth, scene);
  }
  if (texts.includes("-m")) return;
  const known = rd.known(state);
  const operands = language === "javascript" ? args.map((w) => valueOf(w, known).text) : texts;
  const script = scriptOperand(language, scene.call.name, args, operands);
  if (script && literal(script) !== "-") return scriptFile(rd, script, language, state, depth, scene);
  return stdinProgram(rd, scene, language, state, depth);
}

const NODE_VALUED = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--input-type",
]);

/** The script an interpreter runs: its first operand, past the value of an option that takes one and a runtime's `run`. */
function scriptOperand(
  language: Language,
  name: string | null,
  args: Word[],
  texts: (string | null)[],
): Word | undefined {
  if (language !== "javascript") return args.find((_, i) => !(texts[i] ?? "-").startsWith("-"));
  for (let i = 0; i < args.length; i += 1) {
    const text = texts[i];
    if (text === null) continue;
    if (NODE_VALUED.has(text)) i += 1;
    else if (!text.startsWith("-") && !((name === "bun" || name === "deno") && text === "run")) return args[i];
  }
  return undefined;
}

/** xargs runs its command with the input as a last argument, which is unknown here. */
async function xargs(rd: Reader, scene: Scene, state: State, ctx: Context): Promise<void> {
  const args = scene.call.args;
  let i = 0;
  for (; i < args.length; i += 1) {
    const t = literal(args[i]);
    if (t === null || !t.startsWith("-")) break;
    if (t === "--") {
      i += 1;
      break;
    }
    if (XARGS_VALUED.has(t)) i += 1;
  }
  const inner = args.slice(i);
  if (!inner.length) return;
  const ended = inner.some((w) => literal(w) === "--");
  const name = baseName(literal(inner[0]) ?? "");
  const tail = name === "rm" && !ended ? [textWord("-r"), dynamicWord()] : [dynamicWord()];
  await synthetic(rd, [...inner, ...tail], state, ctx);
}

/** The commands after `-exec`, `-execdir`, `-ok` and `-okdir`, each with `{}` unknown. */
async function findExec(rd: Reader, scene: Scene, state: State, ctx: Context): Promise<void> {
  const args = scene.call.args;
  for (let i = 0; i < args.length; i += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(literal(args[i]) ?? "")) continue;
    const inner: Word[] = [];
    let j = i + 1;
    for (; j < args.length; j += 1) {
      const t = literal(args[j]);
      if (t === ";" || t === "+") break;
      inner.push(t === "{}" ? dynamicWord() : args[j]);
    }
    if (inner.length) await synthetic(rd, inner, state, ctx);
    i = j;
  }
}

/** A command built from another's arguments (xargs, find -exec), judged as if written. */
async function synthetic(rd: Reader, words: Word[], state: State, ctx: Context): Promise<void> {
  const simple: Simple = { kind: "simple", assigns: [], words, redirects: [], start: 0, end: 0 };
  const src = words.map((w) => w.raw).join(" ");
  await rd.simple(
    simple,
    { ...state, stdinFed: true },
    { ...ctx, src, pipeline: null, stage: 0, depth: ctx.depth + 1 },
  );
}

/** watch, parallel, entr, hyperfine and nohup: the words after their options are a command line. */
async function joined(rd: Reader, scene: Scene, name: string, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  const texts = args.map(literal);
  if (name === "hyperfine") {
    for (let i = 0; i < args.length; i += 1)
      if (
        !(texts[i] ?? "-").startsWith("-") &&
        !(texts[i - 1] ?? "").match(
          /^-[wrmMpcsuLPS]$|^--(warmup|runs|min-runs|max-runs|prepare|cleanup|setup|parameter-scan|parameter-list|shell|export-\w+)$/,
        )
      )
        await shellWord(rd, args[i], state, depth, scene);
    return;
  }
  if (name === "entr") {
    const s = texts.indexOf("-s");
    if (s >= 0 && args[s + 1]) return shellWord(rd, args[s + 1], state, depth, scene);
  }
  const start = args.findIndex(
    (_, i) => !(texts[i] ?? "-").startsWith("-") && !(name === "watch" && /^-[ndt]$/.test(texts[i - 1] ?? "")),
  );
  if (start < 0) return;
  const end = name === "parallel" ? texts.findIndex((t) => t === ":::" || t === "::::") : -1;
  const words = args.slice(start, end < 0 ? undefined : end);
  if (words.every((w) => literal(w) !== null))
    await rd.text(words.map((w) => literal(w)!).join(" "), fork(state), depth);
  else rd.out.doubt(`${name} runs a line known only at run time`, scene.text);
}

const LOCAL_SSH_OPTION = /^\s*(ProxyCommand|LocalCommand|KnownHostsCommand)\s*(?:=\s*|\s+)(.+)$/is;

/** An ssh `-o` value that names a program run on this machine, read as a line here; one not known until run time is a doubt. */
async function sshOption(
  rd: Reader,
  word: Word | undefined,
  text: string | null,
  state: State,
  depth: number,
  scene: Scene,
): Promise<void> {
  if (text === null) {
    if (/command/i.test(word?.raw ?? "")) rd.out.doubt("ssh runs a local program named only at run time", scene.text);
    return;
  }
  const found = LOCAL_SSH_OPTION.exec(text);
  if (found && found[2].trim().toLowerCase() !== "none") await rd.text(found[2], fork(state), depth);
}

/** scp and sftp: the programs their ssh options and `-S` run on this machine. */
async function sshLocal(rd: Reader, scene: Scene, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  for (let i = 0; i < args.length; i += 1) {
    const t = literal(args[i]);
    if (t === "-o") await sshOption(rd, args[i + 1], args[i + 1] ? literal(args[i + 1]) : null, state, depth, scene);
    else if (t?.startsWith("-o") && t.length > 2) await sshOption(rd, args[i], t.slice(2), state, depth, scene);
    else if (t === "-S" && args[i + 1]) await shellWord(rd, args[i + 1], state, depth, scene);
  }
}

/** rsync: the program `-e` or `--rsh` names runs on this machine, as a line of its own. */
async function rsyncShell(rd: Reader, scene: Scene, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  for (let i = 0; i < args.length; i += 1) {
    const t = literal(args[i]);
    if ((t === "-e" || t === "--rsh") && args[i + 1]) await shellWord(rd, args[i + 1], state, depth, scene);
    else if (t?.startsWith("--rsh=")) await rd.text(t.slice("--rsh=".length), fork(state), depth);
  }
}

const AWK_STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const AWK_SYSTEM = new RegExp(String.raw`\bsystem\s*\(\s*` + AWK_STRING + String.raw`\s*\)`, "g");
const AWK_PIPE_OUT = new RegExp(String.raw`(?<!\|)\|(?!\|)&?\s*` + AWK_STRING, "g");
const AWK_PIPE_IN = new RegExp(AWK_STRING + String.raw`\s*\|&?\s*getline`, "g");
const AWK_BUILT =
  /\bsystem\s*\((?!\s*"(?:[^"\\]|\\.)*"\s*\))|\bprintf?\b[^;{}]*\|&?\s*[A-Za-z_$(]|[A-Za-z_)]\s*\|&?\s*getline/;

/** awk: the shell lines its program runs, by `system`, a pipe out of `print` or a pipe into `getline`; one built at run time is a doubt. */
async function awkProgram(rd: Reader, scene: Scene, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  let program: Word | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const t = literal(args[i]);
    if (t === "-f" || t === "--file") return rd.out.doubt("awk runs a program file the room does not read", scene.text);
    if (t === "-F" || t === "-v" || t === "--assign" || t === "--field-separator") {
      i += 1;
      continue;
    }
    if (t === "-e" || t === "--source") {
      program = args[i + 1];
      break;
    }
    if (t !== null && t.startsWith("-") && t !== "-") continue;
    program = args[i];
    break;
  }
  if (!program) return;
  const text = literal(program);
  if (text === null) {
    if (/system|getline|\|/.test(program.raw)) rd.out.doubt("awk runs a program known only at run time", scene.text);
    return;
  }
  const unescape = (value: string) => value.replace(/\\(.)/g, "$1");
  for (const pattern of [AWK_SYSTEM, AWK_PIPE_OUT, AWK_PIPE_IN])
    for (const [, line] of text.matchAll(pattern)) await rd.text(unescape(line), fork(state), depth);
  if (AWK_BUILT.test(text)) rd.out.doubt("awk runs a shell line built at run time", scene.text);
}

/** ssh: the words after the host are the remote line, run somewhere the local folder means nothing; a program its options name runs here. */
async function remote(rd: Reader, scene: Scene, state: State, depth: number): Promise<void> {
  const args = scene.call.args;
  const valued = /^-[bcDEeFIiJLlmOopQRSWw]$/;
  let i = 0;
  for (; i < args.length; i += 1) {
    const t = literal(args[i]);
    if (t === null) return;
    if (t === "--") {
      i += 1;
      break;
    }
    if (!t.startsWith("-")) break;
    if (t === "-o") await sshOption(rd, args[i + 1], args[i + 1] ? literal(args[i + 1]) : null, state, depth, scene);
    else if (t.startsWith("-o") && t.length > 2) await sshOption(rd, args[i], t.slice(2), state, depth, scene);
    if (valued.test(t)) i += 1;
  }
  const command = args.slice(i + 1);
  if (!command.length) return;
  const words = command.map(literal);
  if (words.every((w) => w !== null)) await rd.text(words.join(" "), { ...fork(state), cwd: null, moved: true }, depth);
  else rd.out.doubt("ssh runs a remote line known only at run time", scene.text);
}

/** npm, pnpm, yarn and bun scripts: the lines the package.json of the folder gives them, when it changed. */
async function packageScript(rd: Reader, scene: Scene, state: State, depth: number): Promise<void> {
  const texts = scene.call.args.map(literal);
  const lifecycle = new Set(["test", "start", "stop", "restart"]);
  let name: string | null = null;
  if (texts[0] === "run" || texts[0] === "run-script" || texts[0] === "rum" || texts[0] === "urn")
    name = texts[1] ?? null;
  else if (texts[0] && (lifecycle.has(texts[0]) || (scene.call.name !== "npm" && !texts[0].startsWith("-"))))
    name = texts[0];
  if (!name || !state.cwd) return;
  const manifest = await rd.changed(posix.join(state.cwd, "package.json"));
  if (manifest === null) return;
  try {
    const scripts = (JSON.parse(manifest) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const key of [`pre${name}`, name, `post${name}`])
      if (typeof scripts[key] === "string") await rd.text(scripts[key], fork(state), depth);
  } catch {
    return;
  }
}

async function sedExec(rd: Reader, scene: Scene, state: State, ctx: Context): Promise<void> {
  const texts = scene.call.args.map(literal);
  const scripts: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    if ((texts[i] === "-e" || texts[i] === "--expression") && texts[i + 1]) scripts.push(texts[++i]!);
    else if (texts[i] !== null && !texts[i]!.startsWith("-") && !scripts.length) scripts.push(texts[i]!);
  }
  for (const script of scripts) {
    for (const line of script.split(/[;\n]/)) {
      const e = /^\s*e(?:\s+(.+))?$/.exec(line);
      if (e) {
        if (e[1]) await rd.text(e[1], fork(state), ctx.depth + 1);
        else rd.out.add("core.filesystem", "sed-exec-unverified", scene.text);
      }
      const s = /^\s*s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1([gpiImMe0-9w]*)/.exec(line);
      if (s && s[2].includes("e")) rd.out.add("core.filesystem", "sed-exec-unverified", scene.text);
    }
  }
}

async function tarExec(rd: Reader, scene: Scene, state: State, ctx: Context): Promise<void> {
  const args = scene.call.args;
  const known = rd.known(state);
  const helpers = /^--(to-command|use-compress-program|info-script|new-volume-script|checkpoint-action)(=|$)/;
  for (let i = 0; i < args.length; i += 1) {
    const t = literal(args[i]) ?? gluedOption(args[i]);
    if (t === null) continue;
    const m = helpers.exec(t);
    const short = t === "-I" || t === "-F";
    if (!m && !short) continue;
    let arg = m && m[2] === "=" ? valueWord(args[i], t.indexOf("=") + 1) : args[i + 1];
    if (!arg) continue;
    if (m?.[1] === "checkpoint-action") {
      if (!valueOf(arg, known).prefix.startsWith("exec=")) continue;
      arg = valueWord(arg, 5);
    }
    const text = valueOf(arg, known).text;
    if (text === null) rd.out.add("core.filesystem", "tar-exec-unverified", scene.text);
    else await rd.text(text, fork(state), ctx.depth + 1);
  }
}

/** The `--option=` a word starts with when a run-time part follows it, else null. */
function gluedOption(word: Word): string | null {
  const first = word.parts[0];
  return first?.kind === "text" && /^--[a-z-]+=/.test(first.text) ? first.text : null;
}
