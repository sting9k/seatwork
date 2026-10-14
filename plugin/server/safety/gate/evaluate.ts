import { languageOf } from "./embedded";
import { Findings } from "./findings";
import { treeGlob } from "./glob";
import { baseName, invocationOf, valueWord, type Invocation } from "./normalize";
import { DECLARED_COMMANDS, declaredHits } from "./packs";
import { absolute, homeOf, substitution, valueOf } from "./paths";
import { SHELLS, stdinText } from "./programs";
import { CopyTrail } from "./rules/copies";
import { databaseHits, scanDeletesKeys } from "./rules/databases";
import { fileRules, forkBomb, guardedWrites, type FileTools } from "./rules/files";
import { gitRules, givesProgram, PROGRAM_VARIABLES, type GitTools } from "./rules/git";
import { namesDriver, ATTRIBUTES_FILE } from "./rules/attributes";
import { cliWords, paseoCommand, startsPaseo } from "./rules/paseo";
import { rmRules, wouldBlockAsRm, type RmTools } from "./rules/rm";
import { execFlags, runners } from "./runners";
import { writtenTexts } from "./writes";
import {
  literal,
  parseShell,
  type Assignment,
  type Command,
  type Compound,
  type Part,
  type Pipeline,
  type Script,
  type Sequence,
  type Simple,
  type Word,
} from "./shell";
import {
  copyInto,
  fork,
  keepWrites,
  meet,
  startState,
  UNKNOWN,
  widened,
  type Context,
  type Def,
  type Reader,
  type State,
} from "./state";
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
const MAX_CALLS = 500;
const MAX_TURNS = 3;
const MAX_PAIRS = 32;
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
  await walk.text(command, startState(cwd), 0);
  walk.finish();
  return walk.result();
}

/** One evaluation: reads the line, keeps the state the shell would, and judges each simple command. */
class Walk implements Reader {
  readonly out = new Findings();
  private readonly seenNames = new Set<string>();
  private readonly bombs = new Map<string, string>();
  private readonly copies = new CopyTrail();
  private readonly frames: Map<string, Variable | undefined>[] = [];
  private readonly expanding = new Set<string>();
  private readonly running = new Set<string>();
  private outcome: { succeeded: State[]; failed: State[] } | null = null;
  private calls = 0;
  private callsCut = false;
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

  real(path: string): string | null {
    return this.tools.real(path);
  }

  /** What the whole line showed once it is read: a fork bomb that is defined and then called. */
  finish(): void {
    for (const [name, text] of this.bombs)
      if (this.seenNames.has(name)) this.out.add("core.filesystem", "fork-bomb", text);
  }

  private async script(script: Script, state: State, ctx: Context): Promise<void> {
    for (const sequence of script) await this.sequence(sequence, state, ctx);
  }

  /** Pipelines joined by `&&` and `||`: each later one runs only where the ones before let it, and what follows may stand after any of them. */
  private async sequence(sequence: Sequence, state: State, ctx: Context): Promise<void> {
    const { pipelines, ops } = sequence;
    const own = sequence.background ? fork(state) : state;
    await this.pipeline(pipelines[0], own, ctx);
    this.outcome = null;
    if (ops.length) {
      const first = fork(own);
      let succeeded = [first];
      let failed = [first];
      for (let i = 1; i < pipelines.length; i += 1) {
        const and = ops[i - 1] === "&&";
        const from = and ? succeeded : failed;
        const here = fork(from[0]);
        meet(here, from.slice(1));
        await this.pipeline(pipelines[i], here, ctx);
        if (and) {
          succeeded = [here];
          failed.push(here);
        } else {
          succeeded.push(here);
          failed = [here];
        }
      }
      const ends = [...new Set([...succeeded, ...failed])];
      copyInto(own, ends[0]);
      meet(own, ends.slice(1));
      this.outcome = { succeeded, failed };
    }
    if (sequence.background) keepWrites(state, own);
  }

