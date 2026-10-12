import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { PaseoApi } from "./paseo";
import { liveAgents, type LiveAgent } from "./gc";
import { hqDir } from "./hq";
import { waitsOnSomeone, type MailEngine, type SeatRecord } from "./mail";
import { findRoomMarker, isInside, loadRegistry, realOrSelf, type Registry } from "./registry";

/** What a turn left for the Owner to answer, kept by the plugin until that seat works again. */
export interface Owed {
  key: string;
  agentId: string;
  title: string | null;
  what: string;
  at: string;
}

/** What waits on the Owner, one entry per seat, kept on disk: a plugin reload or a daemon restart answers nothing. */
export class OwedList {
  private readonly items = new Map<string, Owed>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      for (const item of JSON.parse(readFileSync(file, "utf8")) as Owed[]) this.items.set(item.agentId, item);
    } catch {
      // an unreadable list starts empty: the next turn that asks fills it again
    }
  }

  set(item: Owed): void {
    this.items.set(item.agentId, item);
    this.save();
  }

  /** The seat works again, or was archived. */
  clear(agentId: string): void {
    if (this.items.delete(agentId)) this.save();
  }

  /** What still waits: an entry whose seat the daemon no longer has is dropped. */
  among(live: ReadonlyMap<string, LiveAgent>): Owed[] {
    const gone = [...this.items.keys()].filter((agentId) => !live.has(agentId));
    for (const agentId of gone) this.items.delete(agentId);
    if (gone.length > 0) this.save();
    return [...this.items.values()];
  }

  async current(paseo: PaseoApi): Promise<Owed[]> {
    return this.among(await liveAgents(paseo));
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify([...this.items.values()], null, 1)}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** The group a seat's directory puts it in: HQ's own project, a registered project, else the project its room marker or its directory names. */
function placeOf(cwd: string, registry: Registry | null, hq: string): { key: string; name: string } {
  const real = realOrSelf(cwd);
  if (isInside(real, hq)) return { key: "hq", name: "HQ" };
  const entry = registry?.projects.find((project) => isInside(real, project.cwd));
  if (entry) return { key: entry.name, name: entry.name };
  const root = findRoomMarker(real)?.root ?? real;
  return { key: root, name: basename(root) };
}

/**
 * The room as the app shows it: what waits on the Owner, and the seats the daemon still has, grouped by project.
 * HQ comes first, then the registered projects in their order (also one with no seat open), then the rest.
 */
export async function roomStatus(paseo: PaseoApi, engine: MailEngine, owed: OwedList) {
  const live = await liveAgents(paseo);
  const registry = loadRegistry();
  const hq = hqDir();
  const records = engine.allSeats().filter((seat) => live.has(seat.agentId));
  const place = new Map<string, { key: string; name: string }>();
  for (const seat of records) {
    const cwd = seat.cwd ?? live.get(seat.agentId)!.cwd;
    place.set(seat.agentId, cwd ? placeOf(cwd, registry, hq) : { key: "", name: "unplaced" });
  }
  const groups = new Map<string, { name: string; members: SeatRecord[] }>([["hq", { name: "HQ", members: [] }]]);
  for (const project of registry?.projects ?? []) groups.set(project.name, { name: project.name, members: [] });
  for (const seat of records) {
    const { key, name } = place.get(seat.agentId)!;
    if (!groups.has(key)) groups.set(key, { name, members: [] });
    groups.get(key)!.members.push(seat);
  }
  const projects = [...groups.entries()]
    .filter(([key, group]) => group.members.length > 0 || (registry?.projects.some((project) => project.name === key) ?? false))
    .map(([, group]) => {
      const inGroup = new Set(group.members.map((seat) => seat.agentId));
      // a project's own tree: its Supervisor is at the top, whoever opened it
      const above = (id: string) => {
        const parent = engine.parentOf(id);
        return parent && inGroup.has(parent) ? parent : null;
      };
      const seats: { agentId: string; role: string; title: string | null; status: string; held: number; depth: number }[] = [];
      const walk = (parent: string | null, depth: number) => {
        for (const seat of group.members) {
          if (above(seat.agentId) !== parent) continue;
          const agent = live.get(seat.agentId)!;
          seats.push({ agentId: seat.agentId, role: seat.role, title: seat.title, status: waitsOnSomeone(agent) ? "waiting" : agent.status, held: engine.held(seat.agentId).length, depth });
          walk(seat.agentId, depth + 1);
        }
      };
      walk(null, 0);
      return { name: group.name, seats };
    });
  return {
    waiting: owed.among(live).map((item) => ({ ...item, project: place.get(item.agentId)?.name ?? "" })),
    projects,
  };
}
