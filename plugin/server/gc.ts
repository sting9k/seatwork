import settings from "../shared/settings.json";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PaseoApi } from "./paseo";
import { paseoCli as cli } from "./cli";
import { waitsOnSomeone, type MailEngine } from "./mail";
import { PASEO_SCHEDULES, ROOM_HOME, SEAT_TMP_DIR } from "./paths";
import type { GcPolicy } from "./policy";
import { KEEP_REMOVED_DAYS } from "./setup/room-home";
import { isVerdict } from "./watch/calibrate";

/** Garbage collection: idle seats, what gone seats left behind, and old files. */

const GC_LOG = join(ROOM_HOME, "gc.log");

export interface LiveAgent {
  id: string;
  status: string;
  updatedAt: string;
  provider?: string;
  title?: string | null;
  cwd?: string;
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

/** Every schedule in the daemon's store, read from disk: `paseo schedule ls` hides heartbeats. */
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

/** Every unarchived agent on the daemon, by id. */
export async function liveAgents(paseo: PaseoApi): Promise<Map<string, LiveAgent>> {
  const out = new Map<string, LiveAgent>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
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

export class Collector {
  private running = false;
  private heartbeatLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly paseo: PaseoApi,
    private readonly engine: MailEngine,
    private readonly policy: GcPolicy,
    private readonly log: (message: string) => void,
    private readonly forgetAgent: (agentId: string) => void,
  ) {}

  /** One full pass: idle seats, then orphan heartbeats. Safe to call often. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const live = await liveAgents(this.paseo);
      await this.archiveIdleSeats(live);
      if (this.policy.deleteOrphanHeartbeats) await this.deleteHeartbeats((agentId) => !live.has(agentId));
      for (const dir of dropSeatTmp(SEAT_TMP_DIR, [...live.keys()])) this.log(`gc: deleted ${dir}, a closed seat's`);
    } catch (error) {
      this.log(`gc: pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** A seat was archived: bounce its mail, forget its nonce, delete its heartbeats. */
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
        this.log(
          `gc: heartbeat cleanup for ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async archiveIdleSeats(live: Map<string, LiveAgent>): Promise<void> {
    const seats = this.engine.allSeats();
    const hasLiveDescendant = (id: string) =>
      seats.some((s) => s.agentId !== id && live.has(s.agentId) && this.engine.isAncestor(id, s.agentId));
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
        this.log(
          `gc: cannot read ${seat.agentId}, left alone: ${error instanceof Error ? error.message : String(error)}`,
        );
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

  /** Deletes the heartbeats of seats `orphaned` says are gone or Paseo completed, one pass at a time. */
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

/* ---------- files ---------- */

export const KEEP_LOG_DAYS: number = settings.keepLogDays;

type Line = Record<string, unknown>;

const LOGS: readonly { file: string; stays?(line: Line): boolean }[] = [
  // verdicts stay: the watcher's statistics need them
  { file: join("mail", "log.jsonl"), stays: (line) => line.kind === "queued" && isVerdict(String(line.subject ?? "")) },
  { file: "gc.log" },
  { file: "usage-log.jsonl" },
];

/** Drops a log's lines dated before `before`; returns how many. */
function trimLines(file: string, before: number, stays: (line: Line) => boolean = () => false): number {
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((text) => text.trim());
  const kept = lines.filter((text) => {
    try {
      const line = JSON.parse(text) as Line;
      return Date.parse(String(line.at)) >= before || stays(line);
    } catch {
      return false;
    }
  });
  if (kept.length === lines.length) return 0;
  if (kept.length === 0) rmSync(file, { force: true });
  else {
    writeFileSync(`${file}.tmp`, `${kept.join("\n")}\n`, { mode: statSync(file).mode & 0o777 });
    renameSync(`${file}.tmp`, file);
  }
  return lines.length - kept.length;
}

/** Clears old log lines, old config backups and folders set aside; needs no daemon. */
export function collectFiles(roomHome: string, paseoHome: string, now = new Date()): string[] {
  const done: string[] = [];
  const before = now.getTime() - KEEP_LOG_DAYS * 86_400_000;
  for (const log of LOGS) {
    const gone = trimLines(join(roomHome, log.file), before, log.stays);
    if (gone > 0) done.push(`${gone} lines older than ${KEEP_LOG_DAYS} days left ${log.file}`);
  }
  // the newest backup always stays
  for (const file of dropStamped(paseoHome, ["config.json.bak-"], KEEP_LOG_DAYS, now, 1))
    done.push(`deleted ${file}, a backup older than ${KEEP_LOG_DAYS} days`);
  for (const folder of sweepRemoved(roomHome, KEEP_REMOVED_DAYS, now))
    done.push(`deleted ${folder}, set aside more than ${KEEP_REMOVED_DAYS} days ago`);
  return done;
}

const STAMP = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/;

/** Deletes entries named `<prefix><stamp>` older than `days`, sparing the `spare` newest. */
export function dropStamped(
  dir: string,
  prefixes: readonly string[],
  days: number,
  now = new Date(),
  spare = 0,
): string[] {
  if (!existsSync(dir)) return [];
  const dated: { path: string; at: number }[] = [];
  for (const entry of readdirSync(dir)) {
    const prefix = prefixes.find((known) => entry.startsWith(known));
    const at = prefix === undefined ? null : STAMP.exec(entry.slice(prefix.length));
    if (at)
      dated.push({
        path: join(dir, entry),
        at: new Date(+at[1], +at[2] - 1, +at[3], +at[4], +at[5], +at[6]).getTime(),
      });
  }
  dated.sort((a, b) => b.at - a.at);
  const gone = dated
    .slice(spare)
    .filter((entry) => now.getTime() - entry.at >= days * 86_400_000)
    .map((entry) => entry.path);
  for (const path of gone) rmSync(path, { recursive: true, force: true });
  return gone;
}

/** Deletes closed seats' temporary directories once untouched for `days`. */
export function dropSeatTmp(dir: string, open: readonly string[], days = KEEP_LOG_DAYS, now = new Date()): string[] {
  if (!existsSync(dir)) return [];
  const gone = readdirSync(dir)
    .filter((name) => !open.some((agentId) => agentId.startsWith(name)))
    .map((name) => join(dir, name))
    .filter((path) => now.getTime() - statSync(path).mtimeMs >= days * 86_400_000);
  for (const path of gone) rmSync(path, { recursive: true, force: true });
  return gone;
}

/** Deletes the folders set aside beside a room home after `days`. */
export function sweepRemoved(roomHome: string, days = KEEP_REMOVED_DAYS, now = new Date()): string[] {
  return dropStamped(dirname(roomHome), [`${basename(roomHome)}.removed-`, "slp-room.removed-"], days, now);
}
