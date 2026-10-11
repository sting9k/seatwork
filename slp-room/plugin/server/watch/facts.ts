import { isAbsolute, normalize, resolve } from "node:path";
import { CLOSES_WORK, signalOf, subjectSignal } from "../signals";
import type { Brief } from "./brief";
import { checkRuns, type CheckResult, type CheckRun } from "./checks";
import { effectsOf } from "./effects";
import type { ShellEvent, TurnEvent } from "./events";
import { digest, failureSignature, trailingCycle, trailingRun, type Cycle } from "./repeat";
import { inScope, pathKind, relativeToRoot, type PathKind } from "./scope";
import { parseShell, type ShellLine } from "./shell";

/**
 * What code can say for certain about a seat's turn: a pure function of its events, so a scan can be repeated or
 * replayed. Positions are event sequence numbers, with a command's place in its shell line as the fraction.
 */

export interface Edit {
  at: number;
  /** Relative to the project root when inside it, else absolute. */
  path: string;
  kind: PathKind;
}

export interface Deed {
  at: number;
  what: string;
  command: string;
}

/** What the checks that ran after the last source change said. */
export type Standing =
  | "none"
  | "failed"
  /** Some ran; none could be read. */
  | "unknown"
  /** One passed and no later run failed. */
  | "passed";

export interface TurnFacts {
  ended: boolean;
  message: string;
  /** Undefined while the turn runs. */
  signal: string | undefined;
  /** The final message hands work over as finished. */
  closesWork: boolean;
  verdict: "acceptable" | "not-yet" | undefined;

  /** Source changes in this turn. */
  edits: Edit[];
  /** The last source change in the history held; undefined when there is nothing to verify. */
  lastEdit: Edit | undefined;
  checksSince: CheckRun[];
  /** Test runs and the checks the brief names, after the last change. */
  tests: Standing;
  /** Build, lint and type checks after the last change: a green build is not a green test. */
  statics: Standing;
  checksThisTurn: CheckRun[];

  /** Written this turn and not covered by the brief's write scope. */
  outsideScope: string[];
  /** Written this turn outside the project and outside temporary directories. */
  outsideProject: string[];

  destroyed: Deed[];
  external: Deed[];
  /** Seconds spent waiting in the shell this turn, by the clock where the timeline has one. */
  waited: number;
  /** The loop or follow-forever command among those waits. */
  waitLoop: Deed | undefined;

  /** The same action with the same result, back to back. */
  repeat: { count: number; what: string } | undefined;
  cycle: Cycle | undefined;
  /** The same check failing the same way, run after run. */
  sameFailure: { count: number; label: string } | undefined;

  /** Signals the seat mailed its parent this turn. */
  mailed: string[];
  /** A source change made after the seat asked to reopen its brief. */
  editedAfterReopen: Edit | undefined;

  actions: number;
  /** A tool call still running at the end of the history. */
  inFlight: { what: string; since: number | undefined } | undefined;
  lastActivity: number | undefined;
}

export interface FactsInput {
  /** Oldest first; may reach back before the turn being judged. */
  events: readonly TurnEvent[];
  /** `seq` of the first event of the turn being judged. */
  turnStart: number;
  cwd: string;
  /** Where scope patterns are anchored. */
  root: string;
  brief: Brief | null;
  ended: boolean;
  /** Files git says changed during the turn; null when git could not say. */
  changed: readonly string[] | null;
  /** Time of the scan. */
  now?: number;
  /** When the turn began, as the watcher saw it. */
  startedAt?: number;
  /** What the seat above wrote to this seat after the brief in force: a file it names there is one it asked about. */
  later?: readonly string[];
}

/** Targets of a delete that no scope can excuse. */
const SWEEPING = /^(?:\/|~|\.{1,2}|\*|\$HOME|\$\{HOME\})\/?\*?$/;

type Target = { where: "path"; path: string; bounded: boolean } | { where: "everything" } | { where: "unknown" };

