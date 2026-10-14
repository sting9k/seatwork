import { languageOf } from "./embedded";
import { Findings } from "./findings";
import { treeGlob } from "./glob";
import { baseName, invocationOf, valueWord, type Invocation } from "./normalize";
import { DECLARED_COMMANDS, declaredHits } from "./packs";
import { absolute, substitution, valueOf } from "./paths";
import { SHELLS, stdinText } from "./programs";
import { CopyTrail } from "./rules/copies";
import { databaseHits, scanDeletesKeys } from "./rules/databases";
import { fileRules, forkBomb, guardedWrites, type FileTools } from "./rules/files";
import { gitRules, type GitTools } from "./rules/git";
import { rmRules, wouldBlockAsRm, type RmTools } from "./rules/rm";
import { execFlags, runners } from "./runners";
import {
  literal,
  parseShell,
  type Command,
  type Part,
  type Script,
  type Sequence,
  type Simple,
  type Word,
} from "./shell";
import { fork, type Context, type Reader, type State } from "./state";
import type { Doubt, Finding, Known, Place, Scene, Variable } from "./types";

/** Walks a command line as the shell would; the rules are those of DCG, a destructive command guard, and the packs. */

/** What the rules ask of the machine: git, the file system, and the files changed since the last commit. */
export interface Tools extends RmTools, GitTools, FileTools {
  changed(path: string): Promise<string | null>;
}

/** The packs in force, the owner's exemptions (`pack:rule` to target globs), and the limits on a line. */
export interface GateConfig {
  packs: ReadonlySet<string>;
  exempt: Readonly<Record<string, string[]>>;
  budgetMs: number;
  maxBytes: number;
}

export interface Evaluation {
  findings: Finding[];
  doubts: Doubt[];
}

const MAX_DEPTH = 8;
const NO_FILES: ReadonlyMap<string, string> = new Map();
const RISKY =
  /\b(rm|git|dd|mkfs|diskutil|shred|truncate|find|mv|chmod|chown|curl|wget|sudo|eval|sh|bash|zsh|python\d*|node|perl|ruby|php|kubectl|terraform|docker)\b|>/;

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
    walk.out.doubt(`the command is longer than ${config.maxBytes} bytes`, command.slice(0, 200));
    return walk.result();
  }
  const state: State = { cwd, moved: false, vars: new Map(), stdinFed: false, written: new Map() };
  await walk.text(command, state, 0);
  walk.finish();
  return walk.result();
}

/** One evaluation: reads the line, keeps the state the shell would, and judges each simple command. */
class Walk implements Reader {
  readonly out = new Findings();
  private readonly seenNames = new Set<string>();
  private readonly bombs = new Map<string, string>();
  private readonly copies = new CopyTrail();
  private outOfTime = false;

  constructor(
    private readonly place: Place,
    private readonly config: GateConfig,
    private readonly tools: Tools,
    private readonly deadline: number,
  ) {}

  result(): Evaluation {
    return { findings: this.out.found, doubts: this.out.doubts };
  }

  /** A shell line read and walked; what bash cannot parse is scanned for risky words. */
  async text(src: string, state: State, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) {
      this.out.doubt("commands nested deeper than the room reads", src.slice(0, 200));
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
      this.out.doubt(`the room could not read the line (${parsed.error.message})`, rest.slice(0, 200));
  }

  known(state: State): Known {
    return { vars: state.vars, place: this.place, cwd: state.cwd };
  }

  changed(path: string): Promise<string | null> {
    return this.tools.changed(path);
  }

  /** What the whole line showed once it is read: a fork bomb that is defined and then called. */
  finish(): void {
    for (const [name, text] of this.bombs)
      if (this.seenNames.has(name)) this.out.add("core.filesystem", "fork-bomb", text);
  }

  private async script(script: Script, state: State, ctx: Context): Promise<void> {
    for (const sequence of script) await this.sequence(sequence, state, ctx);
  }

  private async sequence(sequence: Sequence, state: State, ctx: Context): Promise<void> {
    for (const pipeline of sequence.pipelines) {
      const own = pipeline.commands.length > 1 || sequence.background ? fork(state) : state;
      for (let stage = 0; stage < pipeline.commands.length; stage += 1)
        await this.command(pipeline.commands[stage], stage > 0 ? { ...own, stdinFed: true } : own, {
          ...ctx,
          pipeline,
          stage,
        });
      if (pipeline.commands.length > 1 && this.config.packs.has("database.redis") && scanDeletesKeys(pipeline))
        this.out.add("database.redis", "mass-delete", ctx.src.slice(0, 200));
    }
  }