  /** The commands of a pipeline, each stage in a shell of its own; the last may run in the line's own shell, so what it changed is unsure. */
  private async pipeline(pipeline: Pipeline, state: State, ctx: Context): Promise<void> {
    const stages = pipeline.commands.length;
    const shells: State[] = [];
    for (let stage = 0; stage < stages; stage += 1) {
      const shell = stages > 1 ? { ...fork(state), stdinFed: stage > 0 || state.stdinFed } : state;
      shells.push(shell);
      await this.command(pipeline.commands[stage], shell, { ...ctx, pipeline, stage });
    }
    if (stages > 1) {
      for (const shell of shells.slice(0, -1)) keepWrites(state, shell);
      meet(state, [shells[stages - 1]]);
      if (this.config.packs.has("database.redis") && scanDeletesKeys(pipeline))
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
      state.funcs.set(command.name, { defs: [{ body: command.body, src: ctx.src }], maybe: false });
      return this.command(command.body, fork(state), ctx);
    }
    for (const word of command.words) await this.substitutions(word.parts, state, ctx);
    const inner = command.kind === "subshell" ? fork(state) : state;
    const fed =
      command.redirects.some((r) => r.op === "<" || r.op === "<<" || r.op === "<<-" || r.op === "<<<") ||
      state.stdinFed;
    await this.bodies(command, inner, fed, { ...ctx, pipeline: null, stage: 0 });
    if (inner !== state) keepWrites(state, inner);
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

  /** The bodies of a compound command: a branch starts where its condition left the line, a loop body is read again, and what follows stands after any branch or none. */
  private async bodies(command: Compound, state: State, fed: boolean, ctx: Context): Promise<void> {
    if (command.kind === "arith") {
      for (const body of command.bodies) await this.nested(body, state, ctx);
      return;
    }
    const flow: State = { ...state, stdinFed: fed };
    const loops =
      command.kind === "while" || command.kind === "until" || command.kind === "for" || command.kind === "select";
    if (command.kind === "for" || command.kind === "select") this.unknown(flow, [literal(command.words[0]) ?? ""]);
    let skipped: State | null = null;
    let entered: State | null = null;
    const ends: State[] = [];
    for (const [index, body] of command.bodies.entries()) {
      const first = alwaysRuns(command, index);
      if (first || (command.kind === "if" && isCondition(command, index))) {
        await this.script(body, first ? flow : skipped!, ctx);
        const settled = this.settled();
        if (command.kind === "group" || command.kind === "subshell") continue;
        if (first) skipped = fork(flow);
        if (settled) {
          const [ok, failed] =
            command.kind === "until" ? [settled.failed, settled.succeeded] : [settled.succeeded, settled.failed];
          entered = ok;
          copyInto(skipped!, failed);
        } else entered = null;
        continue;
      }
      skipped ??= fork(flow);
      // a loop's next turn starts where this one ended: the body is read again from a state that leaves unknown what a turn changed
      let start: State | null = entered ?? skipped;
      entered = null;
      for (let turn = 0; turn < (loops ? MAX_TURNS : 1) && start; turn += 1) {
        const end = fork(start);
        await this.script(body, end, ctx);
        ends.push(end);
        start = loops ? widened(start, end) : null;
      }
    }
    const elseTaken = command.kind === "if" && command.bodies.length % 2 === 1;
    if (skipped && !elseTaken) ends.push(skipped);
    if (ends.length) {
      copyInto(flow, ends[0]);
      meet(flow, ends.slice(1));
    }
    state.cwd = flow.cwd;
    state.moved = flow.moved;
  }

  /** Where the condition list that just ran leaves the line when it succeeded and when it failed, as one state each; null for a single command. */
  private settled(): { succeeded: State; failed: State } | null {
    const outcome = this.outcome;
    this.outcome = null;
    if (!outcome) return null;
    const one = (states: State[]): State => {
      const merged = fork(states[0]);
      meet(merged, states.slice(1));
      return merged;
    };
    return { succeeded: one(outcome.succeeded), failed: one(outcome.failed) };
  }

  /** The command substitutions in some word parts, run first as the shell would; a `${x:=y}` or a `$((x=1))` sets a variable. */
  private async substitutions(parts: readonly Part[], state: State, ctx: Context): Promise<void> {
    for (const part of parts) {
      if (part.kind === "command" || part.kind === "process") await this.nested(part.script, state, ctx);
      else if (part.kind === "param" || part.kind === "arith") {
        for (const s of part.scripts) await this.nested(s, state, ctx);
        this.unknown(
          state,
          part.kind === "arith" ? arithTargets(part.raw) : [/^\$\{([A-Za-z_]\w*):?=/.exec(part.raw)?.[1] ?? ""],
        );
      }
    }
  }

  /** A script run in a shell of its own, as a command substitution is; the files it writes stay written. */
  private async nested(script: Script, state: State, ctx: Context): Promise<void> {
    const shell = fork(state);
    await this.script(script, shell, { ...ctx, pipeline: null, stage: 0, depth: ctx.depth + 1 });
    keepWrites(state, shell);
  }

  /** Variables whose value the line changed in a way the walk does not follow. */
  private unknown(state: State, names: readonly string[]): void {
    for (const name of names) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) state.vars.set(name, UNKNOWN);
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
      for (const assign of simple.assigns) state.vars.set(assign.name, this.assignedTo(assign, state));
      if (simple.redirects.length) await this.judge(this.scene(simple, invocationOf(simple), state, ctx), state, ctx);
      return;
    }
    const head = literal(simple.words[0]);
    const aliased = head === null ? undefined : state.aliases.get(head);
    if (aliased && !this.expanding.has(head!)) return this.expand(head!, aliased, simple, state, ctx);
    const call = invocationOf(simple);
    if (call.query) return;
    if (call.name === null && call.command) return this.dynamicCommand(simple, call, state, ctx);
    const scene = this.scene(simple, throughUnread(call), state, ctx);
    this.seenNames.add(scene.call.name ?? "");
    await this.builtins(scene, state, ctx);
    await this.judge(scene, state, ctx);
    await runners(this, scene, state, ctx);
    await this.call(scene, state, ctx);
  }

