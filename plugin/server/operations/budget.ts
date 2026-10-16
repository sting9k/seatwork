import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import settings from "../../shared/operations.json";
import { USER_HOME } from "../paths";
import type { HoldRow, OperationsStore, Sums } from "./store";

/** The room's budget: what each project's seats spend in a UTC day, the caps the machine's policy sets, and the breaker that holds a project past its cap. */

/** How a mail of the district differs from the room's usual: it starts no turn, it carries a key that keeps it from being sent twice, it is a notice. */
export interface MailMore {
  quiet?: boolean;
  key?: string;
  priority?: "fyi" | "action";
}

/** What the budget takes from the room: the store and policy, the clock, a seat's project, the people to tell, and what to start when a hold ends. */
export interface BudgetDeps {
  store: OperationsStore;
  policy(): Record<string, unknown>;
  now(): Date;
  projectOf(seat: string): string | null;
  topSeat(project: string): string | null;
  notice(to: string, subject: string, body: string, more: MailMore): Promise<unknown>;
  raise(line: string, key: string): void;
  log(line: string): void;
  lifted(project: string): Promise<void>;
}

interface Cap {
  dailyUsd?: number;
  dailyTurns?: number;
}

/** The policy's budget section: a cap for each project's folder as the registry lists it, and the cap of a project with none of its own. */
export interface BudgetPolicy {
  projects?: Record<string, Cap>;
  default?: Cap;
}

const NO_PROJECT = "(no project)";
const DAY_MS = 86_400_000;
const ROUND = 10_000;

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** The cap an entry of the policy holds; null when it holds none that is a number above zero. */
function capIn(entry: unknown): Cap | null {
  if (!entry || typeof entry !== "object") return null;
  const { dailyUsd, dailyTurns } = entry as Record<string, unknown>;
  const cap: Cap = {};
  if (positive(dailyUsd) !== undefined) cap.dailyUsd = positive(dailyUsd);
  if (positive(dailyTurns) !== undefined) cap.dailyTurns = positive(dailyTurns);
  return cap.dailyUsd === undefined && cap.dailyTurns === undefined ? null : cap;
}

const turnsOf = (n: number): string => `${n} turn${n === 1 ? "" : "s"}`;

