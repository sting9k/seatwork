import { posix } from "node:path";
import { deletesScannedKeys, dropsData, NAMED_PROGRAMS, namedHits } from "./commands";
import { forkBomb, judgeFiles, type FileTools, writesOf } from "./effects";
import { languageOf } from "./embedded";
import { Findings } from "./findings";
import { baseName, invocationOf, valueWord, type Invocation } from "./normalize";
import { absolute, homeOf, isTemp, substitution, valueOf, within } from "./paths";
import { whereOfPath } from "./places";
import { SHELLS, stdinText } from "./programs";
import { gitEffects, givesProgram, PROGRAM_VARIABLES, type GitTools } from "./rules/git";
import { namesDriver, ATTRIBUTES_FILE } from "./rules/attributes";
import { rewritesTree } from "./rules/rewriters";
import { cliWords, namesPaseo, paseoCommand, reachesDaemon, startsPaseo } from "./rules/paseo";
import { namesSecret, readsFolders, secretAt } from "./rules/secrets";
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
  type Defs,
} from "./state";
import type { Doubt, Finding, Known, Place, Scene, Value, Variable } from "./types";

/** Walks a command line as the shell would, and keeps what each command it runs does. */

/** What the reading asks of the machine: git, the file system, the files the room's seats changed, a small file as it stands, and the real file a command word runs. */
export interface Tools extends GitTools, FileTools {
  changed(path: string): Promise<string | null>;
  file?(path: string): string | null;
  folder?(path: string): boolean;
  rc?(): Rc | null;
  program?(word: string, cwd: string | null, path: string | null): string | null;
}

/** The aliases and the text of the functions a seat's shell starts with, from the user's rc. */
export interface Rc {
  aliases: ReadonlyMap<string, string>;
  functions: string;
}

const seededTables = new WeakMap<Rc, { aliases: Map<string, string[]>; funcs: Map<string, Defs> }>();

/** The limits on reading a line: its time and its size. */
export interface GateConfig {
  budgetMs: number;
  maxBytes: number;
}

/** What a line did that the guard keeps, what the gate could not read, whether the line writes or removes a file of the seat's tree, and the git command in it that moves that tree's HEAD or stash for every seat in it. */
export interface Evaluation {
  findings: Finding[];
  doubts: Doubt[];
  changes: boolean;
  moves?: string | null;
}

const MAX_DEPTH = 8;
const MAX_CALLS = 500;
const MAX_TURNS = 3;
const MAX_PAIRS = 32;
const NO_FILES: ReadonlyMap<string, string> = new Map();
const RISKY =
  /\b(rm|git|dd|mkfs|diskutil|shred|truncate|find|mv|chmod|chown|curl|wget|sudo|eval|sh|bash|zsh|python\d*|node|perl|ruby|php|kubectl|terraform|docker)\b|>/;

/** Everything a command line does that the guard keeps, and every part of it the gate could not read. */
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
  const start = startState(cwd);
  const rc = tools.rc?.() ?? null;
  if (rc) await seed(start, rc, place, config, tools);
  await walk.text(command, start, 0);
  walk.finish();
  return walk.result();
}

/** A line's start with the aliases and functions of the user's rc: what they run is judged where the line calls them. */
async function seed(state: State, rc: Rc, place: Place, config: GateConfig, tools: Tools): Promise<void> {
  let seeded = seededTables.get(rc);
  if (!seeded) {
    // read apart: a line of the rc the room cannot parse is no doubt about the seat's command
    const scratch = startState(null);
    await new Walk(place, config, { ...tools, rc: undefined }, Date.now() + config.budgetMs).text(
      rc.functions,
      scratch,
      0,
    );
    const aliases = new Map([...rc.aliases].map(([name, value]): [string, string[]] => [name, [value]]));
    seeded = { aliases, funcs: scratch.funcs };
    seededTables.set(rc, seeded);
  }
  state.aliases = new Map(seeded.aliases);
  state.funcs = new Map(seeded.funcs);
}