  private async command(command: Command, state: State, ctx: Context): Promise<void> {
    if (Date.now() > this.deadline) {
      if (!this.outOfTime) this.out.doubt("the room ran out of time reading the command", ctx.src.slice(0, 200));
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
      await this.script(body, { ...inner, stdinFed: fed }, { ...ctx, pipeline: null, stage: 0 });
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

  async simple(simple: Simple, state: State, ctx: Context): Promise<void> {
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
    const call = invocationOf(simple);
    if (call.query) return;
    if (call.name === null && call.command) return this.dynamicCommand(simple, call, state, ctx);
    const scene = this.scene(simple, throughUnread(call), state, ctx);
    this.seenNames.add(scene.call.name ?? "");
    await this.builtins(scene, state, ctx);
    await this.judge(scene, state, ctx);
    await runners(this, scene, state, ctx);
  }

  /** A command word only known at run time: read again when variables settle it, else taken for a possible rm. */
  private async dynamicCommand(simple: Simple, call: Invocation, state: State, ctx: Context): Promise<void> {
    const resolved = valueOf(call.command!, this.known(state));
    if (resolved.text !== null && resolved.text.trim()) {
      const line = [resolved.text, ...call.args.map((w) => w.raw)].join(" ");
      const reread = parseShell(line);
      if (!reread.error && reread.script.length === 1) {
        await this.script(reread.script, state, { ...ctx, src: line });
        return;
      }
    }
    const scene = this.scene(simple, call, state, ctx);
    if (await wouldBlockAsRm(scene, this.rmTools()))
      this.out.add("core.filesystem", "rm-recursive-unverified", scene.text);
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

  /** Commands that change the shell for what follows: cd, variables, aliases, input. */
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
    this.noteWrites(scene, state);
  }

  /** The text of files this command writes from literals, for a shell or interpreter that runs them later. */
  private noteWrites(scene: Scene, state: State): void {
    const name = scene.call.name;
    const args = scene.call.args;
    for (const r of scene.simple.redirects) {
      if (!r.heredoc || !r.target) continue;
      const out = scene.simple.redirects.find((o) => o.op === ">" || o.op === ">>" || o.op === ">|");
      if (out?.target && (name === "cat" || name === "tee" || !name)) {
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
      if (found) this.out.add("core.filesystem", found.rule, scene.text, found.detail);
      else for (const copy of this.copies.removed(scene)) this.out.add("core.filesystem", copy.rule, copy.text);
    }
    if (name === "git" || name?.startsWith("git-")) {
      const outcome = await gitRules(scene, this.tools, this.config.packs.has("strict_git"));
      for (const hit of outcome.hits)
        if (hit.pack === "core.git" || this.config.packs.has(hit.pack))
          this.out.add(hit.pack, hit.rule, scene.text, hit.detail);
      if (outcome.shell) await this.text(outcome.shell, fork(state), ctx.depth + 1);
    }
    const guarded = guardedWrites(scene);
    for (const { found, how } of guarded) this.out.add(found.pack, found.rule, scene.text, `${how} ${found.path}`);
    // a write the credential table holds is not also a redirect finding (DCG's order)
    const redirectsGuarded = guarded.some((g) => /^(>|>>|>\||&>|&>>)$/.test(g.how));
    for (const hit of fileRules(scene, this.tools)) {
      if (redirectsGuarded && hit.rule.startsWith("redirect-")) continue;
      this.out.add(hit.pack, hit.rule, scene.text, hit.detail);
    }
    this.copies.note(scene);
    for (const hit of declaredHits(scene, this.config.packs)) this.out.add(hit.pack, hit.rule, scene.text);
    // files written earlier on the line are not read for a client, so its input stays unverified
    for (const hit of databaseHits(scene, this.config.packs, () => stdinText(scene, scene, NO_FILES)))
      this.out.add(hit.pack, hit.rule, scene.text);
    await execFlags(this, scene, state, ctx);
  }

  private rmTools(): RmTools {
    return {
      ignored: (paths) => this.tools.ignored(paths),
      exempt: (rule, paths) => exempted(this.config.exempt[`core.filesystem:${rule}`], paths, this.place.home),
    };
  }
}

/** The call read on through a wrapper option the room cannot read, to the first word naming a known command. */
function throughUnread(call: Invocation): Invocation {
  if (!call.unread) return call;
  const at = call.args.findIndex((w) => {
    const t = literal(w);
    return t !== null && knownCommand(baseName(t));
  });
  if (at < 0) return call;
  return { ...call, name: baseName(literal(call.args[at])!), command: call.args[at], args: call.args.slice(at + 1) };
}

/** A command a rule names or that runs other commands: worth reading on to through an unreadable wrapper option. */
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

function lineStart(src: string, at: number): number {
  const before = src.lastIndexOf("\n", Math.max(0, at - 1));
  return before < 0 ? 0 : before + 1;
}

/** True when every path lies under one of the owner's globs for the rule. */
function exempted(globs: readonly string[] | undefined, paths: string[], home: string): boolean {
  if (!globs?.length || !paths.length) return false;
  const tests = globs.map((g) => treeGlob(g, home));
  return paths.every((p) => tests.some((t) => t(p)));
}
