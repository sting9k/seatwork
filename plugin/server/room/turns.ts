import { REVIEW_STALL, routeOpen, traits } from "../../shared/workflow";
import type { Mail, NewMail, Needs, Priority, SeatRecord } from "../coordination/engine";
import type { TurnOutcome } from "../host";
import { nextTitle, parseHandoff, rotate } from "../orchestration/rotation";
import { FRESH_EYES, ownerNote } from "../orchestration/rounds";
import { parseSeat } from "../orchestration/seats";
import { asksOwner, DECIDES, signalOf, subjectSignal } from "../signals";
import { noteUsage } from "../stats";
import type { SeatView } from "../watch/watcher";
import { fromRoom, releaseWork, taskOf, type RoomContext } from "./context";
import { fitAt } from "./launch";

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
}


/** True when a turn was started by mail and none of it asked the seat for anything. */
function askedNothing(wake: readonly Mail[]): boolean {
  return (
    wake.length > 0 &&
    wake.every((mail) => mail.needs === "nothing" && (mail.priority === "fyi" || mail.senderRole === "system"))
  );
}

/** A seat as the watcher sees it; null for an agent that is not a room seat. */
export function viewOf(room: RoomContext, seat: SeatEvent): SeatView | null {
  const role = parseSeat(seat.provider)?.role;
  if (!role) return null;
  const parent = room.engine.parentOf(seat.id) ?? seat.parentId;
  return {
    agentId: seat.id,
    role,
    title: seat.title,
    cwd: seat.cwd,
    parent,
    parentRole: (parent && room.engine.seat(parent)?.role) || null,
  };
}

/** The seat above that reads this seat's turns by mail; null where the route up is off. */
function readerOf(room: RoomContext, seat: SeatEvent, role: string): string | null {
  const parentId = room.engine.parentOf(seat.id) ?? seat.parentId;
  const parent = parentId ? room.engine.seat(parentId) : undefined;
  return parent && routeOpen(role, parent.role) ? parent.agentId : null;
}

/** The report a turn's end sends up; null when the seat's own mail already carried it. */
function reportOf(
  room: RoomContext,
  end: TurnEnd,
  role: string,
  to: string,
  wake: readonly Mail[],
  mailed: ReadonlySet<string>,
  kept: NewMail | null,
  failure: ReturnType<RoomContext["recovery"]["failed"]> | null,
): NewMail | null {
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
    room.log(`turn end of ${seat.id} not mailed again: the seat mailed ${signal ?? "its report"} to its parent itself`);
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
  }
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
            ? `nothing new: the seat ended its turn with ${signal === "ACK" ? "an acknowledgement" : "DONE again, after mail that asked nothing"}`
            : `the seat ended its turn with ${signal ?? "a progress message"}`,
    ...(quiet ? { quiet: true as const } : {}),
    ...(progress ? { progress: true as const } : {}),
  };
}