  /** An alias defined on the line, replaced by its text where it stands first, once; where the line may not have defined it, the command also stays as it is. */
  private async expand(name: string, bodies: string[], simple: Simple, state: State, ctx: Context): Promise<void> {
    const first = simple.words[0];
    const spelled = simple.end > simple.start;
    this.expanding.add(name);
    try {
      const ends: State[] = [];
      for (const body of bodies) {
        const line = spelled
          ? ctx.src.slice(simple.start, first.start) + body + ctx.src.slice(first.end, simple.end)
          : [body, ...simple.words.slice(1).map((w) => w.raw)].join(" ");
        const end = fork(state);
        await this.text(line, end, ctx.depth + 1);
        ends.push(end);
      }
      meet(state, ends);
    } finally {
      this.expanding.delete(name);
    }
  }

  /** A function the line defined, run where it is called: its folder and variable changes carry on; one the line may define two ways runs both. */
  private async call(scene: Scene, state: State, ctx: Context): Promise<void> {
    const head = literal(scene.simple.words[0]);
    const entry = head === null ? undefined : state.funcs.get(head);
    // a call from inside the function itself adds nothing the first reading did not show
    if (!entry || scene.call.wrappers.length || this.running.has(head!)) return;
    if (ctx.depth >= MAX_DEPTH || (this.calls += 1) > MAX_CALLS) {
      if (!this.callsCut) this.out.doubt("functions called more deeply or more often than the room reads", scene.text);
      this.callsCut = true;
      return;
    }
    const lone = entry.defs.length === 1 && !entry.maybe;
    const ends: State[] = [];
    this.running.add(head!);
    try {
      for (const def of entry.defs) {
        const shell = lone ? state : fork(state);
        await this.run(def, shell, ctx);
        ends.push(shell);
      }
    } finally {
      this.running.delete(head!);
    }
    if (!lone) meet(state, ends);
  }

