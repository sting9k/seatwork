import { REVIEW_STALL, routeOpen, traits } from "../../shared/workflow";
import type { Mail, NewMail, Needs, Priority, SeatRecord } from "../coordination/engine";
import type { SeatUsage, TurnEvent, TurnOutcome } from "../host";
import { contextFell } from "../orchestration/compaction";

import { classify, type FailureKind } from "../orchestration/recovery";
import { nextTitle, parseHandoff, rotate } from "../orchestration/rotation";
import { familyOf } from "../orchestration/models";
import { skillsLoaded } from "../orchestration/runtimes";
import { FRESH_EYES, ownerNote } from "../orchestration/rounds";
import { parseSeat } from "../orchestration/seats";
import { handInLine, handInReturn, type HandIn } from "../safety/handin";
import { asksOwner, CLOSES_WORK, DECIDES, signalOf, subjectSignal } from "../signals";
import type { Finding } from "../safety/council/council";
import { errorText, fromRoom, releaseWork, taskOf, type RoomContext } from "./context";
import { councilLine, councilRead } from "./council";
import { fitAt, promptMark, stepUpAt } from "./launch";
import { clip, excerpt } from "../excerpt";
import { ROOM_SENDER } from "../coordination/address";

/** The end of a seat's turn: its report goes up, a hand-in may be sent back, a review round is held, a rotation is answered. */

/** A seat as an event of the app names it. */
export interface SeatEvent {
  id: string;
  provider: string;
  title: string | null;
  cwd: string;
  parentId: string | null;
}

/** A turn that ended: its seat, how it ended, and the seat's final message. */
export interface TurnEnd {
  seat: SeatEvent;
  turnId: string | null;
  outcome: TurnOutcome;
  text: string;
  events: TurnEvent[];
}

/** A room seat's turn as the room read it before it decides what goes up: its task, who reads it by mail, the mail it ended with, a failure being mended, and the context it filled. */
interface Gathered {
  end: TurnEnd;
  role: string;
  task: string;
  reportsTo: string | null;
  wake: readonly Mail[];
  mailed: ReadonlySet<string>;
  kept: NewMail | null;
  failure: Failure | null;
  contextTokens: number | null;
}

type Failure = ReturnType<RoomContext["recovery"]["failed"]>;

/** What a turn's end sends: the report the seat kept and the one the room wrote, the mail that returns a candidate in their place, and the council's findings with whether a line of theirs rides up. */
interface Outgoing {
  kept: NewMail | null;
  report: NewMail | null;
  returned: NewMail | null;
  findings: Finding[];
  lined: boolean;
}

/** The kinds of report a turn's end sends up. */
type ReportKind = "failed" | "asks" | "again" | "progress" | "ack" | "nothing-new" | "said";

/** How each kind of report reads to the seat above: how loud it is, what it asks, and why it came after `tries` of the room's. */
const REPORTS: Record<
  ReportKind,
  {
    priority: Priority;
    needs: Needs;
    quiet?: true;
    progress?: true;
    why(tries: number): string;
  }
> = {
  failed: {
    priority: "blocking",
    needs: "decision",
    why: (tries) =>
      `the seat's turn failed${tries > 0 ? `, and again after the room's ${tries} tries` : ""}; its work is stopped: a mail to it starts it again, or archive it and brief a new seat`,
  },
  asks: { priority: "action", needs: "reply", why: () => "" },
  again: {
    priority: "fyi",
    needs: "nothing",
    quiet: true,
    why: () => "nothing new: DONE again, after mail that asked nothing",
  },
  progress: {
    priority: "fyi",
    needs: "nothing",
    quiet: true,
    progress: true,
    why: () => "progress only; it asks nothing of you",
  },
  ack: {
    priority: "fyi",
    needs: "nothing",
    quiet: true,
    why: () => "nothing new: an acknowledgement",
  },
  "nothing-new": {
    priority: "fyi",
    needs: "nothing",
    quiet: true,
    why: () => "nothing new, as the decision model reads the report",
  },
  said: { priority: "fyi", needs: "nothing", why: () => "" },
};

const ALIKE_SHARE = 0.6;
const UNACCEPTED_PUSH = "safety|unaccepted push";

