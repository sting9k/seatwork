import type { Findings } from "./findings";
import type { Command, Pipeline, Simple, Word } from "./shell";
import type { Known, Value, Variable } from "./types";

/** A function the line defined: its body, and the text the body's positions point into. */
export interface Def {
  body: Command;
  src: string;
}

/** The definitions a function name may have where branches of the line disagree, and whether it may be undefined. */
export interface Defs {
  defs: Def[];
  maybe: boolean;
}

/** What the shell has been told so far on one line; `failedCwd` is where a cd into a folder not there leaves it. */
export interface State {
  cwd: string | null;
  failedCwd?: string | null;
  moved: boolean;
  vars: Map<string, Variable>;
  funcs: Map<string, Defs>;
  aliases: Map<string, string[]>;
  stdinFed: boolean;
  written: Map<string, string>;
}

/** Where the walk stands in a line: its pipeline and stage, the source text, the nesting depth. */
export interface Context {
  pipeline: Pipeline | null;
  stage: number;
  src: string;
  depth: number;
}

/** What the readers of nested programs call back into the walk for. */
export interface Reader {
  readonly out: Findings;
  text(src: string, state: State, depth: number): Promise<void>;
  simple(simple: Simple, state: State, ctx: Context): Promise<void>;
  known(state: State): Known;
  changed(path: string): Promise<string | null>;
  real(path: string): string | null;
  file(path: string): string | null;
  changesOf(src: string, state: State, depth: number): Promise<boolean>;
  noteChange(value: Value | null, known: Known): void;
}

export const UNKNOWN: Variable = { value: null, temp: false };

/** A fresh state for a line that starts in `cwd`. */
export const startState = (cwd: string | null): State => ({
  cwd,
  moved: false,
  vars: new Map(),
  funcs: new Map(),
  aliases: new Map(),
  stdinFed: false,
  written: new Map(),
});

/** A copy of the state that a subshell or a pipeline stage may change without touching the line's own. */
export const fork = (state: State): State => ({
  ...state,
  vars: new Map(state.vars),
  funcs: new Map(state.funcs),
  aliases: new Map(state.aliases),
  written: new Map(state.written),
});

const sameVar = (a: Variable | undefined, b: Variable | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.value === b.value && a.temp === b.temp);

const identical = (a: unknown, b: unknown): boolean => a === b;

/** The names one table does not hold alike in every state; a state that lacks a name disagrees with one that has it. */
function disagreeing<V>(
  states: readonly State[],
  table: (state: State) => ReadonlyMap<string, V>,
  same: (a: V | undefined, b: V | undefined) => boolean,
): string[] {
  const [first, ...rest] = states.map(table);
  const names: string[] = [];
  for (const [name, entry] of first)
    for (const other of rest)
      if (!same(other.get(name), entry)) {
        names.push(name);
        break;
      }
  const added = new Set<string>();
  for (const other of rest) for (const name of other.keys()) if (!first.has(name)) added.add(name);
  return [...names, ...added];
}

/** Makes `base` stand for itself and the `others` at once, as after branches of which one ran: what they agree on is kept, the rest is unknown. */
export function meet(base: State, others: readonly State[]): void {
  if (!others.length) return;
  const all = [base, ...others];
  const split = others.some((s) => s.cwd !== base.cwd);
  if (split) base.cwd = null;
  base.moved = split || all.some((s) => s.moved);
  for (const name of disagreeing(all, (s) => s.vars, sameVar)) base.vars.set(name, UNKNOWN);
  for (const name of disagreeing(all, (s) => s.funcs, identical)) {
    const entries = all.map((s) => s.funcs.get(name));
    const defs = [...new Set(entries.flatMap((e) => e?.defs ?? []))];
    base.funcs.set(name, { defs, maybe: entries.some((e) => !e || e.maybe) });
  }
  for (const name of disagreeing(all, (s) => s.aliases, identical))
    base.aliases.set(name, [...new Set(all.flatMap((s) => s.aliases.get(name) ?? []))]);
  for (const other of others) keepWrites(base, other);
}

/** Notes in `into` the files a fork wrote: a file written in a subshell or a pipeline stage is on disk all the same. */
export function keepWrites(into: State, from: State): void {
  for (const [path, text] of from.written) {
    const had = into.written.get(path);
    if (had === undefined) into.written.set(path, text);
    else if (!had.includes(text)) into.written.set(path, `${had}\n${text}`);
  }
}

/** Makes `target` hold what `source` holds, in place, so every holder of its tables sees it. */
export function copyInto(target: State, source: State): void {
  target.cwd = source.cwd;
  target.moved = source.moved;
  for (const key of ["vars", "funcs", "aliases", "written"] as const) {
    const from = source[key] as Map<string, unknown>;
    const to = target[key] as Map<string, unknown>;
    if (from === to) continue;
    to.clear();
    for (const [name, value] of from) to.set(name, value);
  }
}

/** Whether two states agree on folder, variables, functions and aliases. */
function stable(a: State, b: State): boolean {
  if (a.cwd !== b.cwd || a.vars.size !== b.vars.size || a.funcs.size !== b.funcs.size) return false;
  for (const [name, value] of a.vars) if (!sameVar(value, b.vars.get(name))) return false;
  for (const [name, entry] of a.funcs) if (entry !== b.funcs.get(name)) return false;
  for (const [name, bodies] of a.aliases) {
    const other = b.aliases.get(name);
    if (bodies !== other && bodies.join("\0") !== other?.join("\0")) return false;
  }
  return a.aliases.size === b.aliases.size;
}

/** The state a loop's next turn may start in, given where a turn began and where it ended; null when the turn changed nothing that was still known. */
export function widened(start: State, end: State): State | null {
  const wide = fork(start);
  meet(wide, [end]);
  return stable(wide, start) ? null : wide;
}

/** A word only known at run time: the input xargs feeds, the `{}` of find -exec, which lies in the folder find starts from. */
export const dynamicWord = (folder?: string): Word => ({
  raw: "{}",
  start: 0,
  end: 0,
  parts: [
    ...(folder ? [{ kind: "text" as const, text: `${folder.replace(/\/+$/, "")}/`, quote: "single" as const }] : []),
    { kind: "param", name: "", raw: "${input}", quoted: false, scripts: [] },
  ],
});
