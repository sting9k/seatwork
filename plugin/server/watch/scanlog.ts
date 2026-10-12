import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuleId } from "./rules";

/** One line per turn end, and per earlier scan that found or asked something: what the calibration is computed from. */
export interface ScanRecord {
  at: string;
  seat: string;
  role: string;
  parent: string | null;
  turn: string | null;
  moment: "start" | "live" | "end";
  /** Revision of the question catalogue the scores were given under. */
  rev: number;
  signal?: string;
  tests: string;
  statics: string;
  /** How often this turn has been read so far, this record included; a quiet read writes no line of its own. */
  reads?: number;
  /** At a turn's end: what the first test the seat ran in that turn said. */
  ran?: "passed" | "failed" | "unknown";
  findings: ScanFinding[];
  /** `skipped`: rules whose question was left out because the message was too long to send what they read. */
  engine?: { ok: true; model: string; tokens: number; ms: number; cached?: true; skipped?: RuleId[] } | { ok: false; reason: string };
  mail?: string;
}

export interface ScanFinding {
  rule: RuleId;
  key: string;
  by: "facts" | "model";
  /** For a model's reading: the probability of the flagged option. */
  score?: number;
  evidence: string;
  /** raised: mailed to the seat above; logged: kept here only; held: one mail per turn was already sent. */
  outcome: "raised" | "logged" | "held";
}

export class ScanLog {
  constructor(private readonly file: string) {}

  append(record: ScanRecord): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
  }

  read(): ScanRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ScanRecord];
        } catch {
          return [];
        }
      });
  }
}
