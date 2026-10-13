import { isAbsolute, normalize, resolve } from "node:path";
import { CLOSES_WORK, signalOf, subjectSignal } from "../signals";
import type { Brief } from "./brief";
import { checkRuns, type CheckResult, type CheckRun } from "./checks";
import { effectsOf } from "./effects";
import type { ShellEvent, TurnEvent } from "./events";
import { digest, failureSignature, trailingCycle, trailingRun, type Cycle } from "./repeat";
import { inScope, pathKind, relativeToRoot, type PathKind } from "./scope";
import { parseShell, type ShellLine } from "./shell";

/** What code can say for certain about a seat's turn: a pure function of its events, so a scan can be replayed. */

export interface Edit {
  at: number;
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

/** One turn's facts; `tests` and `statics` (build, lint, types) are what the checks said after the last source change. */
export interface TurnFacts {
  ended: boolean;
  message: string;
  signal: string | undefined;
  closesWork: boolean;
  verdict: "acceptable" | "not-yet" | undefined;

  edits: Edit[];
  lastEdit: Edit | undefined;
  checksSince: CheckRun[];
  tests: Standing;
  statics: Standing;
  checksThisTurn: CheckRun[];

  outsideScope: string[];
  outsideProject: string[];
  testsChanged: string[];

  destroyed: Deed[];
  external: Deed[];
  installed: Deed[];
  waited: number;
  waitLoop: Deed | undefined;

  skillsSoFar: string[];

  repeat: { count: number; what: string } | undefined;
  cycle: Cycle | undefined;
  sameFailure: { count: number; label: string } | undefined;

  mailed: string[];
  editedAfterReopen: Edit | undefined;

  actions: number;
  inFlight: { what: string; since: number | undefined } | undefined;
  lastActivity: number | undefined;
}

/** What a scan reads: `events` oldest first, from before the turn if need be, and `turnStart`, the turn's first `seq`. */
export interface FactsInput {
  events: readonly TurnEvent[];
  turnStart: number;
  cwd: string;
  root: string;
  brief: Brief | null;
  ended: boolean;
  changed: readonly string[] | null;
  changedTests?: readonly string[];
  now?: number;
  startedAt?: number;
  later?: readonly string[];
}

/** Programs that make a path: what a seat made in a turn is its own to remove. */
const MAKERS = new Set(["mkdir", "touch", "mktemp", "cp", "tee"]);

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
  writes: { at: number; path: string | null; by: string }[];
  treeWrite: number | undefined;
  checks: CheckRun[];
  destroyed: (Deed & { targets?: Target[] })[];
  external: Deed[];
  installed: Deed[];
  sleeps: number;
  waitLoop: Deed | undefined;
  opaque: { at: number; text: string }[];
}

function readShell(event: ShellEvent, cwd: string, namedChecks: readonly string[]): ShellReading {
  const line = parseShell(event.command);
  const context = { namedChecks };
  const reading: ShellReading = {
    line,
    writes: [],
    treeWrite: undefined,
    checks: checkRuns(event, line, context),
    destroyed: [],
    external: [],
    installed: [],
    sleeps: 0,
    waitLoop: undefined,
    opaque: [],
  };
  // a command that never ran did nothing; one that failed may still have written before it failed
  if (event.status === "canceled") return { ...reading, checks: [] };
  let outer: string | null = event.cwd ?? cwd;
  // a nested shell starts where the line stands and takes its own `cd` away with it
  let nested: { shell: number; dir: string | null } | null = null;
  line.commands.forEach((command, index) => {
    const at = event.seq + (index + 1) / (line.commands.length + 1);
    if (command.shell === undefined) nested = null;
    else if (nested?.shell !== command.shell) nested = { shell: command.shell, dir: outer };
    const dir = nested ? nested.dir : outer;
    if (command.argv[0] === "cd") {
      const moved = dir && command.argv[1] ? resolveIn(dir, command.argv[1]) : null;
      if (nested) nested.dir = moved;
      else outer = moved;
      return;
    }
    const effects = effectsOf(command, context, line.commands[index + 1]);
    if (effects.length === 0) reading.opaque.push({ at, text: `${command.argv.join(" ")}\n${command.script ?? ""}` });
    // a line that failed on its last command did not get that command through
    const wentThrough = !(event.status === "failed" && index === line.commands.length - 1);
    for (const effect of effects) {
      if (effect.kind === "write") {
        for (const path of effect.paths)
          reading.writes.push({ at, path: dir ? resolveIn(dir, path) : null, by: command.argv[0] });
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
        if (wentThrough) reading.external.push({ at, what: effect.what, command: event.command });
      } else if (effect.kind === "install") {
        if (wentThrough) reading.installed.push({ at, what: effect.what, command: event.command });
      } else if (effect.kind === "wait") {
        if (command.inLoop || !Number.isFinite(effect.seconds))
          reading.waitLoop ??= {
            at,
            what: command.inLoop ? "a shell loop that sleeps" : `${command.argv[0]} that runs until stopped`,
            command: event.command,
          };
        else reading.sleeps += effect.seconds;
      }
    }
  });
  return reading;
}

