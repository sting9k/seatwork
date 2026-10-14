import { posix } from "node:path";
import { INLINE_FLAGS, languageOf, scanEmbedded, type Language } from "./embedded";
import { baseName, invocationOf, valueWord, type Invocation } from "./normalize";
import { DB_CLIENTS, DECLARED_COMMANDS, declaredHits, packOf, ruleOf } from "./packs";
import { absolute, isTemp, lossOf, sensitive, substitution, tempPath, valueOf } from "./paths";
import { fileRules, forkBomb, guardedWrites, type FileTools } from "./rules/files";
import { gitRules, type GitTools } from "./rules/git";
import { guardOf } from "./rules/protected";
import { rmRules, wouldBlockAsRm, type RmTools } from "./rules/rm";
import {
  literal,
  parseShell,
  type Command,
  type Part,
  type Pipeline,
  type Script,
  type Sequence,
  type Simple,
  type Word,
} from "./shell";
import type { Doubt, Finding, Place, Scene, Severity, Variable } from "./types";

/** Walks a command line as the shell would, collecting what DCG's rules and packs find. */

export interface Tools extends RmTools, GitTools, FileTools {
  /** text of a file new or changed since the last commit, else null */
  changed(path: string): Promise<string | null>;
}

export interface GateConfig {
  packs: ReadonlySet<string>;
  /** `pack:rule` to the target globs the owner lifted it for */
  exempt: Readonly<Record<string, string[]>>;
  budgetMs: number;
  maxBytes: number;
}

export interface Evaluation {
  findings: Finding[];
  doubts: Doubt[];
}

interface State {
  cwd: string | null;
  moved: boolean;
  vars: Map<string, Variable>;
  stdinFed: boolean;
  /** files this line wrote from literal text, for `bash file` later in the line */
  written: Map<string, string>;
}

interface Context {
  pipeline: Pipeline | null;
  stage: number;
  src: string;
  depth: number;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "ash", "yash"]);
const MAX_DEPTH = 8;
const INIT_IDIOMS =
  /^(ssh-agent|direnv|pyenv|rbenv|nodenv|goenv|starship|zoxide|brew|fnm|mise|rtx|conda|thefuck|keychain|gpg-agent|opam|luarocks|jenv|atuin|fzf)$/;
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c"]);

/** Every rule that holds for a command line, and every part of it the gate could not read. */
export async function evaluate(
  command: string,
  cwd: string | null,
  place: Place,
  config: GateConfig,
  tools: Tools,
): Promise<Evaluation> {
  const walk = new Walk(place, config, tools, Date.now() + config.budgetMs);
  if (Buffer.byteLength(command) > config.maxBytes) {
    walk.doubts.push({ reason: `the command is longer than ${config.maxBytes} bytes`, text: command.slice(0, 200) });
    return walk.result();
  }
  const state: State = { cwd, moved: false, vars: new Map(), stdinFed: false, written: new Map() };
  await walk.text(command, state, 0);
  walk.finish();
  return walk.result();
}

class Walk {
  readonly findings: Finding[] = [];
  readonly doubts: Doubt[] = [];
  private readonly seenNames = new Set<string>();
  private readonly bombs = new Map<string, string>();
  private readonly copies: { rule: string; dest: string; text: string }[] = [];
  private outOfTime = false;

  constructor(
    private readonly place: Place,
    private readonly config: GateConfig,
    private readonly tools: Tools,
    private readonly deadline: number,
  ) {}

  result(): Evaluation {
    return { findings: this.findings, doubts: this.doubts };
  }

