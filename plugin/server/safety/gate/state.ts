import type { Findings } from "./findings";
import type { Command, Pipeline, Simple, Word } from "./shell";
import type { Known, Variable } from "./types";

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

/** What the shell has been told so far on one line: folder, variables, functions, aliases, input, and files written from literals. */
export interface State {
  cwd: string | null;
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

/** Makes `base` stand for itself and the `others` at once, as after branches of which one ran: what they agree on is kept, the rest is unknown. */
export function meet(base: State, others: readonly State[]): void {
  if (!others.length) return;
  const all = [base, ...others];
  const split = others.some((s) => s.cwd !== base.cwd);
  if (split) base.cwd = null;
  base.moved = split || all.some((s) => s.moved);
  for (const name of new Set(all.flatMap((s) => [...s.vars.keys()])))
    if (!all.every((s) => sameVar(s.vars.get(name), base.vars.get(name)))) base.vars.set(name, UNKNOWN);
  for (const name of new Set(all.flatMap((s) => [...s.funcs.keys()]))) {
    const entries = all.map((s) => s.funcs.get(name));
    if (entries.every((e) => e === entries[0])) continue;
    const defs = [...new Set(entries.flatMap((e) => e?.defs ?? []))];
    base.funcs.set(name, { defs, maybe: entries.some((e) => !e || e.maybe) });
  }
  for (const name of new Set(all.flatMap((s) => [...s.aliases.keys()])))
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
  for (const [name, bodies] of a.aliases) if (bodies.join("\0") !== b.aliases.get(name)?.join("\0")) return false;
  return a.aliases.size === b.aliases.size;
}

/** The state a loop's next turn may start in, given where a turn began and where it ended; null when the turn changed nothing that was still known. */
export function widened(start: State, end: State): State | null {
  const wide = fork(start);
  meet(wide, [end]);
  return stable(wide, start) ? null : wide;
}

/** A word made up by the walk, as if the line had spelled it. */
export const word = (text: string): Word => ({
  raw: text,
  start: 0,
  end: 0,
  parts: [{ kind: "text", text, quote: "none" }],
});

/** A word only known at run time: the input xargs feeds, the `{}` of find -exec. */
export const dynamicWord = (): Word => ({
  raw: "{}",
  start: 0,
  end: 0,
  parts: [{ kind: "param", name: "", raw: "${input}", quoted: false, scripts: [] }],
});
