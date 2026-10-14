import settings from "../shared/settings.json";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Host, LiveSeat } from "./host";
import type { MailEngine } from "./coordination/engine";
import { ROOM_HOME, RUNTIMES_DIR, SEAT_TMP_DIR } from "./paths";
import type { GcPolicy, RuntimeLeftovers } from "./policy";
import { isVerdict } from "./watch/calibrate";
import { routeOpen } from "../shared/workflow";

/** Garbage collection: idle seats, what gone seats left behind, and old files. */

const GC_LOG = join(ROOM_HOME, "gc.log");

/** How long a seat has been at rest, in ms; 0 while it works, starts, or waits on someone. */
function restMs(seat: LiveSeat): number {
  if (seat.status === "running" || seat.status === "initializing" || seat.waiting) return 0;
  return Date.now() - Date.parse(seat.updatedAt);
}

function logLine(kind: string, detail: Record<string, unknown>): void {
  appendFileSync(GC_LOG, `${JSON.stringify({ at: new Date().toISOString(), kind, ...detail })}\n`);
}

export class Collector {
  private running = false;

  constructor(
    private readonly host: Host,
    private readonly engine: MailEngine,
    private readonly policy: GcPolicy,
    private readonly log: (message: string) => void,
    private readonly forgetAgent: (agentId: string) => void,
    private readonly keepMailDays: number = KEEP_LOG_DAYS,
    private readonly expireUnreadDays?: number,
  ) {}

  /** One full pass: idle seats, orphan heartbeats, seat leftovers, finished mail. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const live = await this.host.live();
      await this.archiveIdleSeats(live);
      if (this.policy.deleteOrphanHeartbeats) await this.dropWakers((agentId) => !live.has(agentId));
      for (const dir of dropSeatTmp(SEAT_TMP_DIR, [...live.keys()])) this.log(`gc: deleted ${dir}, a closed seat's`);
      const open = new Set([...live.values()].flatMap((seat) => seat.provider || []));
      for (const line of sweepRuntimes(RUNTIMES_DIR, open, this.policy.runtimes ?? {})) this.log(`gc: ${line}`);
      const cutoff = new Date(Date.now() - this.keepMailDays * 86_400_000).toISOString();
      const mails = this.engine.prune(cutoff, isVerdict);
      if (mails > 0)
        this.log(`gc: ${mails} mails finished more than ${this.keepMailDays} days ago left the mail stores`);
      if (this.expireUnreadDays !== undefined) {
        const unread = this.engine.expire(new Date(Date.now() - this.expireUnreadDays * 86_400_000).toISOString());
        if (unread > 0) this.log(`gc: ${unread} mails sent only to be read went unread ${this.expireUnreadDays} days`);
      }
      // a successor holds its handoff in its prompt: the file is a copy for people
      const before = Date.now() - KEEP_LOG_DAYS * 86_400_000;
      for (const root of this.engine.projects())
        for (const file of dropOld(join(root, ".seatwork", "handoffs"), ".md", before))
          this.log(`gc: deleted ${file}, a handoff older than ${KEEP_LOG_DAYS} days`);
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
        await this.dropWakers((target) => target === agentId);
      } catch (error) {
        this.log(
          `gc: heartbeat cleanup for ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async archiveIdleSeats(live: Map<string, LiveSeat>): Promise<void> {
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
      let fresh: LiveSeat | null;
      try {
        fresh = await this.host.seat(seat.agentId);
      } catch (error) {
        this.log(
          `gc: cannot read ${seat.agentId}, left alone: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!fresh || !(restMs(fresh) > hours * 3_600_000)) continue;
      const idleHours = Math.round(restMs(fresh) / 3_600_000);
      try {
        await this.host.archive(seat.agentId);
      } catch (error) {
        this.log(`gc: archive ${seat.agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      live.delete(seat.agentId);
      logLine("archived-idle", { agentId: seat.agentId, role: seat.role, title: seat.title, idleHours });
      this.log(`gc: archived ${seat.role} ${seat.agentId} (${seat.title ?? ""}) idle ${idleHours}h`);
      const parent = this.engine.parentOf(seat.agentId);
      // where the route up is off, the parent looks at the room instead of being told
      const above = parent ? this.engine.seat(parent) : undefined;
      if (this.policy.tellParent && above && live.has(above.agentId) && routeOpen(seat.role, above.role)) {
        await this.engine.post({
          from: { agentId: "room", role: "system" },
          to: above.agentId,
          priority: "fyi",
          subject: `GC: archived ${seat.role} ${seat.title ?? seat.agentId} after ${idleHours}h idle`,
          body: `The room archived ${seat.role} ${seat.agentId} ("${seat.title ?? ""}"): idle for ${idleHours} hours with nothing alive below it. Nothing was waiting on it. If its work still matters, launch a new seat with the brief and what was tried.`,
          needs: "nothing",
          why: "a seat you launched was archived for inactivity",
        });
      }
    }
  }

  /** Deletes the app's timers that wake seats `orphaned` says are gone, or that the app finished. */
  private async dropWakers(orphaned: (agentId: string) => boolean): Promise<void> {
    for (const line of await this.host.dropWakers((agentId) => !!this.engine.seat(agentId) && orphaned(agentId))) {
      logLine("deleted-waker", { what: line });
      this.log(`gc: deleted ${line}`);
    }
  }
}

