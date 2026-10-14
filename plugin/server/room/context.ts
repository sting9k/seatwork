import type { MailEngine } from "../coordination/engine";
import type { Host, SeatUsage } from "../host";
import type { Jev } from "../jev/index";
import type { Recovery } from "../orchestration/recovery";
import type { ReviewGate } from "../orchestration/review-gate";
import type { Rotations } from "../orchestration/rotation";
import type { Rounds } from "../orchestration/rounds";
import type { RuntimePolicy } from "../policy";
import type { Safety } from "../safety/index";
import type { OwedList } from "./status";
import type { WorkStores } from "../tasks/stores";
import type { Callers } from "./callers";

/** What the parts of a running room share: the districts, the app, what a turn leaves. */
export interface RoomContext {
  host: Host;
  policy: RuntimePolicy;
  version: string;
  log(message: string): void;
  engine: MailEngine;
  works: WorkStores;
  rounds: Rounds;
  gate: ReviewGate;
  recovery: Recovery;
  rotations: Rotations;
  owed: OwedList;
  callers: Callers;
  safety: Safety;
  jev: Jev;
  /** seat → the signals it mailed its parent in the turn it is in; read when that turn ends */
  mailedUp: Map<string, Set<string>>;
  /** seat → the signal its last turn ended with */
  lastSignal: Map<string, string>;
  lastUsage: Map<string, SeatUsage>;
  briefs: Map<string, string>;
  rotateAt: number;
  /** Sets up seats the room does not have yet, for a project whose own model table names them. */
  addSeats(providers: string[]): Promise<void>;
}

/** The task a seat works on: the issue it holds in its project's work store, else the seat itself. */
export function taskOf(room: RoomContext, seat: string): string {
  try {
    const store = room.works.existing(room.engine.projectOf(seat));
    return store?.list({ assignee: seat, status: "in_progress", limit: 1 }).issues[0]?.id ?? seat;
  } catch {
    return seat;
  }
}

/** What a seat held goes to the seat that follows it, or is open again. */
export function releaseWork(room: RoomContext, from: string, to: string | null): void {
  const store = room.works.existing(room.engine.projectOf(from));
  const moved = store?.release(from, to, "room") ?? [];
  if (moved.length > 0) room.log(`work: ${moved.join(", ")} of ${from} ${to ? `now held by ${to}` : "open again"}`);
}

/** A notice from the room itself. */
export const fromRoom = { agentId: "room", role: "system" } as const;