/** The real folder a project key names: `~` is the user's home, a relative or trailing part is resolved, a link followed. */
function folderOf(key: string): string {
  const path = resolve(key.replace(/^~(?=\/|$)/, USER_HOME));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

const folders = new WeakMap<object, { keys: string; byFolder: Map<string, string> }>();

/** The policy's keys of the project caps, by the real folder each names; a later key for the same folder wins, as JSON reads it. */
function keysByFolder(projects: Record<string, unknown>): Map<string, string> {
  const keys = Object.keys(projects);
  const known = folders.get(projects);
  if (known?.keys === keys.join("\0")) return known.byFolder;
  const byFolder = new Map(keys.map((key) => [folderOf(key), key]));
  folders.set(projects, { keys: keys.join("\0"), byFolder });
  return byFolder;
}

/** Why a day's sums have reached a cap, or null when they have not. */
function reached(cap: Cap, sums: Sums): string | null {
  const reasons: string[] = [];
  if (cap.dailyUsd !== undefined && sums.usd >= cap.dailyUsd)
    reasons.push(`$${sums.usd.toFixed(2)} spent of its $${cap.dailyUsd.toFixed(2)} a day`);
  if (cap.dailyTurns !== undefined && sums.turns >= cap.dailyTurns)
    reasons.push(`${turnsOf(sums.turns)} ended of its ${cap.dailyTurns} a day`);
  return reasons.length > 0 ? reasons.join(" and ") : null;
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
const shiftDay = (day: string, days: number): string => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
const rounded = (n: number): number => Math.round(n * ROUND) / ROUND;

/** Counts what each project's seats spend and holds a project past its cap; the store keeps it all, memory only mirrors today's sums and the holds. */
export class Budget {
  private readonly held = new Map<string, HoldRow>();
  private readonly mirror = new Map<string, Sums>();
  private mirrorDay = "";

  constructor(private readonly deps: BudgetDeps) {
    for (const hold of deps.store.holdRows()) this.held.set(hold.project, hold);
  }

  private day(): string {
    return dayOf(this.deps.now());
  }

  /** Today's sums per project; read from the store once a day. */
  private today(day: string): Map<string, Sums> {
    if (this.mirrorDay !== day) {
      this.mirror.clear();
      for (const { project, usd, turns } of this.deps.store.spendOn(day)) this.mirror.set(project, { usd, turns });
      this.mirrorDay = day;
    }
    return this.mirror;
  }

  /** The policy's key for a project: the one that names its folder, however it is written; null when none does. */
  keyOf(project: string): string | null {
    const projects = (this.deps.policy().budget as BudgetPolicy | undefined)?.projects;
    if (!projects || typeof projects !== "object") return null;
    if (Object.hasOwn(projects, project)) return project;
    return keysByFolder(projects).get(folderOf(project)) ?? null;
  }

  /** The cap of a project: its own entry in the policy, else the default's; null for none. */
  private capOf(project: string): (Cap & { from: "project" | "default" }) | null {
    const budget = this.deps.policy().budget as BudgetPolicy | undefined;
    const key = this.keyOf(project);
    const own = key !== null ? capIn(budget!.projects![key]) : null;
    if (own) return { ...own, from: "project" };
    const fallback = capIn(budget?.default);
    return fallback ? { ...fallback, from: "default" } : null;
  }

  /** The limit in force on a project for one of a cap's fields, from its own cap or the default's; undefined where none stands. */
  limitOf(project: string, field: keyof Cap): number | undefined {
    return this.capOf(project)?.[field];
  }

  /** Whether a project is one the room knows: it has a cap of its own, or it has spent. */
  knows(project: string): boolean {
    return this.keyOf(project) !== null || this.deps.store.knowsProject(project);
  }

  /** A seat is new: the first cost it reports counts whole. */
  opened(seat: string): void {
    this.deps.store.baseline(seat);
  }

  /** A seat is gone. */
  forget(seat: string): void {
    this.deps.store.dropSeat(seat);
  }

  /** A turn of a seat of `role` ended with its total cost so far and output tokens, when known; a project past its cap is held. */
  spent(seat: string, total: number | undefined, role?: string, outTokens?: number): void {
    const project = this.deps.projectOf(seat) ?? "";
    const day = this.day();
    const today = this.today(day);
    const known = typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
    const out = typeof outTokens === "number" && Number.isFinite(outTokens) ? outTokens : undefined;
    const sums = this.deps.store.spend(project, day, seat, known, role, out);
    today.set(project, sums);
    this.review(project, sums, day);
  }

  /** Holds a project whose day has reached its cap and that nothing holds today. */
  private review(project: string, sums: Sums, day: string): void {
    if (!project || this.held.get(project)?.day === day) return;
    const cap = this.capOf(project);
    const reason = cap && reached(cap, sums);
    if (!reason) return;
    const hold = { project, day, since: this.deps.now().toISOString(), reason, told: false };
    this.deps.store.addHold(hold);
    this.held.set(project, hold);
  }

  /** Whether a hold stands: it is today's, and the project's sums still reach the cap now in force. */
  private stands(hold: HoldRow, day: string): boolean {
    if (hold.day !== day) return false;
    const cap = this.capOf(hold.project);
    const sums = this.today(day).get(hold.project);
    return !!cap && !!sums && reached(cap, sums) !== null;
  }

  /** Whether any project may be held: the one check a delivery makes before it looks for a seat's project. */
  anyHeld(): boolean {
    return this.held.size > 0;
  }

  /** Why a project takes no turn from mail and no new seat now, with when that ends; null when it may. */
  holds(project: string | null): string | null {
    const hold = project ? this.held.get(project) : undefined;
    if (!hold || !this.stands(hold, this.day())) return null;
    return `${hold.reason}; held until ${shiftDay(hold.day, 1)} 00:00 UTC or until the cap is raised`;
  }

  /** The minute's pass: holds that ended are lifted and their mail started, caps lowered under a day's sums hold, new holds are told. */
  async minute(): Promise<void> {
    const day = this.day();
    for (const hold of [...this.held.values()]) {
      if (this.stands(hold, day)) continue;
      this.held.delete(hold.project);
      this.deps.store.dropHold(hold.project);
      this.deps.log(`budget: ${hold.project} is held no more`);
      await this.deps
        .lifted(hold.project)
        .catch((error) => this.deps.log(`budget: the mail of ${hold.project} could not be started: ${error.message}`));
    }
    for (const [project, sums] of this.today(day)) this.review(project, sums, day);
    for (const hold of this.held.values()) if (!hold.told) await this.announce(hold);
  }

  /** Tells of a hold once: the project's top seat by a quiet mail, the operators by an incident. */
  private async announce(hold: HoldRow): Promise<void> {
    const top = this.deps.topSeat(hold.project);
    if (top) {
      try {
        await this.deps.notice(
          top,
          "BUDGET: this project is held for today",
          `The project passed its budget for today: ${hold.reason}. Its seats take no new turn and the mail for them waits; nothing is lost and turns already running finish. The hold ends at ${shiftDay(hold.day, 1)} 00:00 UTC, or when the person raises the cap. If work cannot wait, ask your Owner for a higher cap.`,
          { quiet: true, key: `budget:${hold.project}:${hold.since}`, priority: "fyi" },
        );
      } catch (error) {
        this.deps.log(`budget: the top seat of ${hold.project} was not told: ${(error as Error).message}`);
      }
    }
    this.deps.raise(
      `budget: ${hold.project} is over its daily cap: ${hold.reason}; its seats take no turn from mail until the next UTC day or until the cap is raised`,
      `budget|${hold.project}`,
    );
    hold.told = true;
    this.deps.store.toldHold(hold.project);
  }

  /** The reading: today's sums of each project that spent, in all and by role, its last days, ranked by today's dollars, with its cap, the projects held and how many rows of older days it left out. */
  reading(): Record<string, unknown> {
    const day = this.day();
    const today = this.today(day);
    const days = new Map<string, { day: string; usd: number; turns: number }[]>();
    const ledger = this.deps.store.spendFrom(shiftDay(day, 1 - settings.spendRecentDays));
    for (const row of ledger.rows) {
      const rows = days.get(row.project) ?? [];
      rows.push(row);
      days.set(row.project, rows);
    }
    const total = (project: string) => (days.get(project) ?? []).reduce((sum, row) => sum + row.usd, 0);
    const spent = (project: string) => today.get(project)?.usd ?? 0;
    const ranked = [...days.keys()].sort((a, b) => spent(b) - spent(a) || total(b) - total(a) || a.localeCompare(b));
    const shown = ranked.slice(0, settings.spendProjectsShown);
    const roles = new Map<string, Record<string, { usd: number; turns: number; outputTokens: number }>>();
    for (const row of this.deps.store.spendByRole(day, shown))
      roles.set(row.project, {
        ...roles.get(row.project),
        [row.role]: { usd: rounded(row.usd), turns: row.turns, outputTokens: row.outTokens },
      });
    const projects = shown.map((project) => {
      const cap = project ? this.capOf(project) : null;
      const now = today.get(project);
      return {
        project: project || NO_PROJECT,
        today: { usd: rounded(now?.usd ?? 0), turns: now?.turns ?? 0 },
        ...(roles.has(project) ? { byRole: roles.get(project) } : {}),
        cap,
        recent: (days.get(project) ?? [])
          .filter((row) => row.day !== day)
          .sort((a, b) => b.day.localeCompare(a.day))
          .map((row) => `${row.day} $${row.usd.toFixed(2)} ${turnsOf(row.turns)}`),
      };
    });
    return {
      day,
      ...(ledger.leftOut > 0
        ? {
            leftOut: `${ledger.leftOut} rows of daily spend, the oldest days of the last ${settings.spendRecentDays}, are not in this reading`,
          }
        : {}),
      ...(ranked.length > shown.length
        ? {
            projectsLeftOut: `${ranked.length - shown.length} more projects spent in the last ${settings.spendRecentDays} days`,
          }
        : {}),
      held: [...this.held.values()]
        .filter((hold) => this.stands(hold, day))
        .map(({ project, since, reason }) => ({ project, since, reason })),
      projects,
    };
  }

  /** Drops what is kept past its days; how many rows went. */
  expire(): number {
    const now = this.deps.now();
    return this.deps.store.expireSpend(
      shiftDay(dayOf(now), -settings.spendKeepDays),
      new Date(now.getTime() - settings.spendKeepDays * DAY_MS).toISOString(),
    );
  }
}
