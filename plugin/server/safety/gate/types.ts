import type { Invocation } from "./normalize";
import type { Pipeline, Simple, Word } from "./shell";

/** What the gate reads and returns, shared by its parts. */

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface Finding {
  pack: string;
  rule: string;
  severity: Severity;
  reason: string;
  explanation?: string;
  safer?: string[];
  /** the command it was found in, as written */
  text: string;
}

/** Something the gate could not finish reading; never an allow. */
export interface Doubt {
  reason: string;
  text: string;
}

/** The machine around a command: who runs it, where, and what the shell has been told so far. */
export interface Place {
  home: string;
  project: string | null;
  /** the seat's own temporary folder, set by the room */
  tmp: string | null;
  /** where the seat's agent started the command */
  start: string | null;
  /** the room's own files: no seat writes them, save the folders in `except` */
  guard: { paths: string[]; except: string[] } | null;
  /** the room's folder inside each project (`.seatwork`) */
  roomFolder: string | null;
}

export interface Variable {
  value: string | null;
  /** the value came from `mktemp`: a fresh temporary path */
  temp: boolean;
}

/** One simple command as the gate judges it, with the shell state at that point. */
export interface Scene {
  simple: Simple;
  call: Invocation;
  text: string;
  cwd: string | null;
  /** a `cd` earlier in the line moved away from where the command started */
  moved: boolean;
  stdinFed: boolean;
  pipeline: Pipeline | null;
  stage: number;
  place: Place;
  vars: ReadonlyMap<string, Variable>;
}

/** A word's value as far as the gate can know it before the shell runs. */
export interface Value {
  /** the whole text, or null when a part is only known at run time */
  text: string | null;
  /** the text up to the first unknown part */
  prefix: string;
  quoted: boolean;
  glob: boolean;
  /** an unknown part is a fresh temporary path (`$(mktemp -d)`) */
  temp: boolean;
  word: Word;
}
