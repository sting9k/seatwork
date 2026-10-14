import { readJson, writeJson } from "../persisted";
import { basename } from "node:path";
import type { LiveSeat } from "../host";
import type { MailEngine, SeatRecord } from "../coordination/engine";
import {
  isInside,
  loadRegistry,
  markerRoot,
  realOrSelf,
  roomProjectIn,
  type Registry,
} from "../orchestration/registry";
import { rolesWhere, traits } from "../../shared/workflow";

/** What the app shows of the room: what waits on its Owner, and its seats by project. */

/** What a turn left for the Owner to answer, kept by the plugin until that seat works again. */
interface Owed {
  key: string;
  agentId: string;
  title: string | null;
  what: string;
  at: string;
}

/** What waits on the Owner, one entry per seat, kept on disk across reloads and restarts. */
export class OwedList {
  private readonly items = new Map<string, Owed>();

  constructor(private readonly file: string) {
    for (const item of readJson<Owed[]>(file, [])) this.items.set(item.agentId, item);
  }

  /** A seat's turn left something for the Owner. */
  set(item: Owed): void {
    this.items.set(item.agentId, item);
    this.save();
  }

  /** The seat works again, or was archived. */
  clear(agentId: string): void {
    if (this.items.delete(agentId)) this.save();
  }

  /** What still waits: an entry whose seat the daemon no longer has is dropped. */
  among(live: ReadonlyMap<string, LiveSeat>): Owed[] {
    const gone = [...this.items.keys()].filter((agentId) => !live.has(agentId));
    for (const agentId of gone) this.items.delete(agentId);
    if (gone.length > 0) this.save();
    return [...this.items.values()];
  }

  /** What still waits; the app is asked only when something does. */
  async current(live: () => Promise<ReadonlyMap<string, LiveSeat>>): Promise<Owed[]> {
    return this.items.size === 0 ? [] : this.among(await live());
  }

  private save(): void {
    writeJson(this.file, [...this.items.values()]);
  }
}

interface Place {
  key: string;
  name: string;
}

const ROOM_GROUP: Place = {
  key: "",
  name:
    rolesWhere((role) => role.home === "room")
      .map((role) => traits(role).label)
      .join(", ") || "Room",
};

/** The group a seat's folder puts it in: the room's own (named after the roles at home in it), a registered project, or its folder. */
function placeOf(cwd: string, registry: Registry | null, own: string): Place {
  const real = realOrSelf(cwd);
  if (isInside(real, own)) return ROOM_GROUP;
  const entry = registry?.projects.find((project) => isInside(real, project.cwd));
  if (entry) return { key: entry.name, name: entry.name };
  const root = markerRoot(real) ?? real;
  return { key: root, name: basename(root) };
}

interface StatusSeat {
  agentId: string;
  role: string;
  title: string | null;
  status: string;
  held: number;
  depth: number;
}

/** A group's seats as a tree, its top seats first, whoever opened it. */
function treeOf(members: readonly SeatRecord[], live: ReadonlyMap<string, LiveSeat>, engine: MailEngine) {
  const inGroup = new Set(members.map((seat) => seat.agentId));
  const below = new Map<string | null, SeatRecord[]>();
  for (const seat of members) {
    const parent = engine.parentOf(seat.agentId);
    const owner = parent && inGroup.has(parent) ? parent : null;
    below.set(owner, [...(below.get(owner) ?? []), seat]);
  }
  const seats: StatusSeat[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const seat of below.get(parent) ?? []) {
      const agent = live.get(seat.agentId)!;
      seats.push({
        agentId: seat.agentId,
        role: seat.role,
        title: seat.title,
        status: agent.waiting ? "waiting" : agent.status,
        held: engine.held(seat.agentId).length,
        depth,
      });
      walk(seat.agentId, depth + 1);
    }
  };
  walk(null, 0);
  return seats;
}

/** The room as the app shows it: what waits on the Owner, and the seats by project. */
export async function roomStatus(live: ReadonlyMap<string, LiveSeat>, engine: MailEngine, owed: OwedList) {
  const registry = loadRegistry();
  const own = roomProjectIn(registry);
  const records = engine.allSeats().filter((seat) => live.has(seat.agentId));
  const place = new Map<string, Place>();
  const placed = new Map<string, Place>();
  for (const seat of records) {
    const cwd = seat.cwd ?? live.get(seat.agentId)!.cwd;
    if (cwd && !placed.has(cwd)) placed.set(cwd, placeOf(cwd, registry, own));
    place.set(seat.agentId, cwd ? placed.get(cwd)! : { key: "(unplaced)", name: "unplaced" });
  }
  const groups = new Map<string, { name: string; members: SeatRecord[] }>([
    [ROOM_GROUP.key, { name: ROOM_GROUP.name, members: [] }],
  ]);
  for (const project of registry?.projects ?? []) groups.set(project.name, { name: project.name, members: [] });
  for (const seat of records) {
    const { key, name } = place.get(seat.agentId)!;
    if (!groups.has(key)) groups.set(key, { name, members: [] });
    groups.get(key)!.members.push(seat);
  }
  const projects = [...groups.entries()]
    .filter(
      ([key, group]) =>
        group.members.length > 0 || (registry?.projects.some((project) => project.name === key) ?? false),
    )
    .map(([, group]) => ({ name: group.name, seats: treeOf(group.members, live, engine) }));
  return {
    waiting: owed.among(live).map((item) => ({ ...item, project: place.get(item.agentId)?.name ?? "" })),
    projects,
  };
}
