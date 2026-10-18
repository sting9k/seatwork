import { readFileSync, statSync } from "node:fs";
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import council from "../../../shared/safety/council.json";
import type { TurnEvent } from "../../host";

/** What a turn shows without asking any model: claims, checks, changes, loops and silence. */

const CHECKS = council.checks.map((pattern) => new RegExp(pattern, "i"));
const SAID = council.claims.said.map((pattern) => new RegExp(pattern, "i"));
const DENIED = council.claims.denied.map((pattern) => new RegExp(pattern, "i"));
const NARROW = council.narrow.map(({ runner, flags }) => ({
  runner: new RegExp(runner, "i"),
  flags: flags.map((flag) => ({ flag, pattern: new RegExp(`(^|\\s)${flag}(=|\\s|$)`) })),
}));

const squash = (command: string) => command.replace(/\s+/g, " ").trim();
const EDGE = /[\s;&|()<>"'`]/;

/** Whether a command runs one of `wanted` whole: `e2e:unit` is no run of `e2e`. */
export function runsOneOf(command: string, wanted: readonly string[]): boolean {
  const flat = squash(command);
  return wanted.some((one) => standsIn(flat, squash(one)));
}

/** Whether `part` stands in `text` as whole words. */
function standsIn(text: string, part: string): boolean {
  if (!part) return false;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) {
    const [before, after] = [text[at - 1], text[at + part.length]];
    if ((before === undefined || EDGE.test(before)) && (after === undefined || EDGE.test(after))) return true;
  }
  return false;
}

/** Whether a command runs a check: a known runner, or one of the commands its brief names. */
function isCheck(command: string, named: readonly string[]): boolean {
  const flat = squash(command);
  return CHECKS.some((pattern) => pattern.test(flat)) || runsOneOf(flat, named);
}

/** Where a turn last changed its tree, or -1: an edit tool's call, or a shell line the guard saw write it that is no check itself. */
function lastChangeIn(events: readonly TurnEvent[], named: readonly string[]): number {
  return events.findLastIndex((event) =>
    event.kind === "change"
      ? event.status === "completed"
      : event.kind === "shell" && event.writes === true && !isCheck(event.command, named),
  );
}

/** A command with its quoted text blanked, so a quoted `|` or `;` is read as part of a word. */
const unquoted = (command: string) =>
  command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quote) => "_".repeat(quote.length));

/** One line of shell: continued lines joined, other line breaks read as `;`. */
const oneLine = (command: string) =>
  squash(
    command
      .replace(/\\\n/g, " ")
      .replace(/(&&|\|\|?)\s*\n/g, "$1 ")
      .replace(/\n/g, " ; "),
  );

/** Where the first check of a line ends, or -1: a known runner, or a command the brief names. */
function checkEnd(plain: string, flat: string, named: readonly string[]): number {
  const found = [
    ...CHECKS.map((pattern) => pattern.exec(plain))
      .filter((match) => match !== null)
      .map((match) => ({ start: match.index, end: match.index + match[0].length })),
    ...named
      .map((one) => ({ at: flat.indexOf(squash(one)), length: squash(one).length }))
      .filter(({ at }) => at >= 0)
      .map(({ at, length }) => ({ start: at, end: at + length })),
  ];
  return found.length ? found.reduce((first, one) => (one.start < first.start ? one : first)).end : -1;
}

/** Why a check's exit code proves nothing, or null: a later command sets it, or a filter the brief did not ask for. */
export function maskOf(command: string, named: readonly string[] = []): string | null {
  const flat = oneLine(command);
  const plain = unquoted(flat);
  const end = checkEnd(plain, flat, named);
  if (end < 0) return null;
  const rest = plain.slice(end);
  if (rest.includes("||")) return "`||` decides its exit code";
  if (rest.includes("|") && !plain.includes("pipefail"))
    return "it is piped, so the pipe's last command decides its exit code";
  if (rest.includes(";")) return "a later command decides its exit code";
  if (/(^|[^&>|<])&(?![&>])/.test(rest)) return "it runs in the background";
  const left = unquoted(named.reduce((text, one) => text.replaceAll(squash(one), " "), flat));
  for (const { runner, flags } of NARROW) {
    if (!runner.test(plain)) continue;
    const found = flags.find(({ pattern }) => pattern.test(left));
    if (found) return `\`${found.flag}\` runs only the tests it selects, maybe none`;
  }
  return null;
}