  /** A shell line read and walked; what bash cannot parse is scanned for risky words. */
  async text(src: string, state: State, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      this.doubts.push({ reason: "commands nested deeper than the room reads", text: src.slice(0, 200) });
      return;
    }
    const parsed = parseShell(src);
    if (!parsed.error) return this.script(parsed.script, state, { pipeline: null, stage: 0, src, depth });
    // bash runs the lines before a syntax error and nothing from the line that has it
    const cut = lineStart(src, parsed.error.at);
    const head = src.slice(0, cut);
    if (cut > 0) await this.script(parseShell(head).script, state, { pipeline: null, stage: 0, src: head, depth });
    const rest = src.slice(cut);
    // a line too costly to read may hide anything: it is a doubt whatever its words
    if (RISKY.test(rest) || parsed.error.costly)
      this.doubts.push({
        reason: `the room could not read the line (${parsed.error.message})`,
        text: rest.slice(0, 200),
      });
  }

  private async script(script: Script, state: State, ctx: Context): Promise<void> {
    for (const sequence of script) await this.sequence(sequence, state, ctx);
  }

  private async sequence(sequence: Sequence, state: State, ctx: Context): Promise<void> {
    for (const pipeline of sequence.pipelines) {
      const own = pipeline.commands.length > 1 || sequence.background ? fork(state) : state;
      for (let stage = 0; stage < pipeline.commands.length; stage += 1) {
        const fed = stage > 0 ? { ...own, stdinFed: true } : own;
        await this.command(pipeline.commands[stage], stage > 0 ? fed : own, { ...ctx, pipeline, stage });
      }
      if (pipeline.commands.length > 1) this.pipelineRules(pipeline, ctx);
    }
  }

  private async command(command: Command, state: State, ctx: Context): Promise<void> {
    if (Date.now() > this.deadline) {
      if (!this.outOfTime)
        this.doubts.push({ reason: "the room ran out of time reading the command", text: ctx.src.slice(0, 200) });
      this.outOfTime = true;
      return;
    }
    if (command.kind === "simple") return this.simple(command, state, ctx);
    if (command.kind === "function") {
      const body = ctx.src.slice(command.body.start, command.body.end);
      if (forkBomb(command.name, body)) this.bombs.set(command.name, ctx.src.slice(command.start, command.end));
      return this.command(command.body, fork(state), ctx);
    }
    for (const word of command.words) await this.substitutions(word.parts, state, ctx);
    const inner = command.kind === "subshell" ? fork(state) : state;
    const fed =
      command.redirects.some((r) => r.op === "<" || r.op === "<<" || r.op === "<<-" || r.op === "<<<") ||
      state.stdinFed;
    for (const body of command.bodies)
      await this.script(
        body,
        { ...inner, stdinFed: fed, vars: inner.vars, written: inner.written },
        { ...ctx, pipeline: null, stage: 0 },
      );
    if (command.redirects.length) {
      const simple: Simple = {
        kind: "simple",
        assigns: [],
        words: [],
        redirects: command.redirects,
        start: command.start,
        end: command.end,
      };
      await this.judge(this.scene(simple, invocationOf(simple), state, ctx), state, ctx);
    }
  }

  /** The command substitutions in some word parts, run first as the shell would. */
  private async substitutions(parts: readonly Part[], state: State, ctx: Context): Promise<void> {
    for (const part of parts) {
      if (part.kind === "command" || part.kind === "process")
        await this.script(part.script, fork(state), { ...ctx, pipeline: null, stage: 0, depth: ctx.depth + 1 });
      else if (part.kind === "param" || part.kind === "arith")
        for (const s of part.scripts)
          await this.script(s, fork(state), { ...ctx, pipeline: null, stage: 0, depth: ctx.depth + 1 });
    }
  }

  private async simple(simple: Simple, state: State, ctx: Context): Promise<void> {
    for (const assign of simple.assigns) {
      if (assign.value) await this.substitutions(assign.value.parts, state, ctx);
      for (const item of assign.items ?? []) await this.substitutions(item.parts, state, ctx);
    }
    for (const word of simple.words) await this.substitutions(word.parts, state, ctx);
    for (const r of simple.redirects) {
      if (r.target && !r.heredoc) await this.substitutions(r.target.parts, state, ctx);
      if (r.heredoc) await this.substitutions(r.heredoc.parts, state, ctx);
    }
    if (!simple.words.length) {
      for (const assign of simple.assigns) state.vars.set(assign.name, this.assigned(assign.value, state));
      if (simple.redirects.length) await this.judge(this.scene(simple, invocationOf(simple), state, ctx), state, ctx);
      return;
    }
    let call = invocationOf(simple);
    if (call.query) return;
    if (call.name === null && call.command) {
      const resolved = valueOf(call.command, this.known(state));
      if (resolved.text !== null && resolved.text.trim()) {
        const reread = parseShell([resolved.text, ...call.args.map((w) => w.raw)].join(" "));
        if (!reread.error && reread.script.length === 1) {
          await this.script(reread.script, state, {
            ...ctx,
            src: [resolved.text, ...call.args.map((w) => w.raw)].join(" "),
          });
          return;
        }
      }
      const scene = this.scene(simple, call, state, ctx);
      if (await wouldBlockAsRm(scene, this.rmTools()))
        this.add("core.filesystem", "rm-recursive-unverified", scene.text);
      return;
    }
    if (call.unread) {
      const at = call.args.findIndex((w) => {
        const t = literal(w);
        return t !== null && knownCommand(baseName(t));
      });
      if (at >= 0)
        call = {
          ...call,
          name: baseName(literal(call.args[at])!),
          command: call.args[at],
          args: call.args.slice(at + 1),
        };
    }
    const scene = this.scene(simple, call, state, ctx);
    this.seenNames.add(call.name ?? "");
    await this.builtins(scene, state, ctx);
    await this.judge(scene, state, ctx);
    await this.runners(scene, state, ctx);
  }

  private assigned(value: Word | null, state: State): Variable {
    if (!value) return { value: "", temp: false };
    const found = valueOf(value, this.known(state));
    if (found.text !== null) return { value: found.text, temp: false };
    const sub =
      value.parts.length === 1 && value.parts[0].kind === "command"
        ? substitution(value.parts[0].script, this.known(state))
        : null;
    return { value: sub?.text ?? null, temp: !!sub?.temp };
  }

  private known(state: State): Pick<Scene, "vars" | "place" | "cwd"> {
    return { vars: state.vars, place: this.place, cwd: state.cwd };
  }

  private scene(simple: Simple, call: Invocation, state: State, ctx: Context): Scene {
    const redirectsIn = simple.redirects.some(
      (r) => r.op === "<" || r.op === "<<" || r.op === "<<-" || r.op === "<<<" || r.op === "<>",
    );
    return {
      simple,
      call,
      text: ctx.src.slice(simple.start, simple.end) || ctx.src,
      cwd: call.chdir ? absolute(valueOf(call.chdir, this.known(state)), state.cwd) : state.cwd,
      moved: state.moved || !!call.chdir,
      stdinFed: state.stdinFed || redirectsIn,
      pipeline: ctx.pipeline,
      stage: ctx.stage,
      place: this.place,
      vars: state.vars,
    };
  }

  /** Commands that change the shell for what follows: cd, variables, aliases, redirections. */
  private async builtins(scene: Scene, state: State, ctx: Context): Promise<void> {
    const name = scene.call.name;
    const args = scene.call.args;
    if (name === "cd" || name === "pushd") {
      const target = args.find((w) => !(literal(w) ?? "").startsWith("-") || literal(w) === "-");
      if (!target) state.cwd = this.place.home;
      else if (literal(target) === "-") state.cwd = null;
      else state.cwd = absolute(valueOf(target, this.known(state)), state.cwd);
      state.moved = state.cwd !== this.place.start;
    } else if (name === "popd") {
      state.cwd = null;
      state.moved = true;
    } else if (
      name === "export" ||
      name === "declare" ||
      name === "typeset" ||
      name === "local" ||
      name === "readonly"
    ) {
      for (const word of args) {
        const text = literal(word);
        const m =
          text === null ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.raw) : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(text);
        if (!m) continue;
        state.vars.set(m[1], this.assigned(valueWord(word, m[1].length + 1), state));
      }
    } else if (name === "unset") {
      for (const word of args) state.vars.delete(literal(word) ?? "");
    } else if (name === "alias") {
      for (const word of args) {
        const text = literal(word);
        const m = text ? /^[^=]+=(.*)$/s.exec(text) : null;
        if (m) await this.text(m[1], fork(state), ctx.depth + 1);
      }
    } else if (
      name === "exec" &&
      !args.length &&
      scene.simple.redirects.some((r) => r.op === "<" && (r.fd === null || r.fd === "0"))
    )
      state.stdinFed = true;
    for (const r of scene.simple.redirects) {
      if (!r.heredoc || !r.target) continue;
      const out = scene.simple.redirects.find((o) => o.op === ">" || o.op === ">>" || o.op === ">|");
      if (out?.target && (scene.call.name === "cat" || scene.call.name === "tee" || !scene.call.name)) {
        const path = absolute(valueOf(out.target, this.known(state)), state.cwd);
        if (path) state.written.set(path, r.heredoc.body);
      }
    }
    if ((name === "echo" || name === "printf") && scene.simple.redirects.length) {
      const out = scene.simple.redirects.find((o) => o.op === ">" || o.op === ">>");
      const words = args.map(literal);
      if (out?.target && words.every((w) => w !== null)) {
        const path = absolute(valueOf(out.target, this.known(state)), state.cwd);
        if (path)
          state.written.set(path, (words as string[]).filter((w, i) => !(i === 0 && /^-[neE]+$/.test(w))).join(" "));
      }
    }
    if (name === "tee")
      for (const w of args) {
        const heredoc = scene.simple.redirects.find((r) => r.heredoc)?.heredoc;
        const path =
          literal(w) && !literal(w)!.startsWith("-") ? absolute(valueOf(w, this.known(state)), state.cwd) : null;
        if (heredoc && path) state.written.set(path, heredoc.body);
      }
  }

  /** Every rule for one command: rm, git, files, protected writes, databases, declared packs. */
  private async judge(scene: Scene, state: State, ctx: Context): Promise<void> {
    const name = scene.call.name;
    if (name === "rm" || name === "rimraf" || name === "grm") {
      const found = await rmRules(
        name === "grm" ? { ...scene, call: { ...scene.call, name: "rm" } } : scene,
        this.rmTools(),
      );
      if (found) this.add("core.filesystem", found.rule, scene.text, found.detail);
      else this.propagation(scene);
    }
    if (name === "git" || name?.startsWith("git-")) {
      const outcome = await gitRules(scene, this.tools, this.config.packs.has("strict_git"));
      for (const hit of outcome.hits)
        if (hit.pack === "core.git" || this.config.packs.has(hit.pack))
          this.add(hit.pack, hit.rule, scene.text, hit.detail);
      if (outcome.shell) await this.text(outcome.shell, fork(state), ctx.depth + 1);
    }
    const guarded = guardedWrites(scene);
    for (const { found, how } of guarded) this.add(found.pack, found.rule, scene.text, `${how} ${found.path}`);
    // a write the credential table holds is not also a redirect finding (DCG's order)
    const redirectsGuarded = guarded.some((g) => /^(>|>>|>\||&>|&>>)$/.test(g.how));
    for (const hit of fileRules(scene, this.tools)) {
      if (redirectsGuarded && hit.rule.startsWith("redirect-")) continue;
      this.add(hit.pack, hit.rule, scene.text, hit.detail);
    }
    this.noteCopies(scene);
    for (const hit of declaredHits(scene, this.config.packs)) this.add(hit.pack, hit.rule, scene.text);
    this.databases(scene);
    if (name === "sed" || name === "gsed") await this.sedExec(scene, state, ctx);
    if (name === "tar" || name === "gtar") await this.tarExec(scene, state, ctx);
  }

  /** Programs that run other programs: shells, eval, xargs, find -exec, ssh, interpreters. */
  private async runners(scene: Scene, state: State, ctx: Context): Promise<void> {
    const name = scene.call.name ?? "";
    const args = scene.call.args;
    const texts = args.map(literal);
    const nested = ctx.depth + 1;
    for (const inline of scene.call.inline) await this.shellWord(inline, state, nested, scene);
    if (SHELLS.has(name)) {
      const c = texts.findIndex((t) => t !== null && /^-[a-z]*c[a-z]*$/i.test(t) && !t.startsWith("--"));
      if (c >= 0 && args[c + 1]) return this.shellWord(args[c + 1], state, nested, scene);
      const script = args.find((_, i) => texts[i] === null || !texts[i]!.startsWith("-"));
      if (script) return this.scriptFile(script, "shell", state, nested, scene);
      return this.stdinProgram(scene, "shell", state, nested);
    }
    const language = languageOf(name);
    if (language) {
      const flags = INLINE_FLAGS[language];
      const at = texts.findIndex(
        (t) =>
          t !== null && flags.some((f) => t === f || (f.length === 2 && t.startsWith(f) && t.length > 2 && f !== "-e")),
      );
      if (at >= 0) {
        const t = texts[at]!;
        const code = t.length > 2 && !t.startsWith("--") ? valueWord(args[at], 2) : args[at + 1];
        if (code) return this.program(language, code, state, nested, scene);
      }
      const module = texts.indexOf("-m");
      if (module >= 0) return;
      const script = args.find((_, i) => !(texts[i] ?? "-").startsWith("-"));
      if (script && literal(script) !== "-") return this.scriptFile(script, language, state, nested, scene);
      return this.stdinProgram(scene, language, state, nested);
    }
    switch (name) {
      case "eval": {
        if (texts.every((t) => t !== null)) return this.text(texts.join(" "), fork(state), nested);
        const sub = args.length === 1 ? args[0].parts.find((p) => p.kind === "command") : undefined;
        const program = sub?.kind === "command" ? firstName(sub.script) : null;
        if (program && INIT_IDIOMS.test(program)) return;
        this.doubts.push({ reason: "eval runs text known only at run time", text: scene.text });
        return;
      }
      case "source":
      case ".":
        if (args[0]) return this.scriptFile(args[0], "shell", state, nested, scene);
        return;
      case "trap":
        if (args[0] && texts[0] !== "-" && !(texts[0] ?? "").startsWith("-"))
          return this.shellWord(args[0], state, nested, scene);
        return;
      case "xargs":
        return this.xargs(scene, state, ctx);
      case "find":
        return this.findExec(scene, state, ctx);
      case "watch":
      case "parallel":
      case "entr":
      case "hyperfine":
      case "nohup":
        return this.joined(scene, name, state, nested);
      case "ssh":
        return this.remote(scene, state, nested);
      case "su":
      case "sg":
      case "runuser":
      case "nix-shell":
      case "flock":
      case "script": {
        const flag = name === "nix-shell" ? ["--run", "--command"] : ["-c", "--command"];
        const at = texts.findIndex((t) => t !== null && flag.includes(t));
        if (at >= 0 && args[at + 1]) return this.shellWord(args[at + 1], state, nested, scene);
        if (name === "flock" || name === "script" || name === "sg") {
          const rest = name === "script" ? args.slice(2) : name === "sg" ? args.slice(1) : args.slice(1);
          if (rest.length) await this.text(rest.map((w) => w.raw).join(" "), fork(state), nested);
        }
        return;
      }
      case "npm":
      case "pnpm":
      case "yarn":
      case "bun":
        return this.packageScript(scene, state, nested);
    }
    if (scene.call.command && (literal(scene.call.command) ?? "").includes("/"))
      return this.scriptFile(scene.call.command, null, state, nested, scene);
  }

  /** A word that a program runs as a shell line. */
  private async shellWord(word: Word, state: State, depth: number, scene: Scene): Promise<void> {
    const value = valueOf(word, this.known(state));
    if (value.text !== null) return this.text(value.text, fork(state), depth);
    if (this.downloads(word.parts)) {
      this.add("room.software", "download-and-run", scene.text);
      return;
    }
    this.doubts.push({ reason: "a shell runs a line known only at run time", text: scene.text });
  }

  /** A script file run by a shell or interpreter: written earlier in the line, or changed. */
  private async scriptFile(
    word: Word,
    language: Language | "shell" | null,
    state: State,
    depth: number,
    scene: Scene,
  ): Promise<void> {
    if (word.parts.some((p) => p.kind === "process")) {
      if (this.downloads(word.parts)) this.add("room.software", "download-and-run", scene.text);
      else this.doubts.push({ reason: "a shell runs the output of a command", text: scene.text });
      return;
    }
    const path = absolute(valueOf(word, this.known(state)), state.cwd);
    if (!path) return;
    const text = state.written.get(path) ?? (await this.tools.changed(path));
    if (text === null) return;
    const lang = language ?? languageOfScript(path, text);
    if (lang === "shell") return this.text(text, fork(state), depth);
    if (lang) return this.program(lang, null, state, depth, scene, text);
  }

  /** A program read from stdin: a heredoc, a here-string, or what a literal echo pipes in. */
  private async stdinProgram(scene: Scene, language: Language | "shell", state: State, depth: number): Promise<void> {
    const fed = this.stdinText(scene, state);
    if (fed === undefined) return;
    if (fed === null) {
      if (scene.stage > 0 && scene.pipeline && this.pipeDownloads(scene.pipeline, scene.stage))
        this.add("room.software", "download-and-run", scene.text);
      else
        this.doubts.push({
          reason: `${language === "shell" ? "a shell" : language} runs input the room cannot read`,
          text: scene.text,
        });
      return;
    }
    if (language === "shell") return this.text(fed, fork(state), depth);
    return this.program(language, null, state, depth, scene, fed);
  }

  /** The text a command reads on stdin; null when it reads something unseen, undefined if none. */
  private stdinText(scene: Scene, state: State): string | null | undefined {
    for (const r of scene.simple.redirects) {
      if (r.heredoc) return r.heredoc.body;
      if (r.op === "<<<" && r.target) return valueOf(r.target, this.known(state)).text;
      if (r.op === "<" && r.target) {
        const path = absolute(valueOf(r.target, this.known(state)), state.cwd);
        return path ? (state.written.get(path) ?? null) : null;
      }
    }
    if (scene.stage === 0 || !scene.pipeline) return undefined;
    const producer = scene.pipeline.commands[scene.stage - 1];
    if (producer.kind !== "simple") return null;
    const call = invocationOf(producer);
    const words = call.args.map((w) => valueOf(w, this.known(state)).text);
    if ((call.name === "echo" || call.name === "printf") && words.every((w) => w !== null))
      return (words as string[]).filter((w, i) => !(call.name === "echo" && i === 0 && /^-[neE]+$/.test(w))).join(" ");
    if (call.name === "cat" && !call.args.length) {
      const doc = producer.redirects.find((r) => r.heredoc)?.heredoc;
      if (doc) return doc.body;
      const here = producer.redirects.find((r) => r.op === "<<<");
      if (here?.target) return valueOf(here.target, this.known(state)).text;
    }
    return null;
  }

  /** A program in an interpreter's language: its shell lines, deletes and writes, judged. */
  private async program(
    language: Language,
    code: Word | null,
    state: State,
    depth: number,
    scene: Scene,
    text?: string,
  ): Promise<void> {
    const source = text ?? (code ? valueOf(code, this.known(state)).text : null);
    if (source === null || source === undefined) return;
    const found = scanEmbedded(language, source);
    for (const line of found.shell) await this.text(line, fork(state), depth);
    for (const del of found.deletes) {
      const word: Word = {
        raw: del.path,
        start: 0,
        end: 0,
        parts: [{ kind: "text", text: del.path, quote: "single" }],
      };
      const value = valueOf(word, this.known(state));
      if (del.recursive) {
        if (isTemp(value, this.known(state))) continue;
        const severe = lossOf(value, this.known(state), this.place.project) === "critical";
        this.add(
          "core.filesystem",
          severe ? "rm-rf-root-home" : "rm-rf-general",
          scene.text,
          `${language} ${del.how} ${del.path}`,
        );
      } else {
        const guard = guardOf(value, "remove", this.known(state));
        if (guard) this.add("core.filesystem", "rm-protected-file", scene.text, `${language} ${del.how} ${del.path}`);
      }
    }
    for (const write of found.writes) {
      const word: Word = {
        raw: write.path,
        start: 0,
        end: 0,
        parts: [{ kind: "text", text: write.path, quote: "single" }],
      };
      const guard = guardOf(valueOf(word, this.known(state)), write.append ? "append" : "write", this.known(state));
      if (guard) this.add(guard.pack, guard.rule, scene.text, `${language} ${write.how} ${write.path}`);
    }
    if (found.dynamicExec.length)
      this.add("core.filesystem", "interpreter-runs-dynamic-shell", scene.text, `${language} ${found.dynamicExec[0]}`);
  }

  private async xargs(scene: Scene, state: State, ctx: Context): Promise<void> {
    const args = scene.call.args;
    const valued = new Set([
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
    let i = 0;
    for (; i < args.length; i += 1) {
      const t = literal(args[i]);
      if (t === null || !t.startsWith("-")) break;
      if (t === "--") {
        i += 1;
        break;
      }
      if (valued.has(t)) i += 1;
    }
    const inner = args.slice(i);
    if (!inner.length) return;
    const ended = inner.some((w) => literal(w) === "--");
    const name = baseName(literal(inner[0]) ?? "");
    const tail = name === "rm" && !ended ? [word("-r"), dynamicWord()] : [dynamicWord()];
    await this.synthetic([...inner, ...tail], state, ctx);
  }

  private async findExec(scene: Scene, state: State, ctx: Context): Promise<void> {
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
      if (inner.length) await this.synthetic(inner, state, ctx);
      i = j;
    }
  }

  /** A command built from another's arguments (xargs, find -exec), judged as if written. */
  private async synthetic(words: Word[], state: State, ctx: Context): Promise<void> {
    const simple: Simple = { kind: "simple", assigns: [], words, redirects: [], start: 0, end: 0 };
    const src = words.map((w) => w.raw).join(" ");
    await this.simple(
      simple,
      { ...state, stdinFed: true },
      { ...ctx, src, pipeline: null, stage: 0, depth: ctx.depth + 1 },
    );
  }

  private async joined(scene: Scene, name: string, state: State, depth: number): Promise<void> {
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
          await this.shellWord(args[i], state, depth, scene);
      return;
    }
    if (name === "entr") {
      const s = texts.indexOf("-s");
      if (s >= 0 && args[s + 1]) return this.shellWord(args[s + 1], state, depth, scene);
    }
    const start = args.findIndex(
      (_, i) => !(texts[i] ?? "-").startsWith("-") && !(name === "watch" && /^-[ndt]$/.test(texts[i - 1] ?? "")),
    );
    if (start < 0) return;
    const end = name === "parallel" ? texts.findIndex((t) => t === ":::" || t === "::::") : -1;
    const words = args.slice(start, end < 0 ? undefined : end);
    if (words.every((w) => literal(w) !== null))
      await this.text(words.map((w) => literal(w)!).join(" "), fork(state), depth);
    else this.doubts.push({ reason: `${name} runs a line known only at run time`, text: scene.text });
  }

  private async remote(scene: Scene, state: State, depth: number): Promise<void> {
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
      if (valued.test(t)) i += 1;
    }
    const command = args.slice(i + 1);
    if (!command.length) return;
    const words = command.map(literal);
    if (words.every((w) => w !== null))
      await this.text(words.join(" "), { ...fork(state), cwd: null, moved: true }, depth);
    else this.doubts.push({ reason: "ssh runs a remote line known only at run time", text: scene.text });
  }

  private async packageScript(scene: Scene, state: State, depth: number): Promise<void> {
    const texts = scene.call.args.map(literal);
    const lifecycle = new Set(["test", "start", "stop", "restart"]);
    let name: string | null = null;
    if (texts[0] === "run" || texts[0] === "run-script" || texts[0] === "rum" || texts[0] === "urn")
      name = texts[1] ?? null;
    else if (texts[0] && (lifecycle.has(texts[0]) || (scene.call.name !== "npm" && !texts[0].startsWith("-"))))
      name = texts[0];
    if (!name || !state.cwd) return;
    const manifest = await this.tools.changed(posix.join(state.cwd, "package.json"));
    if (manifest === null) return;
    try {
      const scripts = (JSON.parse(manifest) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const key of [`pre${name}`, name, `post${name}`])
        if (typeof scripts[key] === "string") await this.text(scripts[key], fork(state), depth);
    } catch {
      return;
    }
  }

  private async sedExec(scene: Scene, state: State, ctx: Context): Promise<void> {
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
          if (e[1]) await this.text(e[1], fork(state), ctx.depth + 1);
          else this.add("core.filesystem", "sed-exec-unverified", scene.text);
        }
        const s = /^\s*s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1([gpiImMe0-9w]*)/.exec(line);
        if (s && s[2].includes("e")) this.add("core.filesystem", "sed-exec-unverified", scene.text);
      }
    }
  }

  private async tarExec(scene: Scene, state: State, ctx: Context): Promise<void> {
    const args = scene.call.args;
    const helpers = /^--(to-command|use-compress-program|info-script|new-volume-script|checkpoint-action)(=|$)/;
    for (let i = 0; i < args.length; i += 1) {
      const t = literal(args[i]);
      if (t === null) continue;
      const m = helpers.exec(t);
      const short = t === "-I" || t === "-F";
      if (!m && !short) continue;
      let word = m && m[2] === "=" ? valueWord(args[i], t.indexOf("=") + 1) : args[i + 1];
      if (!word) continue;
      if (m?.[1] === "checkpoint-action") {
        const v = literal(word);
        if (!v?.startsWith("exec=")) continue;
        word = valueWord(word, 5);
      }
      const value = valueOf(word, this.known(state)).text;
      if (value === null) this.add("core.filesystem", "tar-exec-unverified", scene.text);
      else await this.text(value, fork(state), ctx.depth + 1);
    }
  }

  /** A database client's statements against the database packs in force. */
  private databases(scene: Scene): void {
    const name = scene.call.name ?? "";
    const pack = Object.entries(DB_CLIENTS).find(
      ([id, clients]) => clients.includes(name) && this.config.packs.has(id),
    )?.[0];
    if (!pack) return;
    const texts = scene.call.args.map(literal);
    const inline: string[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const t = texts[i];
      if (t === null) continue;
      if (["-c", "--command", "-e", "--execute", "--eval"].includes(t) && texts[i + 1] !== undefined)
        inline.push(texts[++i] ?? "");
      else if (/^--(command|execute|eval)=/.test(t)) inline.push(t.slice(t.indexOf("=") + 1));
      else if (!t.startsWith("-") && (name.startsWith("redis") || name === "sqlite3")) inline.push(t);
    }
    const fed = this.stdinText(scene, {
      cwd: scene.cwd,
      moved: scene.moved,
      vars: new Map(scene.vars),
      stdinFed: scene.stdinFed,
      written: new Map(),
    });
    if (fed === null || texts.some((t) => t === "-f" || t === "--file")) {
      this.add(pack, "stdin-unverified", scene.text);
      return;
    }
    const sql = [...inline, fed ?? ""].join("\n");
    if (!sql.trim()) return;
    const rules = Object.entries(packOf(pack)?.rules ?? {});
    for (const [id, rule] of rules) {
      if (rule.noWhere) {
        if (sql.split(";").some((st) => /^\s*UPDATE\b[\s\S]*\bSET\b/i.test(st) && !/\bWHERE\b/i.test(st)))
          this.add(pack, id, scene.text);
        continue;
      }
      if (!rule.sql) continue;
      const test = new RegExp(rule.statement ? `(^|;)\\s*${rule.sql}` : rule.sql, "i");
      if (test.test(sql)) this.add(pack, id, scene.text);
    }
  }

  /** Pipelines: a download piped into a shell, and keys from a scan piped into a delete. */
  private pipelineRules(pipeline: Pipeline, ctx: Context): void {
    if (!this.config.packs.has("database.redis")) return;
    const calls = pipeline.commands.map((c) => (c.kind === "simple" ? invocationOf(c) : null));
    const scans = calls.some(
      (c) =>
        c &&
        /^(redis|valkey|keydb)-cli$/.test(c.name ?? "") &&
        c.args.some((w) => /^(--scan|keys)$/i.test(literal(w) ?? "")),
    );
    const deletes = calls.some(
      (c) => c?.name === "xargs" && c.args.some((w) => /^(del|unlink)$/i.test(literal(w) ?? "")),
    );
    if (scans && deletes) this.add("database.redis", "mass-delete", ctx.src.slice(0, 200));
  }

  private pipeDownloads(pipeline: Pipeline, stage: number): boolean {
    return pipeline.commands
      .slice(0, stage)
      .some((c) => c.kind === "simple" && DOWNLOADERS.has(invocationOf(c).name ?? ""));
  }

  private downloads(parts: readonly Part[]): boolean {
    return parts.some(
      (p) => (p.kind === "command" || p.kind === "process") && firstNames(p.script).some((n) => DOWNLOADERS.has(n)),
    );
  }

  /** cp -a, ln -s or rsync -a from a sensitive path into temp: noted for a later rm of it. */
  private noteCopies(scene: Scene): void {
    const name = scene.call.name;
    const texts = scene.call.args.map(literal);
    const rule =
      name === "cp" && texts.some((t) => t === "--archive" || (t !== null && /^-[a-zA-Z]*a/.test(t)))
        ? "cp-sensitive-then-delete"
        : name === "ln" && texts.some((t) => t !== null && /^-[a-zA-Z]*s/.test(t))
          ? "ln-symlink-sensitive-then-delete"
          : name === "rsync" && texts.some((t) => t === "--archive" || (t !== null && /^-[a-zA-Z]*a/.test(t)))
            ? "rsync-sensitive-then-delete"
            : null;
    if (!rule) return;
    const files = scene.call.args.filter((_, i) => !(texts[i] ?? "x").startsWith("-")).map((w) => valueOf(w, scene));
    if (files.length < 2) return;
    const dest = files[files.length - 1];
    if (!dest.text || !tempPath(dest.text)) return;
    if (files.slice(0, -1).some((v) => sensitive(v, scene, false)))
      this.copies.push({ rule, dest: posix.normalize(dest.text), text: scene.text });
  }

  /** An rm the rm rules let through, of a temp folder a sensitive tree was copied into. */
  private propagation(scene: Scene): void {
    if (!this.copies.length) return;
    const texts = scene.call.args.map(literal);
    if (!texts.some((t) => t !== null && (/^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive"))) return;
    for (const w of scene.call.args) {
      const v = valueOf(w, scene).text;
      if (!v || !tempPath(v)) continue;
      const path = posix.normalize(v);
      const copy = this.copies.find(
        (c) => path === c.dest || path.startsWith(`${c.dest}/`) || c.dest.startsWith(`${path}/`),
      );
      if (copy) this.add("core.filesystem", copy.rule, `${copy.text}; ${scene.text}`);
    }
  }

  /** What the whole line showed once it is read: a fork bomb that is defined and then called. */
  finish(): void {
    for (const [name, text] of this.bombs) if (this.seenNames.has(name)) this.add("core.filesystem", "fork-bomb", text);
  }

  private rmTools(): RmTools {
    return {
      ignored: (paths) => this.tools.ignored(paths),
      exempt: (rule, paths) => exempted(this.config.exempt[`core.filesystem:${rule}`], paths, this.place.home),
    };
  }

  private add(pack: string, rule: string, text: string, detail?: string): void {
    const declared = ruleOf(pack, rule);
    if (!declared) throw new Error(`safety: no rule ${pack}:${rule}`);
    if (this.findings.some((f) => f.pack === pack && f.rule === rule && f.text === text)) return;
    this.findings.push({
      pack,
      rule,
      severity: declared.severity as Severity,
      reason: detail ? `${declared.reason} (${detail})` : declared.reason,
      ...(declared.explanation ? { explanation: declared.explanation } : {}),
      ...(declared.safer?.length ? { safer: declared.safer } : {}),
      text,
    });
  }
}

const RISKY =
  /\b(rm|git|dd|mkfs|diskutil|shred|truncate|find|mv|chmod|chown|curl|wget|sudo|eval|sh|bash|zsh|python\d*|node|perl|ruby|php|kubectl|terraform|docker)\b|>/;

const fork = (state: State): State => ({ ...state, vars: new Map(state.vars), written: new Map(state.written) });

const word = (text: string): Word => ({ raw: text, start: 0, end: 0, parts: [{ kind: "text", text, quote: "none" }] });

/** A word only known at run time: the input xargs feeds, the `{}` of find -exec. */
const dynamicWord = (): Word => ({
  raw: "{}",
  start: 0,
  end: 0,
  parts: [{ kind: "param", name: "", raw: "${input}", quoted: false, scripts: [] }],
});

function lineStart(src: string, at: number): number {
  const before = src.lastIndexOf("\n", Math.max(0, at - 1));
  return before < 0 ? 0 : before + 1;
}

function firstName(script: Script): string | null {
  return firstNames(script)[0] ?? null;
}

function firstNames(script: Script): string[] {
  const out: string[] = [];
  for (const sequence of script)
    for (const pipeline of sequence.pipelines)
      for (const command of pipeline.commands)
        if (command.kind === "simple") out.push(invocationOf(command).name ?? "");
  return out;
}

function knownCommand(name: string): boolean {
  return (
    name === "rm" ||
    name === "git" ||
    SHELLS.has(name) ||
    DECLARED_COMMANDS.has(name) ||
    languageOf(name) !== null ||
    ["dd", "mv", "find", "unlink", "truncate", "shred", "tar", "rsync", "eval", "xargs"].includes(name)
  );
}

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

/** True when every path lies under one of the owner's globs for the rule. */
function exempted(globs: readonly string[] | undefined, paths: string[], home: string): boolean {
  if (!globs?.length || !paths.length) return false;
  const tests = globs.map((g) => {
    const expanded = g.startsWith("~/") ? posix.join(home, g.slice(2)) : g;
    const source = expanded
      .split("**")
      .map((piece) =>
        piece
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*");
    return new RegExp(`^${source}(/.*)?$`);
  });
  return paths.every((p) => tests.some((t) => t.test(p)));
}
