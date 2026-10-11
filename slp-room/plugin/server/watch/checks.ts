import { effectsOf, type CheckKind, type EffectContext } from "./effects";
import type { ShellEvent } from "./events";
import { failureSignature } from "./repeat";
import { statusCovers, type ShellLine } from "./shell";

/**
 * Whether a check passed. The line's exit status answers only where the check's own status reaches it;
 * otherwise the runner's summary is read, and what neither settles stays unknown.
 */

export type CheckResult = "passed" | "failed" | "unknown";

export interface CheckRun {
  /** The event's sequence number, plus the command's place in its line as the fraction. */
  at: number;
  label: string;
  what: CheckKind | "named";
  result: CheckResult;
  /** For a failure: what it printed, reduced so the same failure gives the same value. */
  signature?: string;
}

/** Lines only a failing run prints; "0 failed" is a pass line. */
const FAILED: readonly RegExp[] = [
  /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing|failures?|errors?|errored)\b/i,
  /\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]/i,
  /^\s*(?:not ok\b|FAIL(?:ED)?\b|--- FAIL\b|✖|✗|×)/m,
  /^\s*(?:#|ℹ)\s*fail\s+[1-9]/m,
  /\bTests?(?: Files| Suites)?:?\s+(?:\d+ \w+[,|] )*[1-9]\d* failed\b/i,
  /\btest result: FAILED\b/,
  /\berror TS\d+\b/,
  /\berror(?:\[E\d+\])?: /,
  /\bTraceback \(most recent call last\)/,
  /\b(?:AssertionError|SyntaxError|TypeError|ReferenceError)\b/,
  /\bnpm ERR!|\bELIFECYCLE\b/,
  /\bBUILD FAILED\b|\bCompilation failed\b/i,
];

/** Read only when no failure line is present. */
const PASSED: readonly RegExp[] = [
  /\b[1-9]\d*\s+(?:tests?\s+)?(?:passed|passing)\b/i,
  /^\s*(?:#|ℹ)\s*pass\s+[1-9]/m,
  /\bTests?(?: Files| Suites)?:?\s+[1-9]\d* passed\b/i,
  /^ok\s+\S+/m,
  /\btest result: ok\b/,
  /^\s*(?:PASS\b|✓|✔)/m,
  /\b(?:0 errors?|no (?:errors|issues|problems) found|All checks passed)\b/i,
  /\bBUILD SUCCESS(?:FUL)?\b|\bFinished\b.*\b(?:dev|release|test)\b/,
];

export function readSummary(output: string): CheckResult {
  const text = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  if (FAILED.some((pattern) => pattern.test(text))) return "failed";
  return PASSED.some((pattern) => pattern.test(text)) ? "passed" : "unknown";
}

export function checkRuns(event: ShellEvent, line: ShellLine, context: EffectContext): CheckRun[] {
  const runs: CheckRun[] = [];
  line.commands.forEach((command, index) => {
    // a check inside $(...) ran, but nothing on the line reports how it went
    if (command.substituted) return;
    for (const effect of effectsOf(command, context)) {
      if (effect.kind !== "check") continue;
      const result = resultOf(event, line, statusCovers(line, command));
      const at = event.seq + (index + 1) / (line.commands.length + 1);
      runs.push({ at, label: effect.label, what: effect.what, result, ...(result === "failed" ? { signature: failureSignature(event.output) } : {}) });
    }
  });
  return runs;
}

function resultOf(event: ShellEvent, line: ShellLine, covered: boolean): CheckResult {
  if (event.status === "running" || event.status === "canceled" || event.background === "pending") return "unknown";
  const lineFailed = event.status === "failed" || (event.exitCode !== null && event.exitCode !== 0);
  // the check failed, or the line never got to it: no pass either way
  if (lineFailed && covered) return "failed";
  if (!lineFailed && covered && line.complete) return "passed";
  // the status belongs to another command: only the runner's summary can say
  return readSummary(event.output);
}