const SKILL_FILE = /(?:^|[\s/"'=])skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md\b/g;
const skillFiles = (text: string) => [...text.matchAll(SKILL_FILE)].map((match) => match[1]);

/** The skills an event loaded: a skill tool call, or a read of a skill's `SKILL.md`. */
function skillsOf(event: TurnEvent): string[] {
  if (event.kind === "say" || event.status === "failed" || event.status === "canceled") return [];
  if (event.kind === "tool")
    return /^skill$/i.test(event.name)
      ? [String(event.input.skill ?? event.input.name ?? "").trim()].filter(Boolean)
      : [];
  if (event.kind === "look") return event.path ? skillFiles(event.path) : [];
  return event.kind === "shell" ? skillFiles(event.command) : [];
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
  const installed: Deed[] = [];
  const skills = new Set<string>();
  const mailed: string[] = [];
  let waited = 0;
  let waitLoop: Deed | undefined;
  let reopenAt: number | undefined;
  const opaque: ShellReading["opaque"] = [];

  const scope = brief?.scope ?? null;
  // the brief may name a project directory other than the one the seat stands in
  const project = /^\s*(\/\S+)/.exec(brief?.fields.project ?? "")?.[1].replace(/\/+$/, "");
  const underProject = (path: string) => project !== undefined && (path === project || path.startsWith(`${project}/`));
  const made = new Set<string>();
  /** A seat may delete what is temporary, or inside the project and inside its scope. */
  const ownToDelete = (targets: readonly Target[]) =>
    targets.every((target) => {
      if (target.where !== "path") return target.where === "unknown";
      const inside = relativeToRoot(root, target.path);
      if (made.has(target.path)) return true;
      // a pattern in a shared temporary directory may take their files
      if (inside === null)
        return (pathKind(root, target.path) === "scratch" && !/[*?]/.test(target.path)) || underProject(target.path);
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
    for (const skill of skillsOf(event)) skills.add(skill);
    if (event.kind === "edit") {
      if (event.status !== "failed" && event.status !== "canceled") noteWrite(event.seq, event.path);
    } else if (event.kind === "shell") {
      const reading = readShell(event, cwd, namedChecks);
      checks.push(...reading.checks);
      for (const write of reading.writes) {
        if (!write.path) continue;
        if (inTurn(event.seq) && MAKERS.has(write.by)) made.add(write.path);
        noteWrite(write.at, write.path);
      }
      if (reading.treeWrite !== undefined)
        sourceEdits.push({ at: reading.treeWrite, path: "(working tree)", kind: "source" });
      if (!inTurn(event.seq)) continue;
      opaque.push(...reading.opaque);
      for (const deed of reading.destroyed) {
        if (!(deed.targets && ownToDelete(deed.targets)))
          destroyed.push({ at: deed.at, what: deed.what, command: deed.command });
      }
      external.push(...reading.external);
      installed.push(...reading.installed);
      const seconds = waitedSeconds(event, reading, input.now);
      waited += seconds;
      if (seconds > 0) waitLoop ??= reading.waitLoop;
    } else if (event.kind === "tool" && inTurn(event.seq) && /(?:^|_)seatwork_mail$/.test(event.name)) {
      const signal = subjectSignal(String(event.input.subject ?? ""));
      if (signal) mailed.push(signal);
      if (signal === "REOPEN_REQUEST") reopenAt ??= event.seq;
    }
  }
  // source git saw change with no tool call for it: placed at the last unreadable command that names the file
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
  const outsideScope = scope
    ? [...written].filter((path) => !inScope(scope, path) && !namedLater(path, input.later ?? [])).sort()
    : [];
  const outsideProject = [
    ...new Set(
      writesThisTurn.filter((edit) => edit.kind === "outside" && !underProject(edit.path)).map((edit) => edit.path),
    ),
  ].sort();

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
    testsChanged: [...(input.changedTests ?? [])],
    destroyed,
    external,
    installed,
    waited,
    waitLoop,
    skillsSoFar: [...skills].sort(),
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

/** A finished wait runs from the entry before it to its end, a running one from its start until now. */
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

const FORBIDS =
  /\b(?:do not|don't|never|must not|may not|leave|unchanged|untouched|frozen|out of scope|outside (?:the |your )?(?:write )?scope)\b/i;

/** Whether a later word from the seat above names this file in a sentence that does not forbid it. */
function namedLater(path: string, later: readonly string[]): boolean {
  const name = path.split("/").pop() ?? path;
  const wanted = name.includes(".") && name.length >= 4 ? [path, name] : [path];
  return later.some((text) =>
    text
      .split(/(?<=[.!?;])\s+|\n/)
      .some((sentence) => wanted.some((word) => sentence.includes(word)) && !FORBIDS.test(sentence)),
  );
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
