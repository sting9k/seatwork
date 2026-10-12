import { effectsOf, type CheckKind, type EffectContext } from "./effects";
import type { ShellEvent } from "./events";
import { failureSignature } from "./repeat";
import { statusCovers, type ShellLine } from "./shell";

/** Whether a check passed: by the line's exit status where it covers the check, else by the runner's summary. */

export type CheckResult = "passed" | "failed" | "unknown";

/** One run of a check; `at` is its event's sequence number plus the command's place in its line as a fraction. */
export interface CheckRun {
  at: number;
  label: string;
  what: CheckKind | "named";
  result: CheckResult;
  signature?: string;
}

/** What a runner's own summary says of a failed run; "0 failed" is a pass line. */
const SAYS_FAILED: readonly RegExp[] = [
  /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing|failures?|errors?|errored)\b/i,
  /\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]/i,
  /^\s*(?:not ok\b|FAIL(?:ED)?\b|--- FAIL\b|✖|✗|×)/m,
  // a summary piped through `tr` arrives on one line: the counter may stand anywhere on it
  /(?:^|\s)(?:#|ℹ)\s*fail\s+[1-9]/m,
  /\bTests?(?: Files| Suites)?:?\s+(?:\d+ \w+[,|] )*[1-9]\d* failed\b/i,
  /\btest result: FAILED\b/,
  /\bBUILD FAILED\b|\bCompilation failed\b/i,
];

const SAYS_PASSED: readonly RegExp[] = [
  /\b[1-9]\d*\s+(?:tests?\s+)?(?:passed|passing)\b/i,
  /(?:^|\s)(?:#|ℹ)\s*pass\s+[1-9]/m,
  /\bTests?(?: Files| Suites)?:?\s+[1-9]\d* passed\b/i,
  /^ok\s+\S+/m,
  /\btest result: ok\b/,
  /^\s*(?:PASS\b|✓|✔)/m,
  /\b(?:0 errors?|no (?:errors|issues|problems) found|All checks passed)\b/i,
  /\bBUILD SUCCESS(?:FUL)?\b|\bFinished\b.*\b(?:dev|release|test)\b/,
];

/** Words a broken run prints; a passing suite prints them too, so they count only where no summary speaks. */
const HINTS_FAILED: readonly RegExp[] = [
  /\berror TS\d+\b/,
  /\berror(?:\[E\d+\])?: /,
  /\bTraceback \(most recent call last\)/,
  /\b(?:AssertionError|SyntaxError|TypeError|ReferenceError)\b/,
  /\bnpm ERR!|\bELIFECYCLE\b/,
];

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const any = (patterns: readonly RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));

/** What one run's output says of it: a failure anywhere in its summary outranks a pass. */
export function readSummary(output: string): CheckResult {
  const text = plain(output);
  if (any(SAYS_FAILED, text)) return "failed";
  if (any(SAYS_PASSED, text)) return "passed";
  return any(HINTS_FAILED, text) ? "failed" : "unknown";
}

/** What the last run in an output shared by several runs says: the last line of a summary decides. */
export function readLastRun(output: string): CheckResult {
  const lines = plain(output).split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (any(SAYS_FAILED, lines[i])) return "failed";
    if (any(SAYS_PASSED, lines[i])) return "passed";
  }
  return "unknown";
}

const PRINTERS = new Set(["cat", "tail", "head", "less", "more", "bat"]);
const NOT_A_FILE = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

/** Whether what a check prints reaches the line's output: not when its pipeline ends in a file. */
function shown(line: ShellLine, index: number): boolean {
  let end = index;
  while (line.commands[end].joiner === "|" && end + 1 < line.commands.length) end += 1;
  for (let i = index; i <= end; i += 1) {
    for (const redirect of line.commands[i].redirects) {
      if (redirect.op === "<" || (redirect.fd ?? 1) !== 1 || NOT_A_FILE.test(redirect.target)) continue;
      const printed = line.commands
        .slice(end + 1)
        .some(
          (later) => PRINTERS.has((later.argv[0] ?? "").split("/").pop() ?? "") && later.argv.includes(redirect.target),
        );
      if (!printed) return false;
    }
  }
  return true;
}

export function checkRuns(event: ShellEvent, line: ShellLine, context: EffectContext): CheckRun[] {
  const found: { index: number; covered: boolean; label: string; what: CheckRun["what"] }[] = [];
  line.commands.forEach((command, index) => {
    // a check inside $(...) ran, but nothing on the line reports how it went
    if (command.substituted) return;
    for (const effect of effectsOf(command, context)) {
      if (effect.kind === "check")
        found.push({ index, covered: statusCovers(line, command), label: effect.label, what: effect.what });
    }
  });
  // checks whose status the line hides share one output: it shows only the last one's verdict
  const hidden = found.filter((check) => !check.covered && shown(line, check.index));
  return found.map((check) => {
    const read = !hidden.includes(check)
      ? () => "unknown" as const
      : hidden.length < 2
        ? readSummary
        : check === hidden[hidden.length - 1]
          ? readLastRun
          : () => "unknown" as const;
    const result = resultOf(event, line, check.covered, read);
    const at = event.seq + (check.index + 1) / (line.commands.length + 1);
    return {
      at,
      label: check.label,
      what: check.what,
      result,
      ...(result === "failed" ? { signature: failureSignature(event.output) } : {}),
    };
  });
}

function resultOf(
  event: ShellEvent,
  line: ShellLine,
  covered: boolean,
  read: (output: string) => CheckResult,
): CheckResult {
  if (event.status === "running" || event.status === "canceled" || event.background === "pending") return "unknown";
  const lineFailed = event.status === "failed" || (event.exitCode !== null && event.exitCode !== 0);
  // the check failed, or the line never got to it: no pass either way
  if (lineFailed && covered) return "failed";
  if (!lineFailed && covered && line.complete) return "passed";
  // the status belongs to another command: only the runner's summary can say
  return read(event.output);
}
