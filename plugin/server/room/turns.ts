import { REVIEW_STALL, routeOpen, traits } from "../../shared/workflow";
import type { Mail, NewMail, Needs, Priority, SeatRecord } from "../coordination/engine";
import type { TurnEvent, TurnOutcome } from "../host";
import { contextFell } from "../orchestration/compaction";
import { clip } from "../orchestration/forks";
import { classify, type FailureKind } from "../orchestration/recovery";
import { atMilestone, nextTitle, parseHandoff, rotate } from "../orchestration/rotation";
import { familyOf } from "../orchestration/models";
import { skillsLoaded } from "../orchestration/runtimes";
import { FRESH_EYES, ownerNote } from "../orchestration/rounds";
import { parseSeat } from "../orchestration/seats";
import { handInLine, handInReturn, type HandIn } from "../safety/handin";
import { asksOwner, DECIDES, signalOf, subjectSignal } from "../signals";
import type { Finding } from "../safety/council/council";
import { errorText, fromRoom, releaseWork, taskOf, type RoomContext } from "./context";
import { councilLine, councilRead } from "./council";
import { fitAt, stepUpAt } from "./launch";

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

/** What the room gathered about a turn before it decides what goes up. */
interface Gathered {
  role: string;
  reportsTo: string;
  wake: readonly Mail[];
  mailed: ReadonlySet<string>;
  kept: NewMail | null;
  failure: ReturnType<RoomContext["recovery"]["failed"]> | null;
  nothingNew: boolean;
}

const ALIKE_SHARE = 0.6;

/** True when a turn was started by mail and none of it asked the seat for anything. */
function askedNothing(wake: readonly Mail[]): boolean {
  return (
    wake.length > 0 &&
    wake.every((mail) => mail.needs === "nothing" && (mail.priority === "fyi" || mail.senderRole === "system"))
  );
}

/** The seat above that reads this seat's turns by mail; null where the route up is off. */
function readerOf(room: RoomContext, seat: SeatEvent, role: string): string | null {
  const parentId = room.engine.parentOf(seat.id) ?? seat.parentId;
  const parent = parentId ? room.engine.seat(parentId) : undefined;
  return parent && routeOpen(role, parent.role) ? parent.agentId : null;
}

/** The report a turn's end sends up; null when the seat's own mail already carried it. */
function reportOf(room: RoomContext, end: TurnEnd, about: Gathered): NewMail | null {
  const { role, reportsTo: to, wake, mailed, kept, failure, nothingNew } = about;
  const { seat, outcome, text } = end;
  const name = `${role} ${seat.title ?? seat.id}`;
  const signal = signalOf(text);
  const repeats = signal !== undefined && room.lastSignal.get(seat.id) === signal;
  // a first report carries the plan; a STATUS after it asks nothing of the seat above
  let progress = signal === "STATUS" && traits(role).progress === true && room.lastSignal.has(seat.id);
  if (signal) room.lastSignal.set(seat.id, signal);
  let priority: Priority = "fyi";
  let subject = `${signal ?? "turn ended"}: ${name}`;
  let needs: Needs = "nothing";
  let quiet = signal === "ACK" || progress;
  if (outcome.kind === "failed") {
    if (failure && "retry" in failure) return null;
    priority = "blocking";
    subject = `FAILED: ${outcome.error.slice(0, 120)}`;
    needs = "decision";
    quiet = progress = false;
  } else if (signal ? mailed.has(signal) : kept) {
    room.log(
      `turn end of ${seat.id}: the seat mailed ${signal ?? "its report"} to its parent itself, so nothing more goes up`,
    );
    return null;
  } else if (signal && signal !== "STATUS" && signal !== "ACK") {
    priority = "action";
    subject = `${signal} from ${name}`;
    needs = DECIDES.has(signal) ? "decision" : "reply";
    // DONE again, in a turn started only by mail that asked nothing: the parent has it already
    if (signal === "DONE" && repeats && askedNothing(wake)) {
      priority = "fyi";
      needs = "nothing";
      quiet = true;
    }
  } else if (nothingNew) quiet = true;
  const tries = failure && "gaveUpAfter" in failure && failure.gaveUpAfter > 0;
  return {
    from: { agentId: seat.id, role },
    to,
    priority,
    subject,
    body: text || `(no final message; outcome ${outcome.kind})`,
    needs,
    why:
      outcome.kind === "failed"
        ? `the seat's turn failed${tries ? `, and again after the room's ${failure.gaveUpAfter} tries` : ""}; its work is stopped: a mail to it starts it again, or archive it and brief a new seat`
        : progress
          ? "progress only: the seat ended its turn with STATUS and asks nothing of you"
          : quiet
            ? `nothing new: ${nothingNew ? "the decision model read the report as nothing for you to act on" : `the seat ended its turn with ${signal === "ACK" ? "an acknowledgement" : "DONE again, after mail that asked nothing"}`}`
            : `the seat ended its turn with ${signal ?? "a progress message"}`,
    ...(quiet ? { quiet: true as const } : {}),
    ...(progress ? { progress: true as const } : {}),
  };
}