/** The paths a check names after its runner, relative to `root`; null when it names none and so runs the whole suite. */
export function pathsOf(command: string, named: readonly string[], root: string): string[] | null {
  const flat = oneLine(command);
  const end = checkEnd(unquoted(flat), flat, named);
  const words = flat.slice(Math.max(end, 0)).split(" ");
  const stop = words.findIndex((word) => ["&&", ";", "|", "||"].includes(word));
  const paths = (stop < 0 ? words : words.slice(0, stop))
    .map((word) => word.replace(/^['"]|['"]$/g, "").replace(/::.*$/, ""))
    .filter((word) => word && !word.startsWith("-") && (word.includes("/") || /\.[A-Za-z0-9]+$/.test(word)));
  if (paths.some((path) => path === "./..." || path === "...")) return null;
  if (paths.length === 0) return null;
  return paths.map((path) =>
    (isAbsolute(path) ? relative(root, path) : path).replace(/^\.\//, "").replace(/\/\.\.\.$|\/$/, ""),
  );
}

/** The tests of `tests` no passing, unmasked check ran after the turn's last change; one that names no path runs all. */
export function testsNotRun(
  events: readonly TurnEvent[],
  named: readonly string[],
  tests: readonly string[],
  root: string,
): string[] {
  const lastChange = lastChangeIn(events, named);
  const ran: string[] = [];
  for (const [index, event] of events.entries()) {
    if (index < lastChange || event.kind !== "shell" || event.status === "running" || event.exitCode !== 0) continue;
    if (!isCheck(event.command, named) || maskOf(event.command, named) !== null) continue;
    const paths = pathsOf(event.command, named, root);
    if (paths === null) return [];
    ran.push(...paths);
  }
  return tests.filter(
    (test) => !ran.some((path) => test === path || test.startsWith(`${path}/`) || covers(test, path)),
  );
}

/** Whether a glob covers a path, a name that starts with a dot as any other: node's `*` passes over such a name. */
const covers = (path: string, glob: string) =>
  matchesGlob(path, glob) || matchesGlob(path.replace(/(^|\/)\./g, "$1_"), glob);

/** The lines of a message that say the work passed or was checked, and deny nothing. */
export function claimsIn(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => SAID.some((pattern) => pattern.test(line)) && !DENIED.some((pattern) => pattern.test(line)));
}

/** A thing a final message says that its turn does not bear out; `found` is what is there instead. */
export interface Unborne {
  kind: "path" | "line" | "run" | "count";
  said: string;
  found?: string;
}

const PATH = /`([^`\s]+)`|((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z][A-Za-z0-9]{0,5}(?::\d+)?)/g;
const CITED = /^(.+\.[A-Za-z][A-Za-z0-9]{0,5}):(\d+)(?::\d+)?$/;
const CHANGED = /\b(changed|edited|updated|modified|fixed|touched|rewrote)\b/i;
const RAN = /\b(ran|re-?ran|executed)\b/i;
const SAID_COUNT = /\b(\d+)\s+(?:tests?|specs?|checks?)\b/i;
const OUTPUT_COUNTS = [/(\d+)\s+(?:passed|passing)\b/g, /^#\s*pass\s+(\d+)\s*$/gm];
const CITED_MOST = 10;
const PATHS_MOST = 50;
const READ_MOST = 1024 * 1024;

/** The lines of a file, or null when it is missing, not a file, or too big to read. */
function lineCount(path: string): number | null {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > READ_MOST) return null;
  const text = readFileSync(path, "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** What a message says that its turn does not bear out; paths are read against the work tree `root`. */
export function unborneIn(
  text: string,
  events: readonly TurnEvent[],
  named: readonly string[],
  root: string,
): Unborne[] {
  const out: Unborne[] = [];
  const lastChange = lastChangeIn(events, named);
  const touched = (path: string) =>
    events.some(
      (event) =>
        ((event.kind === "change" || event.kind === "read") &&
          (event.path === path || event.path.endsWith(`/${path}`))) ||
        (event.kind === "shell" && event.command.includes(path)),
    );
  const lines = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").split("\n");
  let [cited, read] = [0, 0];
  for (const line of lines) {
    for (const match of line.matchAll(PATH)) {
      const token = (match[1] ?? match[2]).replace(/[.,;)]+$/, "");
      const at = CITED.exec(token);
      const path = at ? at[1] : token;
      if (!/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(path) || (!at && !CHANGED.test(line))) continue;
      if ((at && (cited += 1) > CITED_MOST) || (read += 1) > PATHS_MOST) continue;
      const full = isAbsolute(path) ? path : resolve(root, path);
      const exists = statSync(full, { throwIfNoEntry: false }) !== undefined;
      if (!exists) {
        if (!touched(path)) out.push({ kind: "path", said: token });
        continue;
      }
      const count = at ? lineCount(full) : null;
      if (at && count !== null && Number(at[2]) > count)
        out.push({ kind: "line", said: token, found: `${count} lines` });
    }
    if (lastChange >= 0 && RAN.test(line))
      for (const [, span] of line.matchAll(/`([^`]+)`/g))
        if (span.includes(" ") && !events.some((e) => e.kind === "shell" && squash(e.command).includes(squash(span))))
          out.push({ kind: "run", said: span });
  }
  const saidCount = claimsIn(text)
    .map((line) => SAID_COUNT.exec(line)?.[1])
    .find((n) => n !== undefined);
  if (saidCount !== undefined) {
    const perRun = events
      .filter(
        (event, index): event is Extract<TurnEvent, { kind: "shell" }> =>
          index > lastChange && event.kind === "shell" && isCheck(event.command, named),
      )
      .map((event) => OUTPUT_COUNTS.flatMap((pattern) => [...event.output.matchAll(pattern)].map((m) => Number(m[1]))))
      .filter((counts) => counts.length > 0);
    const shown = new Set(perRun.flat());
    const total = perRun.reduce((sum, counts) => sum + Math.max(...counts), 0);
    if (shown.size && !shown.has(Number(saidCount)) && total !== Number(saidCount))
      out.push({ kind: "count", said: `${saidCount} tests`, found: [...shown].join(", ") });
  }
  return out;
}