/** True when a turn was started by mail and none of it asked the seat for anything. */
function askedNothing(wake: readonly Mail[]): boolean {
  return (
    wake.length > 0 &&
    wake.every((mail) => mail.needs === "nothing" && (mail.priority === "fyi" || mail.senderRole === ROOM_SENDER.role))
  );
}

/** The seat above that reads this seat's turns by mail; null where the route up is off. */
function readerOf(room: RoomContext, seat: SeatEvent, role: string): string | null {
  const parentId = room.engine.parentOf(seat.id) ?? seat.parentId;
  const parent = parentId ? room.engine.seat(parentId) : undefined;
  return parent && routeOpen(role, parent.role) ? parent.agentId : null;
}

/** Which kind of report a turn sends up, read against the signal its seat ended its last turn with; `retried` and `carried` send none. */
function kindOf(
  turn: Gathered,
  signal: string | undefined,
  before: string | undefined,
  nothingNew: boolean,
): ReportKind | "retried" | "carried" {
  const { end, role, wake, mailed, kept, failure } = turn;
  if (end.outcome.kind === "failed") return failure && "retry" in failure ? "retried" : "failed";
  if (signal ? mailed.has(signal) : kept) return "carried";
  // DONE again, in a turn started only by mail that asked nothing: the parent has it already
  if (signal === "DONE" && before === signal && askedNothing(wake)) return "again";
  if (signal && signal !== "STATUS" && signal !== "ACK") return "asks";
  // a first report carries the plan; a STATUS after it asks nothing of the seat above
  if (signal === "STATUS" && traits(role).progress === true && before !== undefined) return "progress";
  if (signal === "ACK") return "ack";
  return nothingNew ? "nothing-new" : "said";
}

/** The report a turn's end sends up to `to`; null when the room tries the turn again, or the seat's own mail already carried it. */
function reportOf(room: RoomContext, turn: Gathered, to: string, nothingNew: boolean): NewMail | null {
  const { end, role, failure } = turn;
  const { seat, outcome, text } = end;
  const signal = signalOf(text);
  const before = room.lastSignal.get(seat.id);
  if (signal) room.lastSignal.set(seat.id, signal);
  const kind = kindOf(turn, signal, before, nothingNew);
  if (kind === "retried") return null;
  if (kind === "carried") {
    room.log(
      `turn end of ${seat.id}: the seat mailed ${signal ?? "its report"} to its parent itself, so nothing more goes up`,
    );
    return null;
  }
  const shape = REPORTS[kind];
  const name = `${role} ${seat.title ?? seat.id}`;
  return {
    from: { agentId: seat.id, role },
    to,
    priority: shape.priority,
    subject:
      outcome.kind === "failed"
        ? `FAILED: ${outcome.error.slice(0, 120)}`
        : kind === "asks" || kind === "again"
          ? `${signal} from ${name}`
          : `${signal ?? "turn ended"}: ${name}`,
    body: text || `(no final message; outcome ${outcome.kind})`,
    needs: kind === "asks" && DECIDES.has(signal!) ? "decision" : shape.needs,
    why: shape.why(failure && "gaveUpAfter" in failure ? failure.gaveUpAfter : 0),
    ...(shape.quiet ? { quiet: true as const } : {}),
    ...(shape.progress ? { progress: true as const } : {}),
  };
}

/** A failure the room's own rule calls a passing fault, read by the decision model: the kind it is sure of, or null. */
async function failureRead(room: RoomContext, error: string): Promise<FailureKind | null> {
  if (classify(error, Date.now()).kind !== "service") return null;
  return (await room.forks.take("failure", { error: clip(error, 300) })) as FailureKind | null;
}

/** Whether a report with no protocol word, from a turn whose mail asked nothing, brings its reader nothing to act on. */
async function nothingNew(room: RoomContext, turn: Gathered): Promise<boolean> {
  const { end, wake, kept, mailed } = turn;
  if (end.outcome.kind !== "completed" || kept || mailed.size > 0 || !end.text.trim() || signalOf(end.text))
    return false;
  if (!wake.every((mail) => mail.needs === "nothing")) return false;
  const read = await room.forks.take("report", {
    report: excerpt(end.text, 2000),
    woke_by: wake.slice(0, 5).map((mail) => mail.subject),
  });
  return read === "nothing_new";
}

