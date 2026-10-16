import vocabulary from "../../shared/work.json";
import type { MailEngine } from "../coordination/engine";
import type { Host, LiveSeat, SeatUsage } from "../host";
import type { Jev } from "../jev/index";
import type { Forks } from "../orchestration/forks";
import type { Knowledge } from "../knowledge/index";
import { clip } from "../orchestration/forks";
import type { Operations } from "../operations/index";
import type { Recovery } from "../orchestration/recovery";
import type { ReviewGate } from "../orchestration/review-gate";
import type { Rotations } from "../orchestration/rotation";
import type { Rounds } from "../orchestration/rounds";
import type { TaskKeys } from "../orchestration/task-keys";
import type { RuntimePolicy } from "../policy";
import type { Safety } from "../safety/index";
import type { OwedList } from "./status";
import type { Lapsed, Seating } from "../tasks/store";
import type { WorkStores } from "../tasks/stores";
import type { Callers } from "./callers";

/** What the parts of a running room share: the districts, the app, and per seat its mail up this turn, last signal, last usage and brief. */
export interface RoomContext {
  host: Host;
  policy: RuntimePolicy;
  version: string;
  log(message: string): void;
  engine: MailEngine;
  works: WorkStores;
  rounds: Rounds;
  taskKeys: TaskKeys;
  gate: ReviewGate;
  recovery: Recovery;
  rotations: Rotations;
  owed: OwedList;
  callers: Callers;
  safety: Safety;
  jev: Jev;
  forks: Forks;
  knowledge: Knowledge;
  operations: Operations;
  operators: Set<string>;
  mailedUp: Map<string, Set<string>>;
  lastSignal: Map<string, string>;
  lastUsage: Map<string, SeatUsage>;
  briefs: Map<string, string>;
  rotateAt: number;
  addSeats(providers: string[]): Promise<void>;
}

const HELD_MOST = 8;
const TITLE_SHOWN = 80;
const DOWN_MS = vocabulary.leaseDownHours * 3_600_000;
const OPENING_MS = vocabulary.leaseMinutes * 60_000;

/** The issues a seat holds in progress in its project's work store; none when the store cannot be read. */
function held(room: RoomContext, seat: string): string[] {
  try {
    const store = room.works.existing(room.engine.projectOf(seat));
    return (
      store?.list({ assignee: seat, status: "in_progress", limit: HELD_MOST }).issues.map((issue) => issue.id) ?? []
    );
  } catch {
    return [];
  }
}

/** The task a seat works on, as a key that stays through its issue's states and its rotations. */
export function taskOf(room: RoomContext, seat: string): string {
  return room.taskKeys.of(seat, held(room, seat));
}

/** What a seat held goes to the seat that follows it, or is open again. */
export function releaseWork(room: RoomContext, from: string, to: string | null): void {
  const store = room.works.existing(room.engine.projectOf(from));
  const moved = store?.release(from, to, "room") ?? [];
  if (moved.length > 0) room.log(`work: ${moved.join(", ")} of ${from} ${to ? `now held by ${to}` : "open again"}`);
}

/** Whether the app shows a seat closed or failed for longer than a claim is kept for such a seat, or still opening for longer than a lease; a seat with no time shown is not. */
function downLong(seat: LiveSeat, now: number): boolean {
  const after =
    seat.status === "initializing" ? OPENING_MS : ["closed", "error"].includes(seat.status) ? DOWN_MS : null;
  return after !== null && now - Date.parse(seat.updatedAt) > after;
}

/** The seats the app lists, by whether their state is known, a seat down for long left out of both; null, said in the log, when the list cannot be read. */
async function seatingOf(room: RoomContext): Promise<Seating | null> {
  try {
    const live = await room.host.live();
    // an empty list is the app still loading its agents, not a room with none
    if (live.size === 0) throw new Error("the app lists no seat at all");
    const alive: string[] = [];
    const unsure: string[] = [];
    const now = Date.now();
    for (const [id, seat] of live) {
      if (downLong(seat, now)) continue;
      (seat.state === "unknown" ? unsure : alive).push(id);
    }
    return { alive, unsure };
  } catch (error) {
    room.log(
      `work: the seats could not be listed, so no lease changes: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** The minute's pass over the leases of claimed issues: those of a seat the app no longer lists go back to the board, and the seat's Owner is told once. */
export async function sweepLeases(room: RoomContext): Promise<void> {
  const { engine, log } = room;
  const byOwner = new Map<string, Lapsed[]>();
  for (const { lapsed } of await room.works.leases(engine.projects(), () => seatingOf(room))) {
    log(`work: ${lapsed.map((issue) => issue.id).join(", ")} went back to the board, their seats gone or stopped`);
    for (const issue of lapsed) {
      const owner = engine.parentOf(issue.holder);
      if (owner) byOwner.set(owner, [...(byOwner.get(owner) ?? []), issue]);
    }
  }
  for (const [owner, issues] of byOwner) {
    const lines = issues.map(
      (issue) =>
        `- ${issue.id} "${clip(issue.title, TITLE_SHOWN)}" (held by ${engine.seat(issue.holder)?.title ?? issue.holder})`,
    );
    await engine
      .post({
        from: fromRoom,
        to: owner,
        priority: "action",
        subject: `LEASE: ${issues.length} claimed issue${issues.length === 1 ? "" : "s"} went back to the board`,
        body: `The seat that held each issue below is gone or has stopped. Each is back on the board with no holder, and carries a comment saying so.\n${lines.join("\n")}\nBrief a new seat for each, or claim it yourself with seatwork_work do=claim.`,
        needs: "nothing",
        why: "a seat under you is gone or stopped and its claimed work went back to the board",
      })
      .catch((error) => log(`work: ${owner} was not told of the issues given back: ${String(error)}`));
  }
}

export const fromRoom = { agentId: "room", role: "system" } as const;