/** A failure the room's own rule calls a passing fault, read by the decision model: the kind it is sure of, or null. */
async function failureRead(room: RoomContext, error: string): Promise<FailureKind | null> {
  if (classify(error, Date.now()).kind !== "service") return null;
  return (await room.forks.take("failure", { error: clip(error, 300) })) as FailureKind | null;
}

/** Whether a report with no protocol word, from a turn whose mail asked nothing, brings its reader nothing to act on. */
async function nothingNew(
  room: RoomContext,
  end: TurnEnd,
  wake: readonly Mail[],
  kept: NewMail | null,
  mailed: ReadonlySet<string>,
): Promise<boolean> {
  if (end.outcome.kind !== "completed" || kept || mailed.size > 0 || !end.text.trim() || signalOf(end.text))
    return false;
  if (!wake.every((mail) => mail.needs === "nothing")) return false;
  const read = await room.forks.take("report", {
    report: clip(end.text, 2000),
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
          version: room.version,
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
          why: [
            "a seat under you was replaced by a fresh one",
            ...(told === reportsTo && council ? [council] : []),
          ].join("; "),
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
    why: "the rotation you asked for did not happen",
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

/** Puts the room's own lines under what goes up (the guard's, the council's, the round's, the context's); true when the council's is among them, and a line that cannot be made is left out. */
function addRoomLines(
  room: RoomContext,
  up: NewMail,
  about: {
    role: string;
    id: string;
    task: string;
    contextTokens: number | null;
    early: boolean;
    check: HandIn | null;
    findings: readonly Finding[];
  },
): boolean {
  const { role, id, task, contextTokens, early, check, findings } = about;
  let lined = false;
  try {
    const guarded = [check ? handInLine(check) : null, councilLine(findings)].filter((line): line is string => !!line);
    if (guarded.length) up.why = [up.why, ...guarded].filter(Boolean).join("; ");
    lined = findings.length > 0;
    const candidate = subjectSignal(up.subject) === "CANDIDATE";
    const line = ownerNote({
      role,
      candidate,
      rejected: candidate ? room.rounds.handedIn(task) : 0,
      contextTokens,
      rotateAtTokens: room.rotateAt,
      early,
    });
    if (line) up.why = [up.why, line.replace(/\s*\n\s*/g, " ")].filter(Boolean).join("; ");
  } catch (error) {
    room.log(`the room's own lines under the report of ${id} were not all added: ${errorText(error)}`);
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
      why: "the room's council read a turn of a seat under you",
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
    up.why = `${up.why}; held for the ${round.awaited} other${round.awaited === 1 ? "" : "s"} of its review round`;
  }
  const alike = round?.members && round.members.length > 1 ? await oneFamily(room, round.members) : 0;
  if (alike)
    up.why = `${up.why}; ${alike} answers to one question in this round came from one model family: their agreement is weak evidence, so ask one on another family before you rest on it`;
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
  const eng = room.engine;
  const { seat, outcome } = end;
  const id = seat.id;
  const role = parseSeat(seat.provider)?.role;
  // the task is read once, so every part of this turn's end speaks of the same one
  const task = role ? taskOf(room, id) : id;
  if (role)
    try {
      room.operations.skillsLoaded(role, skillsLoaded(end.events));
    } catch (error) {
      room.log(`the skills ${id} loaded were not counted: ${errorText(error)}`);
    }
  // only the room's own seats are kept: the council's and the decision model's calls are no seats
  if (role)
    room.knowledge.turnEnded({
      agent: id,
      parentId: seat.parentId,
      role,
      task,
      turnId: end.turnId,
      outcome: outcome.kind,
      events: end.events,
    });
  // read before any wait: a delivery in that gap would be taken for this turn's
  const wake = eng.takeWake(id);
  let kept = eng.takeReport(id);
  const mailed = room.mailedUp.get(id) ?? new Set<string>();
  room.mailedUp.delete(id);
  const usage = role ? ((await room.host.seat(id).catch(() => null))?.usage ?? null) : null;
  if (role) room.operations.spent(id, usage?.totalCostUsd, role, usage?.outputTokens);
  if (usage) {
    const before = room.lastUsage.get(id);
    room.lastUsage.set(id, { ...usage });
    // a compaction the timeline did not show is read from the seat's context falling; one it showed is not told twice
    if (contextFell(before, usage) && !end.events.some((event) => event.kind === "compaction"))
      room.knowledge.compacted(id);
  }
  const reportsTo = role ? readerOf(room, seat, role) : null;
  const canceled = outcome.kind === "canceled";
  // a failed turn is the room's to mend first: a quota is waited out, a service error tried again
  const failure =
    role && outcome.kind === "failed"
      ? room.recovery.failed(id, outcome.error, Date.now(), await failureRead(room, outcome.error))
      : null;
  const retried = failure !== null && "retry" in failure;
  if (retried) room.log(`turn of ${id} failed (${failure.retry.kind}); the room resumes it, nobody is told`);
  // a stopped turn is the Owner's word: no retry planned before it starts the seat again
  if (role && outcome.kind !== "failed") room.recovery.forget(id);
  // a seat nobody above reads by mail: the Owner reads its final message, and the app is told
  if (role && !reportsTo && !canceled && !retried) {
    const what = outcome.kind === "failed" ? "FAILED" : asksOwner(end.text);
    if (what)
      room.owed.set({ key: `${id}:${Date.now()}`, agentId: id, title: seat.title, what, at: new Date().toISOString() });
  }
  let report =
    role && reportsTo && !canceled
      ? reportOf(room, end, {
          role,
          reportsTo,
          wake,
          mailed,
          kept,
          failure,
          nothingNew: await nothingNew(room, end, wake, kept, mailed),
        })
      : null;
  // a writing seat's candidate goes back to it once, for a pass with fresh eyes, before its Owner reads it
  const handIn = kept ?? report;
  const candidate =
    traits(role).writes === true &&
    outcome.kind === "completed" &&
    !!handIn &&
    subjectSignal(handIn.subject) === "CANDIDATE";
  const rereads = candidate && room.policy.room.handin?.freshEyes === true && room.rounds.owesFreshEyes(task);
  if (rereads) kept = report = null;
  // the room reads a writing seat's candidate first; a blocking finding sends it back
  const check = candidate && !rereads ? await checkHandIn(room, id) : null;
  const sendBack = check?.state === "blocked" && room.safety.handInBlocks;
  // the council reads the turn; a member that has earned it speaks under the report, or to the seat above
  const findings = role && !canceled ? await findingsOf(room, end, role, task) : [];
  if (sendBack) kept = report = null;
  const up = kept ?? report;
  const contextTokens = usage?.contextWindowUsedTokens ?? null;
  // a seat nearing the rotation line is replaced at a milestone, not in the middle of its work
  const early =
    role && up && outcome.kind === "completed" && !room.rotations.get(id)
      ? await atMilestone(room.forks, { role, tokens: contextTokens, message: end.text }, room.rotateAt)
      : false;
  const lined = role && up ? addRoomLines(room, up, { role, id, task, contextTokens, early, check, findings }) : false;
  if (up && subjectSignal(up.subject) === "REVIEW") await holdForRound(room, up, id);
  const asked = room.rotations.get(id);
  const record = eng.seat(id);
  if (asked && record && wake.some((mail) => mail.id === asked.mailId)) {
    // the handoff is the old seat's last word: only the report it kept goes up, with the room's lines under it; with none kept, the council's line goes with the word of the rotation
    const carried = kept ? null : councilLine(findings);
    if (await answerRotation(room, end, record, kept, reportsTo, carried)) {
      await mailCouncil(room, findings, reportsTo, seat.title ?? id);
      if (reportsTo && (kept ? lined : carried)) noteShown(room, findings);
      return;
    }
  }
  if (rereads)
    await eng.post({
      from: fromRoom,
      to: id,
      priority: "action",
      subject: "HAND-IN RETURNED: one pass with fresh eyes, then hand in again",
      body: FRESH_EYES,
      needs: "reply",
      why: "the room returns a first hand-in once before the Owner reads it",
    });
  if (sendBack && check)
    await eng.post({
      from: fromRoom,
      to: id,
      priority: "action",
      subject: `HAND-IN RETURNED: ${check.open.length} finding(s) from the room's check`,
      body: handInReturn(check),
      needs: "reply",
      why: "the room reads a candidate before its Owner does",
    });
  await mailCouncil(room, findings, reportsTo, seat.title ?? id);
  // held mail may now start the next turn
  await eng.deliver(id);
  if (!reportsTo) return;
  // a newer report takes the place of this seat's progress report that still waits unread
  if (kept || report) eng.dropProgress(id, reportsTo);
  // the report the seat mailed before its turn ended goes out now, however the turn ended
  if (kept) await eng.postReport({ ...kept, to: reportsTo });
  if (report) await eng.post(report);
  if (lined) noteShown(room, findings);
}
