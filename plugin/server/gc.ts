import settings from "../shared/settings.json";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Host, LiveSeat } from "./host";
import type { MailEngine } from "./coordination/engine";
import { ROOM_FOLDER, RUNTIMES_DIR, SEAT_TMP_DIR } from "./paths";
import type { GcPolicy, RuntimeLeftovers } from "./policy";
import { routeOpen } from "../shared/workflow";
import { ROOM_SENDER } from "./coordination/address";

/** Garbage collection: idle seats, what gone seats left behind, and old files, each with a short keep. */

export const KEEP_LOG_DAYS: number = settings.keepLogDays;
const KEEP_REMOVED_DAYS: number = settings.keepRemovedDays;
const DAY_MS = 86_400_000;

/** How long a seat has been at rest, in ms; 0 while it works, starts, or waits on someone. */
function restMs(seat: LiveSeat): number {
  if (seat.status === "running" || seat.status === "initializing" || seat.waiting) return 0;
  return Date.now() - Date.parse(seat.updatedAt);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A district's records that age out with the logs: `what` is how GC names them in its log. */
export interface DistrictRecords {
  what: string;
  expire(before: Date): number;
}

/** The room's garbage collection, a pass on a timer and a clean-up on each archive; a step that fails is logged and the others still run. */
export class Collector {
  private running = false;
  private heard: string[] | null = null;

  constructor(
    private readonly host: Host,
    private readonly engine: MailEngine,
    private readonly policy: GcPolicy,
    private readonly log: (message: string) => void,
    private readonly forgetAgent: (agentId: string) => void,
    private readonly keepMailDays: number = KEEP_LOG_DAYS,
    private readonly expireUnreadDays?: number,
    private readonly districts: readonly DistrictRecords[] = [],
  ) {}

  /** One full pass: idle seats, orphan heartbeats, seat leftovers, finished mail, seats long gone, the districts' records, old handoffs; what it did, line by line, or null when a pass was already running. */
  async run(): Promise<string[] | null> {
    if (this.running) return null;
    this.running = true;
    const heard: string[] = [];
    this.heard = heard;
    try {
      const live = await this.attempt("listing the open seats", () => this.host.live());
      if (live) {
        await this.attempt("archiving idle seats", () => this.archiveIdleSeats(live));
        if (this.policy.deleteOrphanHeartbeats)
          await this.attempt("deleting heartbeats", () => this.dropWakers((agentId) => !live.has(agentId)));
        await this.attempt("clearing what closed seats left", () => this.clearLeftovers(live));
      }
      const cutoff = new Date(Date.now() - this.keepMailDays * DAY_MS);
      await this.attempt("pruning mail", () => {
        const mails = this.engine.prune(cutoff.toISOString());
        if (mails > 0)
          this.say(`gc: ${mails} mails finished more than ${this.keepMailDays} days ago left the mail stores`);
        if (this.expireUnreadDays === undefined) return;
        const unread = this.engine.expire(new Date(Date.now() - this.expireUnreadDays * DAY_MS).toISOString());
        if (unread > 0) this.say(`gc: ${unread} mails sent only to be read went unread ${this.expireUnreadDays} days`);
      });
      if (live)
        await this.attempt("forgetting the seats long gone", () => {
          const gone = this.engine.forgetGone(new Set(live.keys()), this.keepMailDays * DAY_MS);
          if (gone > 0) this.say(`gc: ${gone} seats gone more than ${this.keepMailDays} days left the mail engine`);
        });
      for (const district of this.districts)
        await this.attempt(`expiring ${district.what}`, () => {
          const gone = district.expire(cutoff);
          if (gone > 0) this.say(`gc: ${gone} ${district.what} past their keep left the room`);
        });
      await this.attempt("deleting old handoffs", () => this.dropHandoffs());
    } finally {
      this.running = false;
      this.heard = null;
    }
    return heard;
  }

  /** Logs a line of the pass, and keeps it for whoever asked for the pass. */
  private say(line: string): void {
    this.log(line);
    this.heard?.push(line);
  }

  /** A seat was archived: bounce its mail, forget its nonce, delete its heartbeats. */
  async onArchived(agentId: string): Promise<void> {
    if (!this.engine.seat(agentId)) return;
    this.forgetAgent(agentId);
    await this.attempt(`bouncing the mail of ${agentId}`, () => this.engine.deliver(agentId));
    if (this.policy.deleteOrphanHeartbeats)
      await this.attempt(`deleting the heartbeats of ${agentId}`, () =>
        this.dropWakers((target) => target === agentId),
      );
  }

  /** Runs one step of a pass; a failure is logged by name and ends that step only. */
  private async attempt<T>(step: string, work: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      this.say(`gc: ${step} failed: ${reason(error)}`);
      return undefined;
    }
  }

  /** Archives each seat at rest past its role's hours, judged again on a fresh read because the list is old by the time a long pass gets here; its parent is told unless the route up is off. */
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
      let fresh: LiveSeat | null;
      try {
        fresh = await this.host.seat(seat.agentId);
      } catch (error) {
        this.say(`gc: cannot read ${seat.agentId}, left alone: ${reason(error)}`);
        continue;
      }
      if (!fresh || !(restMs(fresh) > hours * 3_600_000)) continue;
      const idleHours = Math.round(restMs(fresh) / 3_600_000);
      try {
        await this.host.archive(seat.agentId);
      } catch (error) {
        this.say(`gc: archive ${seat.agentId} failed: ${reason(error)}`);
        continue;
      }
      live.delete(seat.agentId);
      this.say(`gc: archived ${seat.role} ${seat.agentId} (${seat.title ?? ""}) idle ${idleHours}h`);
      const parent = this.engine.parentOf(seat.agentId);
      const above = parent ? this.engine.seat(parent) : undefined;
      if (this.policy.tellParent && above && live.has(above.agentId) && routeOpen(seat.role, above.role)) {
        await this.attempt(`telling ${above.agentId} that ${seat.agentId} was archived`, () =>
          this.engine.post({
            from: ROOM_SENDER,
            to: above.agentId,
            priority: "fyi",
            subject: `GC: archived ${seat.role} ${seat.title ?? seat.agentId} after ${idleHours}h idle`,
            body: `The room archived ${seat.role} ${seat.agentId} ("${seat.title ?? ""}"): idle for ${idleHours} hours with nothing alive below it. Nothing was waiting on it. If its work still matters, launch a new seat with the brief and what was tried.`,
            needs: "nothing",
            why: "a seat you launched was archived for inactivity",
          }),
        );
      }
    }
  }

  /** Deletes the app's timers that wake seats `orphaned` says are gone, or that the app finished. */
  private async dropWakers(orphaned: (agentId: string) => boolean): Promise<void> {
    const { deleted, failed } = await this.host.dropWakers((agentId) =>
      !this.engine.seat(agentId) ? null : orphaned(agentId) ? "gone" : "live",
    );
    for (const line of deleted) this.say(`gc: deleted ${line}`);
    for (const line of failed) this.say(`gc: could not delete ${line}`);
  }

  /** The files the open seats do not need: temporary directories and agent CLI leftovers of seats that are closed. */
  private clearLeftovers(live: ReadonlyMap<string, LiveSeat>): void {
    for (const dir of dropSeatTmp(SEAT_TMP_DIR, [...live.keys()])) this.say(`gc: deleted ${dir}, a closed seat's`);
    const open = new Set([...live.values()].flatMap((seat) => seat.provider || []));
    for (const line of sweepRuntimes(RUNTIMES_DIR, open, this.policy.runtimes ?? {})) this.say(`gc: ${line}`);
  }

  /** A successor holds its handoff in its prompt: the file is a copy for people. */
  private dropHandoffs(): void {
    const before = Date.now() - KEEP_LOG_DAYS * DAY_MS;
    for (const root of this.engine.projects())
      for (const file of dropOld(join(root, ROOM_FOLDER, "handoffs"), ".md", before))
        this.say(`gc: deleted ${file}, a handoff older than ${KEEP_LOG_DAYS} days`);
  }
}