/** The reply to a handoff request: the room starts the successor and says so, with `council`'s line to the seat above; false when it did not. */
async function answerRotation(
  room: RoomContext,
  end: TurnEnd,
  record: SeatRecord,
  kept: NewMail | null,
  reportsTo: string | null,
  council: string | null,
): Promise<boolean> {
  const id = end.seat.id;
  const asked = room.rotations.get(id)!;
  const eng = room.engine;
  const handoff = end.outcome.kind === "completed" ? parseHandoff(end.text) : null;
  let problem =
    end.outcome.kind === "completed"
      ? "its reply was no handoff (CURRENT TASK and PROGRESS are needed)"
      : `its turn ${end.outcome.kind === "failed" ? "failed" : "was canceled"} before it wrote a handoff`;
  if (handoff) {
    room.rotations.starting(id);
    eng.pause(id);
    let next: Awaited<ReturnType<typeof rotate>> | undefined;
    const given = room.knowledge.forSuccessor(id);
    try {
      next = await rotate(
        {
          host: room.host,
          engine: eng,
          mark: (seat) => promptMark(seat, room.policy),
          fit: fitAt,
          up: stepUpAt,
          handOver: (from, to) => {
            room.knowledge.briefed(to);
            if (given) room.knowledge.inherited(to, given);
            // the key is read from the work store first, so a task the old seat claimed is the successor's too
            taskOf(room, from);
            room.taskKeys.succeed(from, to);
            releaseWork(room, from, to);
            room.safety.inherit(from, to);
          },
        },
        record,
        handoff,
        given?.lines,
        room.rounds.rejected(taskOf(room, id)),
      );
    } catch (error) {
      eng.unpause(id);
      await eng.deliver(id);
      problem = `its successor could not be started (${errorText(error)})`;
    }
    if (next) {
      room.rotations.done(id);
      try {
        // mail that came in while the successor started is the successor's
        await eng.move(id, next.id);
      } catch (error) {
        room.log(`rotation: mail held for ${id} did not move to ${next.id}: ${errorText(error)}`);
      } finally {
        eng.unpause(id);
      }
      if (kept && reportsTo) await eng.postReport({ ...kept, to: reportsTo });
      for (const told of new Set([asked.by, ...(reportsTo ? [reportsTo] : [])]))
        await eng.post({
          from: fromRoom,
          to: told,
          priority: "fyi",
          subject: `ROTATED: ${record.role} ${record.title ?? id} continues in a fresh seat`,
          body: `The room started ${nextTitle(record.title)} (${next.id}) on ${next.model}${next.raised ? " (a tier up: its task was sent back twice)" : ""}, with the brief in force and the handoff at ${next.file}. The seats the old one launched report to it now. ${next.left.length === 0 ? `The old seat ${id} is archived` : `The old seat ${id} is not archived, because these did not move to the successor: ${next.left.join("; ")}. Move them, then archive it`}: write to ${next.id} from here on.`,
          needs: "nothing",
          ...(told === reportsTo && council ? { why: council } : {}),
          quiet: true,
        });
      return true;
    }
  }
  room.rotations.done(id);
  await rotationFailed(room, asked.by, record, problem);
  return false;
}

/** The asker of a rotation hears that it did not happen, and why. */
export async function rotationFailed(room: RoomContext, by: string, seat: SeatRecord, problem: string): Promise<void> {
  if (!room.engine.seat(by)) return;
  await room.engine.post({
    from: fromRoom,
    to: by,
    priority: "action",
    subject: `ROTATION FAILED: ${seat.role} ${seat.title ?? seat.agentId} stays as it is`,
    body: `The room did not replace this seat: ${problem}. Ask again with seatwork_rotate, or brief a new seat yourself and archive this one.`,
    needs: "nothing",
  });
}

