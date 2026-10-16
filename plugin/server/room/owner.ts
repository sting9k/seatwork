import { basename } from "node:path";
import { traits } from "../../shared/workflow";
import type { JevCheck } from "../jev/index";
import type { Decision } from "../knowledge/store";
import { ruleOf } from "../safety/gate/packs";
import type { RoomContext } from "./context";

/** What the person's app asks of the room beyond its seats: the codes only they may grant, their grant, a folder's decisions, the decision provider. */

const CODES_SHOWN = 50;

/** A code only the person may grant, as the app shows it. */
export interface PersonCode {
  code: string;
  agentId: string;
  title: string | null;
  project: string | null;
  rule: string;
  reason: string;
  command: string;
  at: string;
  expiresAt: string;
}

/** The codes only the person may grant that still wait, newest first. */
export function personCodes(room: RoomContext): PersonCode[] {
  return room.safety.forPerson(CODES_SHOWN).map((row) => {
    const project = row.seat ? room.engine.projectOf(row.seat) : null;
    return {
      code: row.code,
      agentId: row.seat ?? "",
      title: row.seat ? (room.engine.seat(row.seat)?.title ?? null) : null,
      project: project ? basename(project) : null,
      rule: row.rule,
      reason: ruleOf(row.pack, row.rule)?.reason ?? row.rule,
      command: row.shown,
      at: row.created_at,
      expiresAt: row.expires_at,
    };
  });
}

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
