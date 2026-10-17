import type { Invocation } from "./normalize";
import type { Pipeline, Simple, Word } from "./shell";

/** What the gate reads and returns, shared by its parts. */

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** What a command did that the guard keeps: its effect and the place or name it is kept under (`effect:rule`), how grave it is, why, and the command text it was found in as written. */
export interface Finding {
  effect: string;
  rule: string;
  severity: Severity;
  reason: string;
  text: string;
}

/** Something the gate could not finish reading. */
export interface Doubt {
  reason: string;
  text: string;
}

/** The machine around a command: the seat's temp and start folders, the room's files no seat writes (save `except`) and the secrets none reads, its folder in each project, and the daemon's address. */
export interface Place {
  home: string;
  project: string | null;
  tmp: string | null;
  start: string | null;
  guard: { paths: string[]; except: string[]; secrets?: readonly string[] } | null;
  roomFolder: string | null;
  daemon?: string | null;
}

/** A shell variable the walk knows; `temp` when its value came from `mktemp`. */
export interface Variable {
  value: string | null;
  temp: boolean;
}

/** One simple command as the gate judges it; `moved` is set once a `cd` on the line left the folder it started in. */
export interface Scene {
  simple: Simple;
  call: Invocation;
  text: string;
  cwd: string | null;
  moved: boolean;
  stdinFed: boolean;
  pipeline: Pipeline | null;
  stage: number;
  place: Place;
  vars: ReadonlyMap<string, Variable>;
}

/** What a word's value depends on besides its text: the variables set so far, the machine, the folder. */
export type Known = Pick<Scene, "vars" | "place" | "cwd">;

/** A word's value as far as the gate knows it before the shell runs; `text` is null when part of it waits for run time, `prefix` is what precedes that part. */
export interface Value {
  text: string | null;
  prefix: string;
  quoted: boolean;
  glob: boolean;
  temp: boolean;
  word: Word;
}
