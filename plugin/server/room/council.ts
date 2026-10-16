import { traits } from "../../shared/workflow";
import type { LiveSeat } from "../host";
import { fromTemplate } from "../orchestration/brief";
import { briefInForce } from "../orchestration/rotation";
import type { Finding, Verdict } from "../safety/council/council";
import { subjectOpening, verdictOf } from "../signals";
import { fromRoom, taskOf, type RoomContext } from "./context";
import type { TurnEnd } from "./turns";

/** What the room gathers for the council about turns, ended and running; the Safety district reads it. */

const HISTORY = 4000;

/** A seat's brief in force: kept from its own turns as they pass, else read once from its history. */
async function briefOf(room: RoomContext, seat: string, prompts: readonly string[] = []): Promise<string | null> {
  const fresh = prompts.findLast(fromTemplate);
  if (fresh) room.briefs.set(seat, fresh);
  else if (!room.briefs.has(seat)) {
    const read = await room.host.prompts(seat, HISTORY).catch(() => null);
    const brief = read ? briefInForce(read) : null;
    if (brief) room.briefs.set(seat, brief);
  }
  return room.briefs.get(seat) ?? null;
}

/** The verdicts a seat mailed in its turn, with what the room knows of each piece of work. */
async function verdictsOf(room: RoomContext, seat: string, since: number): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (const line of room.engine.posted(new Date(since).toISOString())) {
    if (line.from !== seat || !room.engine.seat(line.to)) continue;
    const verdict = verdictOf(subjectOpening(line.subject));
    if (verdict !== "accepted" && verdict !== "returned") continue;
    const task = taskOf(room, line.to);
    const usage = room.lastUsage.get(line.to);
    out.push({
      to: line.to,
      accepted: verdict === "accepted",
      brief: await briefOf(room, line.to),
      task,
      rejected: room.rounds.rejected(task),
      contextTokens: usage?.contextWindowUsedTokens ?? null,
      costUsd: usage?.totalCostUsd ?? null,
      work: await room.safety.verdictOn(line.to, verdict === "accepted").catch(() => null),
    });
  }
  return out;
}

/** The council's reading of an ended turn on `task`: what is to be shown with its report. */
export async function councilRead(room: RoomContext, end: TurnEnd, role: string, task: string): Promise<Finding[]> {
  const council = room.safety.council;
  if (!council.on) return [];
  const id = end.seat.id;
  const kinds = traits(role);
  const since = council.startOf(id);
  const prompts = end.events.flatMap((event) => (event.kind === "prompt" ? [event.text] : []));
  const brief = kinds.briefed || kinds.reviews ? await briefOf(room, id, prompts) : null;
  const verdicts = kinds.briefs && since !== null ? await verdictsOf(room, id, since) : [];
  const tree = kinds.writes ? await council.changedIn(id) : null;
  return council.endOfTurn({
    seat: {
      id,
      role,
      traits: kinds,
      root: tree?.root ?? room.engine.projectOf(id) ?? end.seat.cwd,
      task,
    },
    turn: end.turnId,
    events: end.events,
    text: end.text,
    brief,
    verdicts,
    changed: tree?.files ?? null,
  });
}

/** The council's line under a report, one member a part. */
export const councilLine = (findings: readonly Finding[]): string | null =>
  findings.length ? `[council] ${findings.map((finding) => finding.line).join("; ")}` : null;

/** The council's look at one running turn: loops and silence, told to the seat above. */
async function lookAt(room: RoomContext, id: string, live: LiveSeat): Promise<void> {
  const { engine, host, safety } = room;
  const events = await host.turn(id, 60);
  if (!events) return;
  const { role } = engine.seat(id)!;
  const seat = {
    id,
    role,
    traits: traits(role),
    root: engine.projectOf(id) ?? live.cwd,
    task: taskOf(room, id),
  };
  const reader = engine.parentOf(id);
  for (const finding of safety.council.whileRunning(seat, events))
    if (reader)
      await engine.post({
        from: fromRoom,
        to: reader,
        priority: "action",
        subject: `COUNCIL: ${finding.member} on ${live.title ?? id}`,
        body: finding.line,
        needs: "nothing",
        why: "the room's council saw a running turn of a seat under you",
      });
}

/** The council's look at the turns now running; a seat that cannot be looked at is logged and the others are still looked at. */
export async function lookAtRunningTurns(room: RoomContext): Promise<void> {
  for (const [id, live] of await room.host.live()) {
    if (live.status !== "running" || !room.engine.seat(id)) continue;
    try {
      await lookAt(room, id, live);
    } catch (error) {
      room.log(`the council could not look at ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