/** Whether a glob of the shell's would name a path: `*` and `?` within one folder, a class as written. */
function globMatches(glob: string, path: string): boolean {
  const source = glob
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  try {
    return new RegExp(`^${source}$`).test(path);
  } catch {
    return false;
  }
}

/** One evaluation: reads the line, keeps the state the shell would, and judges each simple command. */
class Walk implements Reader {
  readonly out = new Findings();
  private readonly seenNames = new Set<string>();
  private readonly bombs = new Map<string, string>();
  private readonly frames: Map<string, Variable | undefined>[] = [];
  private readonly expanding = new Set<string>();
  private readonly running = new Set<string>();
  private outcome: { succeeded: State[]; failed: State[] } | null = null;
  private calls = 0;
  private callsCut = false;
  private outOfTime = false;
  private changes = false;
  private moves: string | null = null;

  constructor(
    private readonly place: Place,
    private readonly config: GateConfig,
    private readonly tools: Tools,
    private readonly deadline: number,
  ) {}

  result(): Evaluation {
    return { findings: this.out.found, doubts: this.out.doubts, changes: this.changes, moves: this.moves };
  }

  /** Notes a file the line writes or removes in the seat's tree, outside the room's folder and git's; null is a program's write whose path waits for run time, counted where the program runs. */
  noteChange(value: Value | null, known: Known): void {
    if (this.changes || (value && isTemp(value, known))) return;
    const spelled = value ? (value.text ?? value.prefix) : "";
    if (spelled.startsWith("~")) return;
    const path = spelled.startsWith("/") ? posix.normalize(spelled) : known.cwd ? posix.join(known.cwd, spelled) : null;
    const parts = path?.split("/") ?? [];
    if (!path || parts.includes(".git") || (this.place.roomFolder !== null && parts.includes(this.place.roomFolder)))
      return;
    this.changes = [this.place.project, this.place.start].some((root) => root !== null && within(path, root));
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

  file(path: string): string | null {
    return this.tools.file?.(path) ?? null;
  }

  /** Whether a line rewrites the seat's tree, read on a walk of its own: what it trips is not this line's. */
  async changesOf(src: string, state: State, depth: number): Promise<boolean> {
    const apart = new Walk(this.place, this.config, this.tools, this.deadline);
    await apart.text(src, state, depth);
    return apart.result().changes;
  }

  /** What the whole line showed once it is read: a fork bomb that is defined and then called. */
  finish(): void {
    for (const [name, text] of this.bombs) if (this.seenNames.has(name)) this.out.named("machine:fork-bomb", text);
  }

  private async script(script: Script, state: State, ctx: Context): Promise<void> {
    for (const sequence of script) await this.sequence(sequence, state, ctx);
  }

  /** The state of a pipeline that failed: where a cd that failed left the shell; the state itself when nothing in it can fail that way. */
  private failure(state: State): State {
    if (state.failedCwd === undefined) return state;
    const failed = fork(state);
    failed.cwd = state.failedCwd;
    failed.moved = failed.cwd !== this.place.start;
    state.failedCwd = failed.failedCwd = undefined;
    return failed;
  }

  /** Pipelines joined by `&&` and `||`: each later one runs only where the ones before let it, and what follows may stand after any of them. */
  private async sequence(sequence: Sequence, state: State, ctx: Context): Promise<void> {
    const { pipelines, ops } = sequence;
    const own = sequence.background ? fork(state) : state;
    await this.pipeline(pipelines[0], own, ctx);
    this.outcome = null;
    const firstFailed = this.failure(own);
    if (ops.length) {
      const first = fork(own);
      let succeeded = [first];
      let failed = [firstFailed === own ? first : firstFailed];
      for (let i = 1; i < pipelines.length; i += 1) {
        const and = ops[i - 1] === "&&";
        const from = and ? succeeded : failed;
        const here = fork(from[0]);
        meet(here, from.slice(1));
        await this.pipeline(pipelines[i], here, ctx);
        const bad = this.failure(here);
        if (and) {
          succeeded = [here];
          failed.push(bad);
        } else {
          succeeded.push(here);
          failed = [bad];
        }
      }
      const ends = [...new Set([...succeeded, ...failed])];
      copyInto(own, ends[0]);
      meet(own, ends.slice(1));
      this.outcome = { succeeded, failed };
    } else if (firstFailed !== own) meet(own, [firstFailed]);
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
      if (deletesScannedKeys(pipeline)) this.out.named("remote:data", ctx.src.slice(0, 200));
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

  /** The bodies of a compound command: a branch starts where its condition left the line, and a loop body is read again. */
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
    const through = throughUnread(call);
    // behind a wrapper, a word known only at run time may be the program itself
    const hidden = through === call && call.unread ? call.args.findIndex((w) => literal(w) === null) : -1;
    if (hidden >= 0)
      await this.dynamicCommand(
        simple,
        { ...call, name: null, command: call.args[hidden], args: call.args.slice(hidden + 1) },
        state,
        ctx,
      );
    const scene = this.scene(simple, this.named(through, state), state, ctx);
    this.seenNames.add(scene.call.name ?? "");
    await this.builtins(scene, state, ctx);
    await this.judge(scene, state, ctx);
    await runners(this, scene, state, ctx);
    await this.call(scene, state, ctx);
  }

  /** An alias on the line, replaced once by its text where it heads a command; where the line may not have defined it, the command also stays as written. */
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

  /** A command word only known at run time: read again when variables settle it, else read as the rm it may be. */
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
    await judgeFiles({ ...scene, call: { ...scene.call, name: "rm" } }, this.tools, this.out);
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
      else {
        const to = absolute(valueOf(target, this.known(state)), state.cwd);
        // a cd into a folder that is not there fails and leaves the shell where it was
        if (to && this.tools.folder && !this.tools.folder(to)) state.failedCwd = state.cwd;
        state.cwd = to;
      }
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

  /** The text of files this command writes from literals; a `.gitattributes` that names a driver is a finding, and one written with text the room cannot read a doubt. */
  private noteWrites(scene: Scene, state: State): void {
    const known = this.known(state);
    const read = new Set<string>();
    for (const { target, text } of writtenTexts(scene, known, state.written)) {
      const at = valueOf(target, known);
      const path = absolute(at, state.cwd);
      if (path) state.written.set(path, text);
      const spelled = at.text ?? at.prefix;
      read.add(spelled);
      if (ATTRIBUTES_FILE.test(spelled) && namesDriver(text))
        this.out.named("room:attributes-driver", scene.text, spelled);
    }
    for (const write of writesOf(scene)) {
      this.noteChange(write.value, scene);
      const spelled = write.value.text ?? write.value.prefix;
      if (write.mode !== "remove" && ATTRIBUTES_FILE.test(spelled) && !read.has(spelled))
        this.out.doubt(
          `${write.how} writes ${spelled} with lines the room cannot read; write it with the file tool`,
          scene.text,
        );
    }
  }

  /** Everything one command does that the guard keeps: to files, to git, to the room's controls, and by the named rules. */
  private async judge(scene: Scene, state: State, ctx: Context): Promise<void> {
    const name = scene.call.name;
    if (name === "rm" || name === "rimraf" || name === "grm")
      for (const word of scene.call.args)
        if (!literal(word)?.startsWith("-")) this.noteChange(valueOf(word, scene), scene);
    if (name === "git" || name?.startsWith("git-")) {
      const outcome = await gitEffects(scene, this.tools);
      const repo = outcome.repo === null ? "outside" : whereOfPath(outcome.repo, this.place);
      for (const hit of outcome.hits)
        if ("id" in hit) this.out.named(hit.id, scene.text, hit.detail);
        else this.out.effect(hit.effect, repo, scene.text, hit.detail);
      for (const doubt of outcome.doubts) this.out.doubt(doubt, scene.text);
      if (outcome.changes) this.noteChange(null, { ...this.known(state), cwd: outcome.changes });
      if (
        outcome.moves &&
        [this.place.project, this.place.start].some((root) => root !== null && within(outcome.moves!, root))
      )
        this.moves ??= scene.text;
      for (const shell of outcome.shells) await this.text(shell, fork(state), ctx.depth + 1);
      for (const shell of this.gitPrograms(scene, state)) await this.text(shell, fork(state), ctx.depth + 1);
    }
    if (rewritesTree(scene)) this.noteChange(null, scene);
    await judgeFiles(scene, this.tools, this.out);
    const cli = cliWords(scene);
    if (cli) this.startsCli(scene, cli);
    else if (name === "ln" && this.linksCli(scene, state))
      this.out.named("room:paseo-cli", scene.text, "a link to the Paseo CLI");
    const reach = reachesDaemon(this.spelled(scene, state), this.place);
    if (reach) this.out.named("room:paseo-daemon", scene.text, reach);
    const secret = this.secretRead(scene, state);
    if (secret) this.out.effect("read", "room", scene.text, secret);
    for (const id of namedHits(scene)) this.out.named(id, scene.text);
    // files written earlier on the line are not read for a client, so only text the line shows counts
    if (dropsData(scene, () => stdinText(scene, scene, NO_FILES))) this.out.named("remote:data", scene.text);
    await execFlags(this, scene, state, ctx);
  }

  /** The programs git is given through its variables and `GIT_CONFIG_KEY_n`/`_VALUE_n` pairs; one only known at run time is a finding. */
  private gitPrograms(scene: Scene, state: State): string[] {
    const known = this.known(state);
    const read = (name: string): string | null | undefined => {
      const assign = scene.call.assigns.findLast((a) => a.name === name);
      if (assign) return assign.value ? valueOf(assign.value, known).text : "";
      return state.vars.has(name) ? state.vars.get(name)!.value : undefined;
    };
    const out: string[] = [];
    const take = (value: string | null | undefined, name: string) => {
      if (value === null) this.out.named("room:git-config-exec", scene.text, name);
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

  /** A command under another name, a link by path or on PATH, read as the program it runs when a rule reads that one. */
  private named(call: Invocation, state: State): Invocation {
    if (!call.name || !call.command || !this.tools.program || knownCommand(call.name) || state.funcs.has(call.name))
      return call;
    const word = valueOf(call.command, this.known(state)).text;
    const target = word ? this.tools.program(word, state.cwd, state.vars.get("PATH")?.value ?? null) : null;
    if (!target) return call;
    const name = namesPaseo(target) ? "paseo" : baseName(target);
    return name !== call.name && knownCommand(name) ? { ...call, name } : call;
  }

  /** A command as written and with the values its words are known to have, redirects included. */
  private spelled(scene: Scene, state: State): string {
    const known = this.known(state);
    const words = [scene.call.command, ...scene.call.args, ...scene.simple.redirects.map((r) => r.target)];
    return [scene.text, ...words.map((word) => (word ? (valueOf(word, known).text ?? "") : ""))].join("\n");
  }

  /** The secret a command reads: one a word or a redirect names as a path, a glob may match or a folder read whole holds, or one its line spells; null for none. */
  private secretRead(scene: Scene, state: State): string | null {
    const secrets = this.place.guard?.secrets;
    if (!secrets?.length) return null;
    const known = this.known(state);
    const values = scene.call.args.map((word) => valueOf(word, known));
    const sources = readsFolders(
      scene.call.name,
      values.map((value) => value.text),
    );
    const targets = scene.simple.redirects.flatMap((r) => (r.target ? [valueOf(r.target, known)] : []));
    for (const [at, value] of [...values, ...targets].entries()) {
      const path = absolute(value, state.cwd);
      if (!path) continue;
      const found = value.glob
        ? secrets.find((s) => (s.endsWith("/") && `${path}/`.startsWith(s)) || globMatches(path, s.replace(/\/$/, "")))
        : secretAt(path, secrets, at < values.length && sources(at));
      if (found) return found;
    }
    return namesSecret(this.spelled(scene, state), secrets, this.place.home);
  }

  /** A start of the Paseo CLI: caught when the words after it name a command. */
  private startsCli(scene: Scene, words: Word[]): void {
    const used = paseoCommand(words);
    if (used !== null) this.out.named("room:paseo-cli", scene.text, used);
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
    NAMED_PROGRAMS.has(name) ||
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