  /** The body of a function in the folder and with the variables of its caller; what it declares `local` is gone when it returns. */
  private async run(def: Def, state: State, ctx: Context): Promise<void> {
    const frame = new Map<string, Variable | undefined>();
    this.frames.push(frame);
    try {
      await this.command(def.body, state, { ...ctx, src: def.src, pipeline: null, stage: 0, depth: ctx.depth + 1 });
    } finally {
      this.frames.pop();
      for (const [name, was] of frame) {
        if (was) state.vars.set(name, was);
        else state.vars.delete(name);
      }
    }
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

  /** What a plain assignment gives its variable; a list or an element is unknown, and so is an addition to a value not known. */
  private assignedTo(assign: Assignment, state: State): Variable {
    if (assign.items || assign.indexed) return UNKNOWN;
    const value = this.assigned(assign.value, state);
    if (!assign.append) return value;
    const had = state.vars.get(assign.name);
    return had?.value != null && value.value !== null ? { value: had.value + value.value, temp: false } : UNKNOWN;
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
      const text = target ? literal(target) : null;
      // a bare `pushd` swaps the two top folders and `pushd +1` rotates them: neither is a folder the line names
      if (!target) state.cwd = name === "cd" ? homeOf(this.known(state)) : null;
      else if (text === "-" || (name === "pushd" && /^[+-]\d+$/.test(text ?? ""))) state.cwd = null;
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
      const frame = name === "local" ? this.frames[this.frames.length - 1] : undefined;
      for (const word of args) {
        const text = literal(word);
        const m =
          text === null ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word.raw) : /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(text);
        if (!m) continue;
        if (frame && !frame.has(m[1])) frame.set(m[1], state.vars.get(m[1]));
        state.vars.set(m[1], this.assigned(valueWord(word, m[1].length + 1), state));
      }
    } else if (name === "unset") {
      const functions = args.some((w) => literal(w) === "-f");
      for (const word of args) {
        const text = literal(word) ?? "";
        if (text.startsWith("-")) continue;
        if (functions) state.funcs.delete(text);
        else state.vars.delete(text);
      }
    } else if (name === "alias") {
      for (const word of args) {
        const text = literal(word);
        const m = text ? /^([^=]+)=(.*)$/s.exec(text) : null;
        if (!m) continue;
        state.aliases.set(m[1], [m[2]]);
        await this.text(m[2], fork(state), ctx.depth + 1);
      }
    } else if (name === "unalias") {
      for (const word of args) {
        const text = literal(word) ?? "";
        if (text === "-a") state.aliases.clear();
        else state.aliases.delete(text);
      }
    } else if (
      name === "exec" &&
      !args.length &&
      scene.simple.redirects.some((r) => r.op === "<" && (r.fd === null || r.fd === "0"))
    )
      state.stdinFed = true;
    else this.unknown(state, assignedBy(name, args.map(literal)));
    this.noteWrites(scene, state);
  }

  /** The text of files this command writes from literals, for a shell or interpreter that runs them later; a `.gitattributes` that names a driver is a finding. */
  private noteWrites(scene: Scene, state: State): void {
    const known = this.known(state);
    for (const { target, text } of writtenTexts(scene, known, state.written)) {
      const at = valueOf(target, known);
      const path = absolute(at, state.cwd);
      if (path) state.written.set(path, text);
      const spelled = at.text ?? at.prefix;
      if (ATTRIBUTES_FILE.test(spelled) && namesDriver(text))
        this.out.add("room.guard", "git-attributes-driver", scene.text, spelled);
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
      for (const shell of outcome.shells) await this.text(shell, fork(state), ctx.depth + 1);
      for (const shell of this.gitPrograms(scene, state)) await this.text(shell, fork(state), ctx.depth + 1);
    }
    const guarded = guardedWrites(scene, (path) => this.tools.real(path));
    for (const { found, how } of guarded) this.out.add(found.pack, found.rule, scene.text, `${how} ${found.path}`);
    // a write the credential table holds is not also a redirect finding (DCG's order)
    const redirectsGuarded = guarded.some((g) => /^(>|>>|>\||&>|&>>)$/.test(g.how));
    for (const hit of fileRules(scene, this.tools)) {
      if (redirectsGuarded && hit.rule.startsWith("redirect-")) continue;
      this.out.add(hit.pack, hit.rule, scene.text, hit.detail);
    }
    const cli = cliWords(scene);
    if (cli) this.startsCli(scene, cli);
    else if (name === "ln" && this.linksCli(scene, state))
      this.out.add("room.guard", "paseo-cli", scene.text, "a link to the Paseo CLI");
    this.copies.note(scene);
    for (const hit of declaredHits(scene, this.config.packs)) this.out.add(hit.pack, hit.rule, scene.text);
    // files written earlier on the line are not read for a client, so its input stays unverified
    for (const hit of databaseHits(scene, this.config.packs, () => stdinText(scene, scene, NO_FILES)))
      this.out.add(hit.pack, hit.rule, scene.text);
    await execFlags(this, scene, state, ctx);
  }

  /** The programs git is given through its variables: the ones that name a program, and `GIT_CONFIG_KEY_n` and `_VALUE_n` pairs that set a key that does; one only known at run time is a finding. */
  private gitPrograms(scene: Scene, state: State): string[] {
    const known = this.known(state);
    const read = (name: string): string | null | undefined => {
      const assign = scene.call.assigns.findLast((a) => a.name === name);
      if (assign) return assign.value ? valueOf(assign.value, known).text : "";
      return state.vars.has(name) ? state.vars.get(name)!.value : undefined;
    };
    const out: string[] = [];
    const take = (value: string | null | undefined, name: string) => {
      if (value === null) this.out.add("room.guard", "git-config-exec", scene.text, name);
      else if (value) out.push(value.replace(/^!/, ""));
    };
    for (const name of PROGRAM_VARIABLES) take(read(name), name);
    for (let n = 0; n < MAX_PAIRS; n += 1) {
      const key = read(`GIT_CONFIG_KEY_${n}`);
      if (key === undefined) break;
      if (key === null || givesProgram(key)) take(read(`GIT_CONFIG_VALUE_${n}`) ?? null, key ?? `GIT_CONFIG_KEY_${n}`);
    }
    return out;
  }

  /** A start of the Paseo CLI: stopped when the words after it name a command. */
  private startsCli(scene: Scene, words: Word[]): void {
    const used = paseoCommand(words);
    if (used !== null) this.out.add("room.guard", "paseo-cli", scene.text, used);
  }

  /** Whether an `ln` makes a link to the Paseo CLI, whichever way the operand names it. */
  private linksCli(scene: Scene, state: State): boolean {
    const known = this.known(state);
    return scene.call.args.some((w) => {
      const value = valueOf(w, known);
      return (
        value.text !== null &&
        !value.text.startsWith("-") &&
        startsPaseo(value.text, absolute(value, state.cwd), (path) => this.tools.real(path))
      );
    });
  }

  private rmTools(): RmTools {
    return {
      ignored: (paths) => this.tools.ignored(paths),
      exempt: (rule, paths) => exempted(this.config.exempt[`core.filesystem:${rule}`], paths, this.place.home),
    };
  }
}