/* ---------- files ---------- */

export const KEEP_LOG_DAYS: number = settings.keepLogDays;
const KEEP_REMOVED_DAYS: number = settings.keepRemovedDays;

type Line = Record<string, unknown>;

const LOGS: readonly { file: string; stays?(line: Line): boolean }[] = [
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

/** What earlier versions kept in the room home and no version writes any more. */
const RETIRED: readonly string[] = [join("mail", "log.jsonl"), join("mail", "queue"), join("mail", "reports")];

/** Backups the room leaves in another folder, `<prefix><stamp>`: the `spare` newest always stay. */
export interface Stamped {
  dir: string;
  prefixes: readonly string[];
  spare: number;
}

/** Clears old log lines, retired files, old backups and set-aside folders; needs no daemon. */
export function collectFiles(roomHome: string, backups: readonly Stamped[], now = new Date()): string[] {
  const done: string[] = [];
  for (const name of RETIRED.filter((name) => existsSync(join(roomHome, name)))) {
    rmSync(join(roomHome, name), { recursive: true, force: true });
    done.push(`deleted ${name}, which no version of the room writes any more`);
  }
  const before = now.getTime() - KEEP_LOG_DAYS * 86_400_000;
  for (const log of LOGS) {
    const gone = trimLines(join(roomHome, log.file), before, log.stays);
    if (gone > 0) done.push(`${gone} lines older than ${KEEP_LOG_DAYS} days left ${log.file}`);
  }
  for (const backup of backups)
    for (const file of dropStamped(backup.dir, backup.prefixes, KEEP_LOG_DAYS, now, backup.spare))
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

/** Drops the files under `dir` unwritten since `before`, and emptied folders; follows no link. */
/** Deletes the `suffix` files of a folder not written since `before`; returns them. */
function dropOld(dir: string, suffix: string, before: number): string[] {
  if (!existsSync(dir)) return [];
  const gone = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs < before);
  for (const path of gone) rmSync(path, { force: true });
  return gone;
}

function dropUnwritten(dir: string, before: number): number {
  let gone = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      gone += dropUnwritten(path, before);
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
    } else if (entry.isFile() && statSync(path).mtimeMs < before) {
      rmSync(path, { force: true });
      gone += 1;
    }
  }
  return gone;
}

/** Clears what agent CLIs left in seats' homes; `open` are the providers that have a seat. */
export function sweepRuntimes(
  dir: string,
  open: ReadonlySet<string>,
  leftovers: Partial<Record<string, RuntimeLeftovers>>,
  days = KEEP_LOG_DAYS,
  now = new Date(),
): string[] {
  const done: string[] = [];
  const before = now.getTime() - days * 86_400_000;
  // a name is an entry of the home itself: nothing above it, nothing reached through a link
  const own = (home: string, name: string) => {
    if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) return null;
    const path = join(home, name);
    const found = lstatSync(path, { throwIfNoEntry: false });
    return found && !found.isSymbolicLink() ? { path, folder: found.isDirectory() } : null;
  };
  for (const [harness, left] of Object.entries(leftovers)) {
    const homes = join(dir, harness);
    if (!left || !existsSync(homes)) continue;
    for (const role of readdirSync(homes)) {
      if (open.has(`${harness}-${role}`)) continue;
      const home = join(homes, role);
      for (const name of left.rebuilt) {
        const entry = own(home, name);
        if (!entry) continue;
        rmSync(entry.path, { recursive: true, force: true });
        done.push(`deleted ${entry.path}, which ${harness} makes again`);
      }
      for (const name of left.sessions) {
        const entry = own(home, name);
        const gone = entry?.folder ? dropUnwritten(entry.path, before) : 0;
        if (gone > 0) done.push(`deleted ${gone} session files not written for ${days} days in ${entry!.path}`);
      }
    }
  }
  return done;
}

/** Deletes the folders set aside beside a room home after `days`. */
export function sweepRemoved(roomHome: string, days = KEEP_REMOVED_DAYS, now = new Date()): string[] {
  return dropStamped(dirname(roomHome), [`${basename(roomHome)}.removed-`], days, now);
}
