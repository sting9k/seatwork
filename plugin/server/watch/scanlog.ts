import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuleId } from "./rules";

/** One line per turn end, and per earlier scan that found or asked something: the calibration's input. */
export interface ScanRecord {
  at: string;
  seat: string;
  role: string;
  parent: string | null;
  turn: string | null;
  moment: "start" | "live" | "end";
  rev: number;
  signal?: string;
  tests: string;
  statics: string;
  reads?: number;
  ran?: "passed" | "failed" | "unknown";
  findings: ScanFinding[];
  engine?: { ok: true; model: string; tokens: number; ms: number; cached?: true; skipped?: RuleId[] } | { ok: false; reason: string };
  mail?: string;
}

/** One finding of a scan: `raised` was mailed to the seat above, `logged` kept here only, `held` came after the turn's one mail. */
export interface ScanFinding {
  rule: RuleId;
  key: string;
  by: "facts" | "model";
  score?: number;
  evidence: string;
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