/** The hand-in check of a candidate, null when it is off; a check that fails to run says so and leaves the candidate to its Owner. */
async function checkHandIn(room: RoomContext, id: string): Promise<HandIn | null> {
  try {
    return await room.safety.handIn(id);
  } catch (error) {
    room.log(`the hand-in check of ${id} failed: ${errorText(error)}`);
    return { state: "partial", files: 0, open: [], acknowledged: [], warnings: [], why: "the check failed" };
  }
}

/** The council's reading of a turn; a council that cannot read it adds nothing. */
async function findingsOf(room: RoomContext, end: TurnEnd, role: string, task: string): Promise<Finding[]> {
  try {
    return await councilRead(room, end, role, task);
  } catch (error) {
    room.log(`the council could not read the turn of ${end.seat.id}: ${errorText(error)}`);
    return [];
  }
}

/** Puts the room's lines under what goes up; true when the council's is one. */
function addRoomLines(
  room: RoomContext,
  up: NewMail,
  turn: Gathered,
  check: HandIn | null,
  findings: readonly Finding[],
  gates: readonly string[],
): boolean {
  const { role, task, contextTokens } = turn;
  let lined = false;
  try {
    const guarded = [check ? handInLine(check) : null, ...gates, councilLine(findings)].filter(
      (line): line is string => !!line,
    );
    if (guarded.length) up.why = [up.why, ...guarded].filter(Boolean).join("; ");
    lined = findings.length > 0;
    const candidate = subjectSignal(up.subject) === "CANDIDATE";
    const line = ownerNote({
      role,
      candidate,
      rejected: candidate ? room.rounds.handedIn(task) : 0,
      contextTokens,
      rotateAtTokens: room.rotateAt,
    });
    if (line) up.why = [up.why, line.replace(/\s*\n\s*/g, " ")].filter(Boolean).join("; ");
  } catch (error) {
    room.log(`the room's own lines under the report of ${turn.end.seat.id} were not all added: ${errorText(error)}`);
  }
  return lined;
}

/** Mails the seat above each finding of a member whose level mails it, and notes each one told. */
async function mailCouncil(
  room: RoomContext,
  findings: readonly Finding[],
  reportsTo: string | null,
  title: string,
): Promise<void> {
  if (!reportsTo) return;
  for (const finding of findings.filter((one) => one.level >= 2)) {
    await room.engine.post({
      from: fromRoom,
      to: reportsTo,
      priority: "action",
      subject: `COUNCIL: ${finding.member} on ${title}`,
      body: finding.line,
      needs: "nothing",
    });
    noteShown(room, [finding]);
  }
}

/** Notes that the council's findings reached the seat above; a note that is not kept only lets them be said once more. */
function noteShown(room: RoomContext, findings: readonly Finding[]): void {
  try {
    room.safety.council.shown(findings);
  } catch (error) {
    room.log(`the council's findings told to the seat above were not noted: ${errorText(error)}`);
  }
}

/** A reviewer's report waits for its round; the last one says when one model family gave several answers to one question. */
async function holdForRound(room: RoomContext, up: NewMail, id: string): Promise<void> {
  const round = room.gate.reported(id);
  if (round) up.round = round.round;
  if (round && round.awaited > 0) {
    const minutes = Number(room.policy.room.params[REVIEW_STALL]) || 0;
    up.heldUntil = new Date(Date.now() + minutes * 60_000).toISOString();
    up.why = [up.why, `held for the ${round.awaited} other${round.awaited === 1 ? "" : "s"} of its review round`]
      .filter(Boolean)
      .join("; ");
  }
  const alike = round?.members && round.members.length > 1 ? await oneFamily(room, round.members) : 0;
  if (alike)
    up.why = [
      up.why,
      `${alike} answers to one question in this round came from one model family: their agreement is weak evidence, so ask one on another family before you rest on it`,
    ]
      .filter(Boolean)
      .join("; ");
}

/** The lines of a brief that say what it asks, not its angle. */
const briefLines = (brief: string) =>
  new Set(
    brief
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length >= 12),
  );