type Line = Record<string, unknown>;

const SEAT_RECORDS = "registry-log.jsonl";
/** Rewrites a log without the lines `keep` refuses, given its parsed lines in order (null where one is not JSON); returns how many went. */
function trimLog(file: string, keep: (lines: readonly (Line | null)[]) => boolean[]): number {
  if (!existsSync(file)) return 0;
  const texts = readFileSync(file, "utf8")
    .split("\n")
    .filter((text) => text.trim());
  const parsed = texts.map((text): Line | null => {
    try {
      return JSON.parse(text) as Line;
    } catch {
      return null;
    }
  });
  const kept = keep(parsed);
  const lines = texts.filter((_, index) => kept[index]);
  if (lines.length === texts.length) return 0;
  if (lines.length === 0) rmSync(file, { force: true });
  else {
    writeFileSync(`${file}.tmp`, `${lines.join("\n")}\n`, { mode: statSync(file).mode & 0o777 });
    renameSync(`${file}.tmp`, file);
  }
  return texts.length - lines.length;
}

/** The seat records still needed: recent or undated ones, those of open seats and the seats above them, the newest of each folder. */
function seatRecordsNeeded(since: number, open: ReadonlySet<string>) {
  return (lines: readonly (Line | null)[]): boolean[] => {
    const byId = new Map<string, Line>();
    const newest = new Map<string, Line>();
    for (const line of lines) {
      if (!line) continue;
      if (typeof line.agentId === "string") byId.set(line.agentId, line);
      if (typeof line.cwd === "string") newest.set(line.cwd, line);
    }
    const needed = new Set<string>();
    for (const id of open) {
      let at: string | undefined = id;
      while (at && !needed.has(at)) {
        needed.add(at);
        const parent: unknown = byId.get(at)?.parentAgentId;
        at = typeof parent === "string" ? parent : undefined;
      }
    }
    return lines.map(
      (line) =>
        line !== null &&
        (!(Date.parse(String(line.at)) < since) ||
          needed.has(String(line.agentId)) ||
          (typeof line.cwd === "string" && newest.get(line.cwd) === line)),
    );
  };
}