/** The variables an arithmetic expression assigns: `x = 1`, `x += 2`, `x++`, `--x`. */
function arithTargets(expression: string): string[] {
  const tokens = expression.match(/[A-Za-z_]\w*|\+\+|--|<<=|>>=|[-+*/%&|^]=|==|!=|<=|>=|=|\S/g) ?? [];
  const assigns = (token: string | undefined) =>
    token !== undefined && (token === "=" || /^(\+\+|--|[-+*/%&|^]=|<<=|>>=)$/.test(token));
  const out: string[] = [];
  tokens.forEach((token, i) => {
    if (/^[A-Za-z_]/.test(token) && assigns(tokens[i + 1])) out.push(token);
    else if ((token === "++" || token === "--") && /^[A-Za-z_]/.test(tokens[i + 1] ?? "")) out.push(tokens[i + 1]);
  });
  return out;
}

const ASSIGNING = new Set(["read", "mapfile", "readarray", "getopts", "printf", "let"]);

/** The variables a builtin sets besides the ones it is told to: what `read`, `mapfile`, `getopts`, `printf -v` and `let` fill. */
function assignedBy(name: string | null, texts: readonly (string | null)[]): string[] {
  if (!ASSIGNING.has(name ?? "")) return [];
  const operands: string[] = [];
  const valued = name === "read" ? "ptNdui" : name === "mapfile" || name === "readarray" ? "dnOsuCc" : "";
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i];
    if (text === null) continue;
    if (name === "printf") {
      if (text === "-v" && texts[i + 1]) return [texts[i + 1]!];
      continue;
    }
    if (name === "let") {
      operands.push(...arithTargets(text));
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      if (name === "read" && text.includes("a")) operands.push(texts[i + 1] ?? "");
      if (valued.includes(text[text.length - 1]) || (name === "read" && text.includes("a"))) i += 1;
      continue;
    }
    operands.push(text);
  }
  if (name === "read") return operands.length ? operands : ["REPLY"];
  if (name === "mapfile" || name === "readarray") return operands.length ? operands : ["MAPFILE"];
  if (name === "getopts") return [operands[1] ?? "", "OPTARG", "OPTIND"];
  return name === "let" ? operands : [];
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
    name === "paseo" ||
    SHELLS.has(name) ||
    DECLARED_COMMANDS.has(name) ||
    languageOf(name) !== null ||
    ["dd", "mv", "find", "unlink", "truncate", "shred", "tar", "rsync", "eval", "xargs"].includes(name)
  );
}

/** Whether a body of a compound command always runs before the one after it, so its `cd` carries on to that one. */
function alwaysRuns(command: Compound, index: number): boolean {
  const { kind } = command;
  if (kind === "group" || kind === "subshell") return true;
  return (kind === "while" || kind === "until" || kind === "if") && index === 0;
}

/** Whether a body of an `if` is a condition: they alternate with branches, and a last body with nothing to pair with is the `else`. */
function isCondition(command: Compound, index: number): boolean {
  const last = command.bodies.length - 1;
  return index % 2 === 0 && !(last % 2 === 0 && index === last);
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
