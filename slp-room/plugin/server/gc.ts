import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { paseoCli as cli } from "./cli";
import { waitsOnSomeone, type MailEngine } from "./mail";
import { PASEO_SCHEDULES, ROOM_HOME } from "./paths";
import type { GcPolicy } from "./policy";

/**
 * Garbage collection for the room. One pass every gc.everyMinutes, plus a
 * short pass whenever a seat is archived:
 *
 *  - a room seat at rest longer than its role's limit is archived, unless it
 *    waits on a permission or an answer, or one of its descendants is still
 *    alive (a Lead waits for its Peers, never the other way round); the parent
 *    gets an FYI mail;
 *  - heartbeats of room seats that are archived or gone are deleted. Paseo marks
 *    a heartbeat "completed" when its agent is archived but keeps the file, and
 *    `paseo schedule ls` hides heartbeats, so GC reads the daemon's schedule
 *    store directly and deletes through the CLI (the plugin SDK has no schedule
 *    API);
 *  - mail still held for an archived seat is bounced to its sender, and the
 *    seat's MCP nonce is forgotten.
 *
 * It never kills a process and never touches an agent that is not a room seat.
 * Every action is one line in ROOM_HOME/gc.log.
 */

const GC_LOG = join(ROOM_HOME, "gc.log");

interface LiveAgent {
  id: string;
  status: string;
  updatedAt: string;
  title?: string | null;
  archivedAt?: string | null;
  pendingPermissions?: unknown[] | null;
}

/** How long a seat has been at rest, in ms; 0 while it works, starts, or waits on someone. */
function restMs(agent: LiveAgent): number {
  if (agent.status === "running" || agent.status === "initializing" || waitsOnSomeone(agent)) return 0;
  return Date.now() - Date.parse(agent.updatedAt);
}

interface Schedule {
  id: string;
  name?: string | null;
  status?: string;
  target?: { type?: string; agentId?: string };
}

/** Every schedule in the daemon's store; unreadable files are skipped. */
function storedSchedules(): Schedule[] {
  if (!existsSync(PASEO_SCHEDULES)) return [];
  const out: Schedule[] = [];
  for (const name of readdirSync(PASEO_SCHEDULES)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(PASEO_SCHEDULES, name), "utf8")) as Schedule;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // not ours to judge
    }
  }
  return out;
}

function logLine(kind: string, detail: Record<string, unknown>): void {
  appendFileSync(GC_LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, ...detail })}\n`);
}

export class Collector {
  private running = false;
  /** Heartbeat deletions run one at a time: the periodic pass and an archive hook may overlap. */
  private heartbeatLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly paseo: PaseoApi,
    private readonly engine: MailEngine,
    private readonly policy: GcPolicy,
    private readonly log: (message: string) => void,
    /** Drops the plugin's nonce → agent mapping for an archived seat. */
    private readonly forgetAgent: (agentId: string) => void,
  ) {}

  /** One full pass: idle seats, then orphan heartbeats. Safe to call often. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const live = await this.liveAgents();
      await this.archiveIdleSeats(live);
      if (this.policy.deleteOrphanHeartbeats) await this.deleteHeartbeats((agentId) => !live.has(agentId));
    } catch (error) {
      this.log(`gc: pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** A seat was archived (by GC, a parent, or the user): bounce its mail, forget its nonce, delete its heartbeats. */
  async onArchived(agentId: string): Promise<void> {
    if (!this.engine.seat(agentId)) return;
    this.forgetAgent(agentId);
    try {
      await this.engine.deliver(agentId); // the engine sees "gone" and bounces what was held
    } catch (error) {
      this.log(`gc: bounce for ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.policy.deleteOrphanHeartbeats) {
      try {
        await this.deleteHeartbeats((target) => target === agentId);
      } catch (error) {
        this.log(`gc: heartbeat cleanup for ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Every unarchived agent on the daemon, by id. */
  private async liveAgents(): Promise<Map<string, LiveAgent>> {
    const out = new Map<string, LiveAgent>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const entry of result.entries) {
        const agent = (entry as { agent: LiveAgent }).agent;
        out.set(agent.id, agent);
      }
      const info = (result as { pageInfo?: { nextCursor?: string | null; hasMore?: boolean } }).pageInfo;
      cursor = info?.hasMore && info.nextCursor ? info.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  private async archiveIdleSeats(live: Map<string, LiveAgent>): Promise<void> {
    const seats = this.engine.allSeats();
    const hasLiveDescendant = (id: string) => seats.some((s) => s.agentId !== id && live.has(s.agentId) && this.engine.isAncestor(id, s.agentId));
    for (const seat of seats) {
      const agent = live.get(seat.agentId);
      if (!agent) continue;
      const hours = this.policy.idleHoursBeforeArchive[seat.role] ?? 0;
      if (hours <= 0) continue;
      if (!(restMs(agent) > hours * 3_600_000)) continue;
      if (hasLiveDescendant(seat.agentId)) continue;
      // the list is old by the time a long pass gets here: the seat is judged again on a fresh read
      const handle = this.paseo.agents.ref(seat.agentId);
      let fresh: LiveAgent | null;
      try {
        await handle.refresh();
        fresh = handle.current() as LiveAgent | null;
      } catch (error) {
        this.log(`gc: cannot read ${seat.agentId}, left alone: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!fresh || fresh.archivedAt || !(restMs(fresh) > hours * 3_600_000)) continue;
      const idleHours = Math.round(restMs(fresh) / 3_600_000);
      try {
        await handle.archive();
      } catch (error) {
        this.log(`gc: archive ${seat.agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      live.delete(seat.agentId);
      logLine("archived-idle", { agentId: seat.agentId, role: seat.role, title: seat.title, idleHours });
      this.log(`gc: archived ${seat.role} ${seat.agentId} (${seat.title ?? ""}) idle ${idleHours}h`);
      const parent = this.engine.parentOf(seat.agentId);
      // nothing travels up to hq: it looks at the room instead of being told
      if (this.policy.tellParent && parent && live.has(parent) && this.engine.seat(parent)?.role !== "hq") {
        await this.engine.post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: parent,
          priority: "fyi",
          subject: `GC: archived ${seat.role} ${seat.title ?? seat.agentId} after ${idleHours}h idle`,
          body: `The room archived ${seat.role} ${seat.agentId} ("${seat.title ?? ""}"): idle for ${idleHours} hours with nothing alive below it. Nothing was waiting on it. If its work still matters, launch a new seat with the brief and what was tried.`,
          needs: "nothing",
          whyNow: "a seat you launched was archived for inactivity",
        });
      }
    }
  }

  /** Deletes every heartbeat of a room seat that `orphaned(agentId)` says is gone, or that Paseo already completed. */
  private deleteHeartbeats(orphaned: (agentId: string) => boolean): Promise<void> {
    const run = this.heartbeatLock.then(() => this.deleteHeartbeatsNow(orphaned));
    this.heartbeatLock = run.catch(() => undefined);
    return run;
  }

  private async deleteHeartbeatsNow(orphaned: (agentId: string) => boolean): Promise<void> {
    for (const schedule of storedSchedules()) {
      const target = schedule.target?.type === "agent" ? schedule.target.agentId : undefined;
      if (!target || !this.engine.seat(target)) continue;
      if (!orphaned(target) && schedule.status !== "completed") continue;
      await cli(["schedule", "delete", schedule.id]);
      logLine("deleted-heartbeat", { scheduleId: schedule.id, name: schedule.name ?? null, agentId: target });
      this.log(`gc: deleted heartbeat ${schedule.id} (${schedule.name ?? ""}) of archived seat ${target}`);
    }
  }
}