function resolveIn(dir: string, path: string): string | null {
  // a path built from a variable or a substitution is not one the watcher can place
  if (/[$`]/.test(path) || path.startsWith("~")) return null;
  return normalize(isAbsolute(path) ? path : resolve(dir, path));
}

interface ShellReading {
  line: ShellLine;
  writes: { at: number; path: string | null }[];
  treeWrite: number | undefined;
  checks: CheckRun[];
  /** Set for deletes only. */
  destroyed: (Deed & { targets?: Target[] })[];
  external: Deed[];
  sleeps: number;
  waitLoop: Deed | undefined;
  /** Commands the watcher cannot read (a script, an interpreter): they may have written anything. */
  opaque: { at: number; text: string }[];
}

function readShell(event: ShellEvent, cwd: string, namedChecks: readonly string[]): ShellReading {
  const line = parseShell(event.command);
  const context = { namedChecks };
  const reading: ShellReading = { line, writes: [], treeWrite: undefined, checks: checkRuns(event, line, context), destroyed: [], external: [], sleeps: 0, waitLoop: undefined, opaque: [] };
  // a command that never ran did nothing; one that failed may still have written before it failed
  if (event.status === "canceled") return { ...reading, checks: [] };
  let dir: string | null = event.cwd ?? cwd;
  line.commands.forEach((command, index) => {
    const at = event.seq + (index + 1) / (line.commands.length + 1);
    if (command.argv[0] === "cd" && !command.substituted) {
      dir = dir && command.argv[1] ? resolveIn(dir, command.argv[1]) : null;
      return;
    }
    const effects = effectsOf(command, context);
    if (effects.length === 0) reading.opaque.push({ at, text: `${command.argv.join(" ")}\n${command.script ?? ""}` });
    for (const effect of effects) {
      if (effect.kind === "write") {
        for (const path of effect.paths) reading.writes.push({ at, path: dir ? resolveIn(dir, path) : null });
        if (effect.tree) reading.treeWrite = at;
      } else if (effect.kind === "destroy") {
        const targets = effect.paths?.map((path): Target => {
          const bounded = effect.bounded === true;
          if (!bounded && SWEEPING.test(path)) return { where: "everything" };
          const placed = dir ? resolveIn(dir, path) : null;
          return placed ? { where: "path", path: placed, bounded } : { where: "unknown" };
        });
        reading.destroyed.push({ at, what: effect.what, command: event.command, ...(targets ? { targets } : {}) });
      } else if (effect.kind === "external") {
        // a line that failed on its last command did not get that command through
        if (!(event.status === "failed" && index === line.commands.length - 1)) reading.external.push({ at, what: effect.what, command: event.command });
      } else if (effect.kind === "wait") {
        if (command.inLoop || !Number.isFinite(effect.seconds)) reading.waitLoop ??= { at, what: command.inLoop ? "a shell loop that sleeps" : `${command.argv[0]} that runs until stopped`, command: event.command };
        else reading.sleeps += effect.seconds;
      }
    }
  });
  return reading;
}

function fingerprint(event: TurnEvent): string | null {
  switch (event.kind) {
    case "shell":
      return `sh:${event.command.trim().replace(/\s+/g, " ")}:${event.status}:${event.status === "failed" ? failureSignature(event.output) : ""}`;
    case "edit":
      // an edit is a change of approach, however small: it ends a run and is part of no cycle
      return `ed:${event.seq}`;
    case "tool":
      return `tl:${event.name}:${digest(JSON.stringify(event.input))}:${event.status}`;
    default:
      return null;
  }
}

function describe(event: TurnEvent): string {
  if (event.kind === "shell") return event.command.trim().replace(/\s+/g, " ").slice(0, 160);
  if (event.kind === "edit") return `edit ${event.path}`;
  return event.kind === "tool" ? event.name : event.kind;
}

/** The latest run of each check decides; a failure outranks a pass. */
function standing(checks: readonly CheckRun[]): Standing {
  if (checks.length === 0) return "none";
  const latest = new Map<string, CheckResult>();
  for (const run of checks) latest.set(run.label, run.result);
  const results = [...latest.values()];
  if (results.includes("failed")) return "failed";
  return results.includes("passed") ? "passed" : "unknown";
}

function verdictOf(message: string): TurnFacts["verdict"] {
  // the verdict of a review is its own line; "NOT YET" outranks an "acceptable" further down
  if (/^\W*NOT YET\b/m.test(message)) return "not-yet";
  return /^\W*(?:verdict\W+)?ACCEPTABLE\b/im.test(message) ? "acceptable" : undefined;
}

export function turnFacts(input: FactsInput): TurnFacts {
  const { events, turnStart, cwd, root, brief } = input;
  const namedChecks = brief?.namedChecks ?? [];
  const inTurn = (at: number) => at >= turnStart;

  const sourceEdits: Edit[] = [];
  const writesThisTurn: Edit[] = [];
  const checks: CheckRun[] = [];
  const destroyed: Deed[] = [];
  const external: Deed[] = [];
  const mailed: string[] = [];
  let waited = 0;
  let waitLoop: Deed | undefined;
  let reopenAt: number | undefined;
  const opaque: ShellReading["opaque"] = [];

  const scope = brief?.scope ?? null;
  // the brief may name a project directory other than the one the seat stands in
  const project = /^\s*(\/\S+)/.exec(brief?.fields.project ?? "")?.[1].replace(/\/+$/, "");
  const underProject = (path: string) => project !== undefined && (path === project || path.startsWith(`${project}/`));
  /** A seat may delete what is temporary, or inside the project and inside its scope. */
  const ownToDelete = (targets: readonly Target[]) =>
    targets.every((target) => {
      if (target.where !== "path") return target.where === "unknown";
      const inside = relativeToRoot(root, target.path);
      if (inside === null) return pathKind(root, target.path) === "scratch" || underProject(target.path);
      // a find that picks files by a test: what it took outside the scope shows in git at the turn's end
      return target.bounded || !scope || inScope(scope, inside);
    });

  const noteWrite = (at: number, path: string) => {
    const kind = pathKind(root, path);
    const edit: Edit = { at, path: relativeToRoot(root, path) ?? path, kind };
    if (kind === "source") sourceEdits.push(edit);
    if (inTurn(at) && (kind === "source" || kind === "doc" || kind === "outside")) writesThisTurn.push(edit);
  };

  for (const event of events) {
    if (event.kind === "edit") {
      if (event.status !== "failed" && event.status !== "canceled") noteWrite(event.seq, event.path);
    } else if (event.kind === "shell") {
      const reading = readShell(event, cwd, namedChecks);
      checks.push(...reading.checks);
      for (const write of reading.writes) if (write.path) noteWrite(write.at, write.path);
      if (reading.treeWrite !== undefined) sourceEdits.push({ at: reading.treeWrite, path: "(working tree)", kind: "source" });
      if (!inTurn(event.seq)) continue;
      opaque.push(...reading.opaque);
      for (const deed of reading.destroyed) {
        if (!(deed.targets && ownToDelete(deed.targets))) destroyed.push({ at: deed.at, what: deed.what, command: deed.command });
      }
      external.push(...reading.external);
      const seconds = waitedSeconds(event, reading, input.now);
      waited += seconds;
      if (seconds > 0) waitLoop ??= reading.waitLoop;
    } else if (event.kind === "tool" && inTurn(event.seq) && /(?:^|_)slp_mail$/.test(event.name)) {
      const signal = subjectSignal(String(event.input.subject ?? ""));
      if (signal) mailed.push(signal);
      if (signal === "REOPEN_REQUEST") reopenAt ??= event.seq;
    }
  }
  // source git saw change with no tool call to account for it: placed at the last unreadable command that names the file, else at the turn's start
  const seen = new Set(sourceEdits.map((edit) => edit.path));
  for (const path of input.changed ?? []) {
    if (seen.has(path) || pathKind(root, resolve(root, path)) !== "source") continue;
    const name = path.split("/").pop()!;
    const writer = opaque.findLast((command) => command.text.includes(path) || command.text.includes(name));
    sourceEdits.push({ at: writer?.at ?? turnStart, path, kind: "source" });
  }
  sourceEdits.sort((a, b) => a.at - b.at);

  const lastEdit = sourceEdits[sourceEdits.length - 1];
  const checksSince = lastEdit ? checks.filter((run) => run.at > lastEdit.at) : [];
  const behavioural = (run: CheckRun) => run.what === "test" || run.what === "named";

  const written = new Set(writesThisTurn.filter((edit) => edit.kind !== "outside").map((edit) => edit.path));
  for (const path of input.changed ?? []) {
    const kind = pathKind(root, resolve(root, path));
    if (kind === "source" || kind === "doc") written.add(path);
  }
  const outsideScope = scope ? [...written].filter((path) => !inScope(scope, path) && !namedLater(path, input.later ?? [])).sort() : [];
  const outsideProject = [...new Set(writesThisTurn.filter((edit) => edit.kind === "outside" && !underProject(edit.path)).map((edit) => edit.path))].sort();

  const turnEvents = events.filter((event) => inTurn(event.seq));
  const acted = turnEvents.filter((event) => event.kind !== "say" && event.kind !== "look");
  const prints = acted.map(fingerprint).filter((print): print is string => print !== null);
  const run = trailingRun(prints);
  const lastActed = acted[acted.length - 1];

  const turnChecks = checks.filter((check) => inTurn(check.at));
  const message = lastMessage(turnEvents);
  const signal = input.ended ? signalOf(message) : undefined;
  const last = events[events.length - 1];
  const running = last && last.kind !== "say" && last.status === "running" ? last : undefined;

  return {
    ended: input.ended,
    message,
    signal,
    closesWork: signal !== undefined && CLOSES_WORK.has(signal),
    verdict: input.ended ? verdictOf(message) : undefined,
    edits: sourceEdits.filter((edit) => inTurn(edit.at)),
    lastEdit,
    checksSince,
    tests: standing(checksSince.filter(behavioural)),
    statics: standing(checksSince.filter((run) => !behavioural(run))),
    checksThisTurn: turnChecks,
    outsideScope,
    outsideProject,
    destroyed,
    external,
    waited,
    waitLoop,
    repeat: run >= 2 && lastActed ? { count: run, what: describe(lastActed) } : undefined,
    cycle: trailingCycle(prints.slice(-24), 4, 3) ?? undefined,
    sameFailure: sameFailure(turnChecks),
    mailed,
    editedAfterReopen: reopenAt === undefined ? undefined : sourceEdits.find((edit) => edit.at > reopenAt!),
    actions: acted.length,
    inFlight: running ? { what: describe(running), since: running.at } : undefined,
    lastActivity: lastMove(turnEvents[turnEvents.length - 1]?.at, input.startedAt) ?? last?.at,
  };
}

/** A finished wait runs from the entry before it to its own end, a running one from its start until now; without clocks the command's words count. */
function waitedSeconds(event: ShellEvent, reading: ShellReading, now: number | undefined): number {
  if (!reading.waitLoop && reading.sleeps === 0) return 0;
  // a command sent to the background holds no turn
  if (event.background) return 0;
  const asked = reading.waitLoop ? Number.POSITIVE_INFINITY : reading.sleeps;
  const running = event.status === "running";
  // a plain sleep in flight will take what it says
  if (running && !reading.waitLoop) return asked;
  const from = running ? event.at : event.prior;
  const to = running ? now : event.at;
  if (from === undefined || to === undefined) return event.status === "failed" ? 0 : asked;
  return Math.min(asked, Math.max(0, (to - from) / 1000));
}

/** The later of two times, either of which may be unknown. */
function lastMove(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

const FORBIDS = /\b(?:do not|don't|never|must not|may not|leave|unchanged|untouched|frozen|out of scope|outside (?:the |your )?(?:write )?scope)\b/i;

/** Whether a later word from the seat above names this file in a sentence that does not forbid it. */
function namedLater(path: string, later: readonly string[]): boolean {
  const name = path.split("/").pop() ?? path;
  const wanted = name.includes(".") && name.length >= 4 ? [path, name] : [path];
  return later.some((text) => text.split(/(?<=[.!?;])\s+|\n/).some((sentence) => wanted.some((word) => sentence.includes(word)) && !FORBIDS.test(sentence)));
}

function lastMessage(events: readonly TurnEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "say") return event.text;
  }
  return "";
}

/** The trailing run of failures of one check that all printed the same failure. */
function sameFailure(checks: readonly CheckRun[]): TurnFacts["sameFailure"] {
  const failed = checks[checks.length - 1];
  if (!failed || failed.result !== "failed") return undefined;
  let count = 0;
  for (let i = checks.length - 1; i >= 0; i -= 1) {
    const run = checks[i];
    if (run.label !== failed.label) continue;
    if (run.result !== "failed" || run.signature !== failed.signature) break;
    count += 1;
  }
  return count >= 2 ? { count, label: failed.label } : undefined;
}
