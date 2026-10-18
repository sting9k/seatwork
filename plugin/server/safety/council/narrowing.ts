import council from "../../../shared/safety/council.json";
import { redact } from "../../redact";
import type { GamingFile } from "./gaming";

/** What a hand-in's diff shows of an outcome narrowed to win a number: code lines that guarded a case, a check or precision, removed and not put back, and the report's claims of a gain. */

const GUARD = new RegExp(council.members.narrowing.guard);
const CLAIM = new RegExp(council.members.narrowing.claim, "i");
const EXCERPT_CHARS = council.members.narrowing.excerptChars;
const FILES_SHOWN = 10;
const CLAIMS_SHOWN = 3;

/** The guard lines that left the code: how many, in which files, and the lines a juror reads, secrets hidden. */
export interface NarrowingEvidence {
  removed: number;
  files: string[];
  excerpt: string;
}

/** The lines of `from` with one copy of each line of `less` taken out, compared trimmed. */
function without(from: readonly string[], less: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const line of less) left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1);
  return from.filter((line) => {
    const same = left.get(line.trim()) ?? 0;
    if (same > 0) left.set(line.trim(), same - 1);
    return same === 0;
  });
}

/** The guard lines the code files of a diff lost on balance, a line moved counting as kept; null when none. */
export function narrowingOf(files: readonly GamingFile[]): NarrowingEvidence | null {
  const evidence: NarrowingEvidence = { removed: 0, files: [], excerpt: "" };
  const lines: string[] = [];
  for (const file of files) {
    if (file.test) continue;
    const gone = without(file.removed, file.added).filter((line) => GUARD.test(line));
    const come = without(file.added, file.removed).filter((line) => GUARD.test(line));
    const net = gone.length - come.length;
    if (net <= 0) continue;
    evidence.removed += net;
    if (evidence.files.length < FILES_SHOWN) evidence.files.push(file.path);
    lines.push(`${file.path}:`, ...gone.map((line) => `- ${line.trim().slice(0, 200)}`));
  }
  if (evidence.removed === 0) return null;
  evidence.excerpt = redact(lines.join("\n")).slice(0, EXCERPT_CHARS);
  return evidence;
}

/** The lines of a report that claim a gain: faster, smaller, fewer, a number with a unit. */
export const gainsIn = (report: string): string[] =>
  report
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CLAIM.test(line))
    .slice(0, CLAIMS_SHOWN);