/** A check a turn ran; `masked` says why its exit code says nothing of the work, null when it does. */
interface CheckRun {
  command: string;
  exitCode: number | null;
  masked: string | null;
}

interface TurnFacts {
  lastChange: number;
  changed: string[];
  checks: CheckRun[];
  checksAfterChange: CheckRun[];
}

/** The turn's changes, the checks it ran, and those after its last change; `lastChange` is -1 for none. */
export function turnFacts(events: readonly TurnEvent[], named: readonly string[]): TurnFacts {
  const lastChange = lastChangeIn(events, named);
  const changed = new Set<string>();
  const runs: { at: number; run: CheckRun }[] = [];
  events.forEach((event, index) => {
    if (event.kind === "change" && event.status === "completed") changed.add(event.path);
    else if (event.kind === "shell" && event.status !== "running" && isCheck(event.command, named))
      runs.push({
        at: index,
        run: {
          command: squash(event.command).slice(0, 200),
          exitCode: event.exitCode,
          masked: maskOf(event.command, named),
        },
      });
  });
  return {
    lastChange,
    changed: [...changed],
    checks: runs.map(({ run }) => run),
    checksAfterChange: runs.filter(({ at }) => at > lastChange).map(({ run }) => run),
  };
}

/** The changed paths no glob of the write scope covers; relative globs are read from `root`, and a `*` covers a name that starts with a dot. */
export function outsideScope(paths: readonly string[], globs: readonly string[], root: string): string[] {
  if (globs.length === 0) return [];
  const local = globs.map((glob) => (isAbsolute(glob) ? relative(root, glob) : glob.replace(/^\.\//, "")));
  return paths.filter((path) => {
    const inside = relative(root, resolve(root, path));
    if (inside === ".." || inside.startsWith("../")) return true;
    return !local.some(
      (glob) => covers(inside, glob) || covers(inside, `${glob.replace(/\/$/, "")}/**`) || inside === glob,
    );
  });
}

interface Loop {
  pattern: "same-result" | "same-error" | "alternation";
  command: string;
  count: number;
}

interface LoopLimits {
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
