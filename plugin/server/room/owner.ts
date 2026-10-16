import { basename } from "node:path";
import { traits } from "../../shared/workflow";
import type { JevCheck } from "../jev/index";
import type { Decision } from "../knowledge/store";
import type { RoomContext } from "./context";

/** What the person's app asks of the room beyond its seats: a folder's decisions and the decision provider. */

/** A decision as the app shows it: whom it was told to by the role of the seat that recorded it. */
function decisionView(room: RoomContext, decision: Decision) {
  const role = room.engine.seat(decision.recordedBy)?.role;
  return {
    id: decision.id,
    scope: decision.scopeKey === "room" ? ("room" as const) : ("project" as const),
    topic: decision.topic,
    statement: decision.statement,
    version: decision.version,
    since: decision.validFrom,
    until: decision.validUntil,
    toldTo: role ? traits(role).label || role : null,
    state: decision.state,
  };
}

/** The decisions of a folder's project and of the room, for the app's panel. */
export function folderDecisions(room: RoomContext, folder: string, ended: boolean) {
  const found = room.knowledge.decisionsAt(folder, ended);
  const view = (decision: Decision) => decisionView(room, decision);
  return {
    project: found.project ? basename(found.project) : null,
    inForce: found.inForce.map(view),
    pending: found.pending.map(view),
    earlier: found.ended,
    closed: found.endedList.map(view),
  };
}

/** The decision provider as the Seatwork screen shows it: its model, its key, today's calls, the month's spend, the last check. */
export function jevView(room: RoomContext): {
  provider: string | null;
  model: string | null;
  key: "file" | "env" | "none" | "keyless";
  why: string | null;
  calls: number;
  failed: number;
  monthUsd: number;
  capUsd: number;
  check: JevCheck | null;
} {
  const policy = room.policy.jev;
  const name = policy?.provider ?? null;
  const today = room.jev.today();
  const spent = room.jev.spent();
  return {
    provider: name,
    model: (name ? policy?.providers?.[name]?.model : null) || null,
    key: room.jev.keySource(),
    why: room.jev.why(),
    calls: today.reduce((sum, one) => sum + one.calls, 0),
    failed: today.reduce((sum, one) => sum + one.failed, 0),
    monthUsd: spent.usd,
    capUsd: spent.capUsd,
    check: room.jev.checked(),
  };
}