/** Backups the room leaves in another folder, `<prefix><stamp>`: the `spare` newest always stay. */
interface Stamped {
  dir: string;
  prefixes: readonly string[];
  spare: number;
}

/** Clears old log lines, retired files, old backups, controls, set-aside folders and taken-out local skills; the seat records too once `open` names the open seats. */
export function collectFiles(
  roomHome: string,
  backups: readonly Stamped[],
  now: Date,
  open?: ReadonlySet<string>,
): string[] {
  const done: string[] = [];
  const since = now.getTime() - KEEP_LOG_DAYS * DAY_MS;
  if (open) {
    const gone = trimLog(join(roomHome, SEAT_RECORDS), seatRecordsNeeded(since, open));
    if (gone > 0) done.push(`${gone} seat records that no recent or open seat or folder needs left ${SEAT_RECORDS}`);
  }
  for (const backup of backups)
    for (const file of dropStamped(backup.dir, backup.prefixes, KEEP_LOG_DAYS, now, backup.spare))
      done.push(`deleted ${file}, a backup older than ${KEEP_LOG_DAYS} days`);
  for (const folder of sweepRemoved(roomHome, KEEP_REMOVED_DAYS, now))
    done.push(`deleted ${folder}, set aside more than ${KEEP_REMOVED_DAYS} days ago`);
  for (const folder of dropStamped(join(roomHome, "controls"), [""], KEEP_LOG_DAYS, now))
    done.push(`deleted ${folder}, a control older than ${KEEP_LOG_DAYS} days`);
  for (const folder of dropStamped(join(roomHome, "skills-local", "removed"), [""], KEEP_REMOVED_DAYS, now))
    done.push(`deleted ${folder}, local skills taken out more than ${KEEP_REMOVED_DAYS} days ago`);
  return done;
}