/** The most answers in a round that share their question and their model family; 0 for fewer than two. */
async function oneFamily(room: RoomContext, members: readonly string[]): Promise<number> {
  const seats = await Promise.all(
    members.map(async (id) => {
      const brief = room.briefs.get(id);
      const provider = room.engine.seat(id)?.provider ?? "";
      const model = await room.host
        .seat(id)
        .then((seat) => seat?.model ?? null)
        .catch(() => null);
      return { lines: brief ? briefLines(brief) : null, family: familyOf(model, provider.split("-")[0]) };
    }),
  );
  let most = 0;
  for (const [i, seat] of seats.entries()) {
    if (!seat.lines || !seat.family) continue;
    const alike = seats.filter((other, j) => {
      if (j === i || !other.lines || other.family !== seat.family) return false;
      const shared = [...seat.lines!].filter((line) => other.lines!.has(line)).length;
      return shared / Math.min(seat.lines!.size, other.lines.size) >= ALIKE_SHARE;
    }).length;
    if (alike > 0) most = Math.max(most, alike + 1);
  }
  return most;
}

/** What a turn's end sets going: the report up, a hand-in sent back once, a review round, a rotation. */
export async function turnEnded(room: RoomContext, end: TurnEnd): Promise<void> {
  const role = parseSeat(end.seat.provider)?.role;
  // only the room's own seats are read: the council's and the decision model's calls are no seats
  if (!role) return passOn(room, end.seat.id);
  const turn = await gather(room, end, role);
  if (!turn.reportsTo) oweOwner(room, turn);
  const out = await outgoing(room, turn);
  await readPushes(room, turn);
  if (await rotationAnswered(room, turn, out)) return;
  await sendOut(room, turn, out);
}

/** The end of a turn of an agent the room did not set up: what it left with the room is dropped, and mail held for it goes on. */
async function passOn(room: RoomContext, id: string): Promise<void> {
  room.engine.takeWake(id);
  room.engine.takeReport(id);
  room.mailedUp.delete(id);
  await room.engine.deliver(id);
}

/** Reads a room seat's turn: the districts that keep turns are handed it, the mail it ended with is taken, its spend counted and a failure mended. */
async function gather(room: RoomContext, end: TurnEnd, role: string): Promise<Gathered> {
  const id = end.seat.id;
  // the task is read once, so every part of this turn's end speaks of the same one
  const task = taskOf(room, id);
  noteTurn(room, end, role, task);
  // read before any wait: a delivery in that gap would be taken for this turn's
  const wake = room.engine.takeWake(id);
  const kept = room.engine.takeReport(id);
  const mailed = room.mailedUp.get(id) ?? new Set<string>();
  room.mailedUp.delete(id);
  const usage = await spent(room, end, role);
  const reportsTo = readerOf(room, end.seat, role);
  const failure = await mend(room, end);
  const contextTokens = usage?.contextWindowUsedTokens ?? null;
  return { end, role, task, reportsTo, wake, mailed, kept, failure, contextTokens };
}

/** Hands a turn to the districts that keep turns: the skills it loaded are counted and its record kept. */
function noteTurn(room: RoomContext, end: TurnEnd, role: string, task: string): void {
  try {
    room.operations.skillsLoaded(role, skillsLoaded(end.events));
  } catch (error) {
    room.log(`the skills ${end.seat.id} loaded were not counted: ${errorText(error)}`);
  }
  room.knowledge.turnEnded({
    agent: end.seat.id,
    parentId: end.seat.parentId,
    role,
    task,
    turnId: end.turnId,
    outcome: end.outcome.kind,
    events: end.events,
  });
}

/** Counts what a turn cost and reads a compaction the timeline did not show from the seat's context falling; the seat's usage, null when the app has none. */
async function spent(room: RoomContext, end: TurnEnd, role: string): Promise<SeatUsage | null> {
  const id = end.seat.id;
  const usage = (await room.host.seat(id).catch(() => null))?.usage ?? null;
  room.operations.spent(id, usage?.totalCostUsd, role, usage?.outputTokens);
  if (!usage) return null;
  const before = room.lastUsage.get(id);
  room.lastUsage.set(id, { ...usage });
  // one the timeline showed is not told twice
  if (contextFell(before, usage) && !end.events.some((event) => event.kind === "compaction"))
    room.knowledge.compacted(id);
  return usage;
}