/** The reply to a handoff request: the room starts the successor and says so; false when it did not. */
async function answerRotation(
  room: RoomContext,
  end: TurnEnd,
  record: SeatRecord,
  kept: NewMail | null,
  reportsTo: string | null,
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
    try {
      const next = await rotate(
        {
          host: room.host,
          engine: eng,
          version: room.version,
          fit: fitAt,
          handOver: (from, to) => {
            room.rounds.move(from, to);
            releaseWork(room, from, to);
          },
        },
        record,
        handoff,
      );
      room.rotations.done(id);
      // mail that came in while the successor started is the successor's
      await eng.move(id, next.id);
      eng.unpause(id);
      room.watcher.forget(id);
      if (kept && reportsTo) await eng.post({ ...kept, to: reportsTo });
      for (const told of new Set([asked.by, ...(reportsTo ? [reportsTo] : [])]))
        await eng.post({
          from: fromRoom,
          to: told,
          priority: "fyi",
          subject: `ROTATED: ${record.role} ${record.title ?? id} continues in a fresh seat`,
          body: `The room started ${nextTitle(record.title)} (${next.id}) on ${next.model}, with the brief in force and the handoff at ${next.file}. The seats the old one launched report to it now. ${next.left.length === 0 ? `The old seat ${id} is archived` : `The old seat ${id} is not archived, because these did not move to the successor: ${next.left.join("; ")}. Move them, then archive it`}: write to ${next.id} from here on.`,
          needs: "nothing",
          why: "a seat under you was replaced by a fresh one",
          quiet: true,
        });
      return true;
    } catch (error) {
      eng.unpause(id);
      await eng.deliver(id);
      problem = `its successor could not be started (${error instanceof Error ? error.message : String(error)})`;
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

/** What a turn's end sets going: the report up, a hand-in sent back once, a review round, a rotation. */
export async function turnEnded(room: RoomContext, end: TurnEnd): Promise<void> {
  const eng = room.engine;
  const { seat, outcome } = end;
  const id = seat.id;
  const role = parseSeat(seat.provider)?.role;
  // read before any wait: a delivery in that gap would be taken for this turn's
  const wake = eng.takeWake(id);
  let kept = eng.takeReport(id);
  const mailed = room.mailedUp.get(id) ?? new Set<string>();
  room.mailedUp.delete(id);
  const usage = role ? noteUsage(await room.host.seat(id).catch(() => null), role) : null;
  if (usage) room.lastUsage.set(id, usage);
  const reportsTo = role ? readerOf(room, seat, role) : null;
  const canceled = outcome.kind === "canceled";
  // a failed turn is the room's to mend first: a quota is waited out, a service error tried again
  const failure = role && outcome.kind === "failed" ? room.recovery.failed(id, outcome.error, Date.now()) : null;
  const retried = failure !== null && "retry" in failure;
  if (retried) room.log(`turn of ${id} failed (${failure.retry.kind}); the room resumes it, nobody is told`);
  if (role && outcome.kind === "completed") room.recovery.forget(id);
  // a seat nobody above reads by mail: the Owner reads its final message, and the app is told
  if (role && !reportsTo && !canceled && !retried) {
    const what = outcome.kind === "failed" ? "FAILED" : asksOwner(end.text);
    if (what)
      room.owed.set({ key: `${id}:${Date.now()}`, agentId: id, title: seat.title, what, at: new Date().toISOString() });
  }
  let report =
    role && reportsTo && !canceled ? reportOf(room, end, role, reportsTo, wake, mailed, kept, failure) : null;
  // a writing seat's candidate goes back to it once, for a pass with fresh eyes, before its Owner reads it
  const handIn = kept ?? report;
  const rereads =
    traits(role).writes === true &&
    outcome.kind === "completed" &&
    room.policy.room.handin?.freshEyes === true &&
    !!handIn &&
    subjectSignal(handIn.subject) === "CANDIDATE" &&
    room.rounds.owesFreshEyes(taskOf(room, id));
  if (rereads) kept = report = null;
  // under what goes up, the room's own line: the task's round, and a context past the rotation line
  const up = kept ?? report;
  if (role && up) {
    const candidate = subjectSignal(up.subject) === "CANDIDATE";
    const line = ownerNote({
      role,
      candidate,
      rejected: candidate ? room.rounds.handedIn(taskOf(room, id)) : 0,
      contextTokens: usage?.contextWindowUsedTokens ?? null,
      rotateAtTokens: room.rotateAt,
    });
    if (line) up.why = [up.why, line.replace(/\s*\n\s*/g, " ")].filter(Boolean).join("; ");
  }
  // a reviewer's report waits for the others of its round: the Owner reads the round in one turn
  if (up && subjectSignal(up.subject) === "REVIEW") {
    const round = room.gate.reported(id);
    if (round) up.round = round.round;
    if (round && round.awaited > 0) {
      const minutes = Number(room.policy.room.params[REVIEW_STALL]) || 0;
      up.heldUntil = new Date(Date.now() + minutes * 60_000).toISOString();
      up.why = `${up.why}; held for the ${round.awaited} other${round.awaited === 1 ? "" : "s"} of its review round`;
    }
  }
  const asked = room.rotations.get(id);
  const record = eng.seat(id);
  if (asked && record && wake.some((mail) => mail.id === asked.mailId)) {
    // the handoff is the old seat's last word: nothing more goes up from it
    if (await answerRotation(room, end, record, kept, reportsTo)) return;
  }
  // the watcher reads the turn before anything goes up: its notice rides with the report, or goes alone
  const view = canceled ? null : viewOf(room, seat);
  // what the watcher saw in a hand-in that went back rides with the hand-in that follows
  const carried = rereads || [kept, report].some((mail) => mail && !mail.quiet);
  if (view) await room.watcher.turnEnded(view, end.turnId, carried);
  else room.watcher.forget(id);
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
  // the watcher has read the turn: held mail may now start the next one
  await eng.deliver(id);
  if (!reportsTo) return;
  // a newer report takes the place of this seat's progress report that still waits unread
  if (kept || report) eng.dropProgress(id, reportsTo);
  // the report the seat mailed before its turn ended goes out now, however the turn ended
  if (kept) await eng.post({ ...kept, to: reportsTo });
  if (report) await eng.post(report);
}
