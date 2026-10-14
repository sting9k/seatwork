import type { Findings } from "./findings";
import type { Pipeline, Simple, Word } from "./shell";
import type { Known, Variable } from "./types";

/** What the shell has been told so far on one line: folder, variables, input, and files written from literals. */
export interface State {
  cwd: string | null;
  moved: boolean;
  vars: Map<string, Variable>;
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
}

/** A copy of the state that a subshell or a pipeline stage may change without touching the line's own. */
export const fork = (state: State): State => ({ ...state, vars: new Map(state.vars), written: new Map(state.written) });

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