/** A failed turn is the room's to mend first: a quota is waited out, a service error tried again; any other end is the Owner's word, and no retry stays planned. */
async function mend(room: RoomContext, end: TurnEnd): Promise<Failure | null> {
  const id = end.seat.id;
  const { outcome } = end;
  if (outcome.kind !== "failed") {
    room.recovery.forget(id);
    return null;
  }
  const failure = room.recovery.failed(id, outcome.error, Date.now(), await failureRead(room, outcome.error));
  if ("retry" in failure) room.log(`turn of ${id} failed (${failure.retry.kind}); the room resumes it, nobody is told`);
  return failure;
}

/** A seat nobody above reads by mail: the Owner reads its final message, and the app is told what it asks of them. */
function oweOwner(room: RoomContext, turn: Gathered): void {
  const { end, failure } = turn;
  if (end.outcome.kind === "canceled" || (failure && "retry" in failure)) return;
  const what = end.outcome.kind === "failed" ? "FAILED" : asksOwner(end.text);
  if (what)
    room.owed.set({
      key: `${end.seat.id}:${Date.now()}`,
      agentId: end.seat.id,
      title: end.seat.title,
      what,
      at: new Date().toISOString(),
    });
}

/** What a turn sends: the reports up with the room's lines under them, or the mail that returns a candidate to its seat in their place. */
async function outgoing(room: RoomContext, turn: Gathered): Promise<Outgoing> {
  const { end, role, task, reportsTo } = turn;
  const canceled = end.outcome.kind === "canceled";
  let kept = turn.kept;
  let report = reportsTo && !canceled ? reportOf(room, turn, reportsTo, await nothingNew(room, turn)) : null;
  const { check, returned: handedBack } = await readHandIn(room, turn, kept ?? report);
  const done = handedBack ? null : await readDone(room, turn, kept ?? report);
  const findings = canceled ? [] : await findingsOf(room, end, role, task);
  const returned = handedBack ?? done?.returned ?? null;
  if (returned) kept = report = null;
  const up = kept ?? report;
  const gates = up ? [done?.line, ...room.safety.owedUp(end.seat.id)].filter((line): line is string => !!line) : [];
  const lined = up ? addRoomLines(room, up, turn, check, findings, gates) : false;
  if (up && subjectSignal(up.subject) === "REVIEW") await holdForRound(room, up, end.seat.id);
  return { kept, report, returned, findings, lined };
}

/** The DONE gate's line under the report, or the DONE sent back when it blocks. */
async function readDone(
  room: RoomContext,
  turn: Gathered,
  up: NewMail | null,
): Promise<{ line: string | null; returned: NewMail | null } | null> {
  const { end, role } = turn;
  const signal = up ? subjectSignal(up.subject) : undefined;
  if (end.outcome.kind !== "completed" || traits(role).briefs !== true || !signal || !CLOSES_WORK.has(signal))
    return null;
  const id = end.seat.id;
  const gate = await room.safety.done({ seat: id, cwd: end.seat.cwd, events: end.events }).catch((error) => {
    room.log(`safety: the done gate on ${id} could not run: ${errorText(error)}`);
    return null;
  });
  if (!gate) return null;
  if (gate.gaps.length === 0) {
    gate.keep();
    return null;
  }
  const lines = gate.gaps.map((gap) => gap.line);
  if (gate.mode === "warn") return { line: `[room] done gate: ${lines.join("; ")}`, returned: null };
  return {
    line: null,
    returned: returnOf(
      id,
      `DONE RETURNED: ${lines.length} gap(s) from the room's done gate`,
      lines.map((line) => `- ${line}`).join("\n"),
    ),
  };
}

