import { traits } from "../../shared/workflow";
import { fromTemplate } from "../orchestration/brief";
import { briefInForce } from "../orchestration/rotation";
import type { Finding, Verdict } from "../safety/council/council";
import { subjectOpening, verdictOf } from "../signals";
import { taskOf, type RoomContext } from "./context";
import type { TurnEnd } from "./turns";

/** What the room gathers for the council about a turn that ended; the Safety district reads it. */

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
    });
  }
  return out;
}

/** The council's reading of an ended turn: what is to be shown with its report. */
export async function councilRead(room: RoomContext, end: TurnEnd, role: string): Promise<Finding[]> {
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
      task: taskOf(room, id),
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