const STAMP = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/;

/** A local date and time for a file name, the one GC reads back: 20261012-145625. */
export function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/** Deletes entries named `<prefix><stamp>` older than `days`, sparing the `spare` newest. */
function dropStamped(dir: string, prefixes: readonly string[], days: number, now: Date, spare = 0): string[] {
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
    .filter((entry) => now.getTime() - entry.at >= days * DAY_MS)
    .map((entry) => entry.path);
  for (const path of gone) rmSync(path, { recursive: true, force: true });
  return gone;
}

/** Deletes closed seats' temporary directories once untouched for the keep. */
export function dropSeatTmp(dir: string, open: readonly string[]): string[] {
  if (!existsSync(dir)) return [];
  const before = Date.now() - KEEP_LOG_DAYS * DAY_MS;
  const gone = readdirSync(dir)
    .filter((name) => !open.some((agentId) => agentId.startsWith(name)))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).mtimeMs <= before);
  for (const path of gone) rmSync(path, { recursive: true, force: true });
  return gone;
}

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

/** Drops the files under `dir` unwritten since `before`, and emptied folders, each folder read once; follows no link. */
function dropUnwritten(dir: string, before: number): { gone: number; empty: boolean } {
  let gone = 0;
  let kept = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = dropUnwritten(path, before);
      gone += inner.gone;
      if (inner.empty) rmSync(path, { recursive: true, force: true });
      else kept += 1;
    } else if (entry.isFile() && statSync(path).mtimeMs < before) {
      rmSync(path, { force: true });
      gone += 1;
    } else kept += 1;
  }
  return { gone, empty: kept === 0 };
}

/** Clears what agent CLIs left in seats' homes, one home at a time, so a home that cannot be cleared is named and the rest still are; `open` are the providers that have a seat. */
export function sweepRuntimes(
  dir: string,
  open: ReadonlySet<string>,
  leftovers: Partial<Record<string, RuntimeLeftovers>>,
): string[] {
  const done: string[] = [];
  const before = Date.now() - KEEP_LOG_DAYS * DAY_MS;
  /** An entry of the home itself: nothing above it, nothing reached through a link. */
  const own = (home: string, name: string) => {
    if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) return null;
    const path = join(home, name);
    const found = lstatSync(path, { throwIfNoEntry: false });
    return found && !found.isSymbolicLink() ? { path, folder: found.isDirectory() } : null;
  };
  for (const [harness, left] of Object.entries(leftovers)) {
    const homes = join(dir, harness);
    if (!left || !existsSync(homes)) continue;
    for (const role of readdirSync(homes).sort()) {
      if (open.has(`${harness}-${role}`)) continue;
      const home = join(homes, role);
      try {
        for (const name of left.rebuilt) {
          const entry = own(home, name);
          if (!entry) continue;
          rmSync(entry.path, { recursive: true, force: true });
          done.push(`deleted ${entry.path}, which ${harness} makes again`);
        }
        for (const name of left.sessions) {
          const entry = own(home, name);
          const gone = entry?.folder ? dropUnwritten(entry.path, before).gone : 0;
          if (gone > 0)
            done.push(`deleted ${gone} session files not written for ${KEEP_LOG_DAYS} days in ${entry!.path}`);
        }
      } catch (error) {
        done.push(`could not clear ${home}: ${reason(error)}`);
      }
    }
  }
  return done;
}

/** Deletes the folders set aside beside a room home after `days`. */
export function sweepRemoved(roomHome: string, days: number, now: Date): string[] {
  return dropStamped(dirname(roomHome), [`${basename(roomHome)}.removed-`], days, now);
}