/** Keeps a turn's pushes; tells HQ and the Owner of commits no gate holds. */
async function readPushes(room: RoomContext, turn: Gathered): Promise<void> {
  const { end, role } = turn;
  const id = end.seat.id;
  const pushed = await room.safety.pushes({ seat: id, cwd: end.seat.cwd, events: end.events }).catch((error) => {
    room.log(`safety: the pushes of ${id} were not read: ${errorText(error)}`);
    return [];
  });
  const owner = room.engine.parentOf(id);
  for (const push of pushed) {
    if (!push.uncovered?.length) continue;
    const count = push.more ? `more than ${push.uncovered.length}` : String(push.uncovered.length);
    room.operations.raise(
      `safety: ${role} ${id} pushed ${count} commit(s) no ACCEPT covers to ${push.remote} ${push.ref}`,
      UNACCEPTED_PUSH,
    );
    if (!owner || !room.engine.seat(owner)) continue;
    await room.engine.post({
      from: fromRoom,
      to: owner,
      priority: "action",
      subject: `UNACCEPTED PUSH: ${end.seat.title ?? id} pushed ${count} commit(s) no ACCEPT covers`,
      body: `${push.remote} ${push.ref} at ${push.sha.slice(0, 8)}: ${push.uncovered.map((sha) => sha.slice(0, 8)).join(", ")}${push.more ? ", …" : ""}`,
      needs: "nothing",
    });
  }
}

/** The room's read of a candidate before its Owner's: one pass with fresh eyes first, then the hand-in check, whose blocking findings return it; the check, and the mail that returns the candidate. */
async function readHandIn(
  room: RoomContext,
  turn: Gathered,
  handIn: NewMail | null,
): Promise<{ check: HandIn | null; returned: NewMail | null }> {
  const { end, role, task } = turn;
  const id = end.seat.id;
  const candidate =
    traits(role).writes === true &&
    end.outcome.kind === "completed" &&
    !!handIn &&
    subjectSignal(handIn.subject) === "CANDIDATE";
  if (!candidate) return { check: null, returned: null };
  if (room.policy.room.handin.freshEyes && room.rounds.owesFreshEyes(task))
    return {
      check: null,
      returned: returnOf(id, "HAND-IN RETURNED: one pass with fresh eyes, then hand in again", FRESH_EYES),
    };
  const check = await checkHandIn(room, id);
  if (check?.state !== "blocked" || !room.safety.handInBlocks) return { check, returned: null };
  return {
    check,
    returned: returnOf(
      id,
      `HAND-IN RETURNED: ${check.open.length} finding(s) from the room's check`,
      handInReturn(check),
    ),
  };
}

/** The room's mail that returns a candidate to its seat, and waits for its reply. */
const returnOf = (to: string, subject: string, body: string): NewMail => ({
  from: fromRoom,
  to,
  priority: "action",
  subject,
  body,
  needs: "reply",
});

/** Answers the rotation asked of a seat whose handoff this turn is, the council's findings going with it; true when its successor started. */
async function rotationAnswered(room: RoomContext, turn: Gathered, out: Outgoing): Promise<boolean> {
  const { end, wake, reportsTo } = turn;
  const id = end.seat.id;
  const asked = room.rotations.get(id);
  const record = room.engine.seat(id);
  if (!asked || !record || !wake.some((mail) => mail.id === asked.mailId)) return false;
  // the handoff is the old seat's last word: only the report it kept goes up, with the room's lines under it; with none kept, the council's line goes with the word of the rotation
  const carried = out.kept ? null : councilLine(out.findings);
  if (!(await answerRotation(room, end, record, out.kept, reportsTo, carried))) return false;
  await mailCouncil(room, out.findings, reportsTo, end.seat.title ?? id);
  if (reportsTo && (out.kept ? out.lined : carried)) noteShown(room, out.findings);
  return true;
}

/** Sends what a turn's end owes: the mail that returns a candidate, the council's word to the seat above, the mail held for the seat, and the reports up. */
async function sendOut(room: RoomContext, turn: Gathered, out: Outgoing): Promise<void> {
  const eng = room.engine;
  const { end, reportsTo } = turn;
  const id = end.seat.id;
  if (out.returned) await eng.post(out.returned);
  await mailCouncil(room, out.findings, reportsTo, end.seat.title ?? id);
  await eng.deliver(id);
  if (!reportsTo) return;
  if (out.kept || out.report) eng.dropProgress(id, reportsTo);
  // the report the seat mailed before its turn ended goes out now, however the turn ended
  if (out.kept) await eng.postReport({ ...out.kept, to: reportsTo });
  if (out.report) await eng.post(out.report);
  if (out.lined) noteShown(room, out.findings);
}
