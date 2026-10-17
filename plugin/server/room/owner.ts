import { basename } from "node:path";
import forkCatalog from "../../shared/forks.json";
import knowledgeCatalog from "../../shared/knowledge.json";
import councilCatalog from "../../shared/safety/council.json";
import { traits } from "../../shared/workflow";
import type { JevCheck } from "../jev/index";
import type { Decision } from "../knowledge/store";
import { writePolicyKey } from "../operations/index";
import { required, type ForkName } from "../orchestration/forks";
import { POLICY_FILE } from "../policy";
import type { RoomContext } from "./context";

/** What the person's app asks of the room beyond its seats: a folder's decisions, the decision provider and where it works. */

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
    check: room.jev.checked(),
  };
}

/** One place the decision model works, as the Seatwork screen lists it. */
interface JevPlace {
  id: string;
  label: string;
  about: string;
  on: boolean;
}

const FORK_NAMES = Object.keys(forkCatalog.forks) as ForkName[];
const JURORS = Object.entries(councilCatalog.members)
  .filter(([, member]) => "question" in member)
  .map(([name]) => name);

/** Where the decision model works: what the room needs, always on, and what the person may turn on or off. */
export function jevPlaces(room: RoomContext): { required: JevPlace[]; optional: JevPlace[] } {
  const forksOn = room.policy.jev?.forks ?? [];
  const jurorsOn = room.policy.safety?.council?.jurors ?? JURORS;
  const fork = (name: ForkName): JevPlace => {
    const { label, about } = forkCatalog.forks[name];
    return { id: `forks.${name}`, label, about, on: required(name) || forksOn.includes(name) };
  };
  const juror = (name: string): JevPlace => {
    const { label, about } = councilCatalog.members[name as keyof typeof councilCatalog.members] as unknown as Pick<
      JevPlace,
      "label" | "about"
    >;
    return { id: `council.${name}`, label, about, on: jurorsOn.includes(name) };
  };
  const gate = knowledgeCatalog.gate;
  return {
    required: [
      { id: "knowledge.gate", label: gate.label, about: gate.about, on: true },
      ...FORK_NAMES.filter(required).map(fork),
    ],
    optional: [...JURORS.map(juror), ...FORK_NAMES.filter((name) => !required(name)).map(fork)],
  };
}

/** Turns one optional place on or off, in the room's policy file and in the running room; a place the room needs stays on. */
export function setJevPlace(room: RoomContext, id: string, on: boolean): ReturnType<typeof jevPlaces> {
  const places = jevPlaces(room);
  const needed = places.required.find((place) => place.id === id);
  if (needed) throw new Error(`${needed.label} stays on: the room needs it.`);
  if (!places.optional.some((place) => place.id === id)) throw new Error(`no place ${id} of the decision model`);
  const [kind, name] = id.split(".");
  const kept = (all: readonly string[], now: readonly string[]) =>
    all.filter((one) => (one === name ? on : now.includes(one)));
  if (kind === "forks") {
    const forks = kept(FORK_NAMES, room.policy.jev?.forks ?? []);
    writePolicyKey(POLICY_FILE, "jev.forks", forks);
    if (room.policy.jev) room.policy.jev.forks = forks;
  } else {
    const jurors = kept(JURORS, room.policy.safety?.council?.jurors ?? JURORS);
    writePolicyKey(POLICY_FILE, "safety.council.jurors", jurors);
    if (room.policy.safety?.council) room.policy.safety.council.jurors = jurors;
  }
  return jevPlaces(room);
}
