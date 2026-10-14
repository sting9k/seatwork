import type { Invocation } from "./normalize";
import type { Pipeline, Simple, Word } from "./shell";

/** What the gate reads and returns, shared by its parts. */

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** A rule that holds for a command, with the words the seat reads and the command text it was found in as written. */
export interface Finding {
  pack: string;
  rule: string;
  severity: Severity;
  reason: string;
  explanation?: string;
  safer?: string[];
  text: string;
}

/** Something the gate could not finish reading; never an allow. */
export interface Doubt {
  reason: string;
  text: string;
}

/** The machine around a command: the seat's own temp folder, where its agent began it, the room's own files no seat writes (save `except`), and the room's folder in each project. */
export interface Place {
  home: string;
  project: string | null;
  tmp: string | null;
  start: string | null;
  guard: { paths: string[]; except: string[] } | null;
  roomFolder: string | null;
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

/** A word's value as far as the gate knows it before the shell runs: `text` is null when part of it is known only at run time, `prefix` is what comes before that part. */
export interface Value {
  text: string | null;
  prefix: string;
  quoted: boolean;
  glob: boolean;
  temp: boolean;
  word: Word;
}
