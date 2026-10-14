import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import council from "../../../shared/safety/council.json";
import type { TurnEvent } from "../../host";

/** What a turn shows without asking any model: claims, checks, changes, loops and silence. */

const CHECKS = council.checks.map((pattern) => new RegExp(pattern, "i"));
const SAID = council.claims.said.map((pattern) => new RegExp(pattern, "i"));
const DENIED = council.claims.denied.map((pattern) => new RegExp(pattern, "i"));

const squash = (command: string) => command.replace(/\s+/g, " ").trim();

/** Whether a command runs one of `wanted`, as the brief quotes them. */
export function runsOneOf(command: string, wanted: readonly string[]): boolean {
  const flat = squash(command);
  return wanted.some((one) => flat.includes(squash(one)));
}

/** Whether a command runs a check: a known runner, or one of the commands its brief names. */
export function isCheck(command: string, named: readonly string[]): boolean {
  const flat = squash(command);
  return CHECKS.some((pattern) => pattern.test(flat)) || runsOneOf(flat, named);
}

/** The lines of a message that say the work passed or was checked, and deny nothing. */
export function claimsIn(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => SAID.some((pattern) => pattern.test(line)) && !DENIED.some((pattern) => pattern.test(line)));
}

export interface CheckRun {
  command: string;
  exitCode: number | null;
}

export interface TurnFacts {
  lastChange: number;
  changed: string[];
  checks: CheckRun[];
  checksAfterChange: CheckRun[];
}

/** The turn's changes, the checks it ran, and those after its last change; `lastChange` is -1 for none. */
export function turnFacts(events: readonly TurnEvent[], named: readonly string[]): TurnFacts {
  let lastChange = -1;
  const changed = new Set<string>();
  const runs: { at: number; run: CheckRun }[] = [];
  events.forEach((event, index) => {
    if (event.kind === "change" && event.status === "completed") {
      lastChange = index;
      changed.add(event.path);
    } else if (event.kind === "shell" && event.status !== "running" && isCheck(event.command, named))
      runs.push({ at: index, run: { command: squash(event.command).slice(0, 200), exitCode: event.exitCode } });
  });
  return {
    lastChange,
    changed: [...changed],
    checks: runs.map(({ run }) => run),
    checksAfterChange: runs.filter(({ at }) => at > lastChange).map(({ run }) => run),
  };
}

/** The changed paths no glob of the write scope covers; relative globs are read from `root`. */
export function outsideScope(paths: readonly string[], globs: readonly string[], root: string): string[] {
  if (globs.length === 0) return [];
  const local = globs.map((glob) => (isAbsolute(glob) ? relative(root, glob) : glob.replace(/^\.\//, "")));
  return paths.filter((path) => {
    const inside = relative(root, resolve(root, path));
    if (inside.startsWith("..")) return true;
    return !local.some(
      (glob) => matchesGlob(inside, glob) || matchesGlob(inside, `${glob.replace(/\/$/, "")}/**`) || inside === glob,
    );
  });
}

export interface Loop {
  pattern: "same-result" | "same-error" | "alternation";
  command: string;
  count: number;
}

export interface LoopLimits {
  window: number;
  sameResult: number;
  sameError: number;
  alternation: number;
}

/** A loop among the last steps: one result over and over, one failure over and over, two steps in turn. */
export function loopIn(events: readonly TurnEvent[], limits: LoopLimits): Loop | null {
  const steps = events
    .filter(
      (event): event is Extract<TurnEvent, { kind: "shell" | "tool" }> =>
        (event.kind === "shell" || event.kind === "tool") && event.status !== "running",
    )
    .slice(-limits.window);
  const label = (step: (typeof steps)[number]) => (step.kind === "shell" ? squash(step.command) : step.name);
  const failing = (step: (typeof steps)[number]) =>
    step.kind === "shell" ? step.exitCode !== null && step.exitCode !== 0 : step.status === "failed";
  if (steps.length === 0) return null;
  const results = steps.map((step) =>
    step.kind === "shell"
      ? `${label(step)}\u0000${step.exitCode}\u0000${step.output}`
      : `${label(step)}\u0000${step.status}`,
  );
  let sameRun = 1;
  let errorRun = failing(steps[0]) ? 1 : 0;
  for (let i = 1; i < steps.length; i += 1) {
    const [step, before] = [steps[i], steps[i - 1]];
    sameRun = results[i] === results[i - 1] ? sameRun + 1 : 1;
    errorRun = !failing(step) ? 0 : failing(before) && label(step) === label(before) ? errorRun + 1 : 1;
    if (sameRun >= limits.sameResult) return { pattern: "same-result", command: label(step), count: sameRun };
    if (errorRun >= limits.sameError) return { pattern: "same-error", command: label(step), count: errorRun };
  }
  const tail = results.slice(-limits.alternation);
  if (tail.length === limits.alternation && tail[0] !== tail[1] && tail.every((key, i) => key === tail[i % 2]))
    return {
      pattern: "alternation",
      command: `${label(steps[steps.length - 2])} / ${label(steps[steps.length - 1])}`,
      count: tail.length,
    };
  return null;
}

/** Minutes since the last dated step of a running turn; null when nothing in it is dated. */
export function quietMinutes(events: readonly TurnEvent[], now: number): number | null {
  const last = events.findLast((event) => event.at)?.at;
  return last ? (now - Date.parse(last)) / 60_000 : null;
}
