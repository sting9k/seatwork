import { runGit } from "../git";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packsInForce } from "./gate/packs";
import type { Place } from "./gate/types";
import { Guard, type SafetyPolicy, type SeatRef } from "./guard";
import { inspectHandIn, type HandIn } from "./handin";
import { Council, type Decider } from "./council/council";
import { snapshot } from "./council/git";
import { answerHook, claudePlugin, GATE_ENV, type Cli } from "./hooks";
import { SafetyStore, type CodeRow } from "./store";
import { machineTools } from "./system";

/** The Safety district: the command guard, the hand-in check and the codes. */

export interface SafetyDeps {
  /** the district's store and hook files */
  dir: string;
  userHome: string;
  policy(): SafetyPolicy | undefined;
  seat(agentId: string): { role: string; cwd: string | null } | null;
  projectOf(agentId: string): string | null;
  isAncestor(ancestor: string, agentId: string): boolean;
  tmpOf(agentId: string): string;
  /** the room's own files, and folders inside them a seat may use */
  guard: { paths: string[]; except: string[] };
  roomFolder: string;
  /** its Owner hears of a rule a seat keeps hitting */
  repeated(seat: string, rule: string, count: number, command: string): void;
  decider: Decider | null;
  log(message: string): void;
}

const BUSY_MS = 2000;

export class Safety {
  private storeHandle: SafetyStore | null = null;
  readonly guard: Guard;
  readonly council: Council;
  private readonly starts = new Map<string, number>();
  private readonly noted = new Map<string, string>();

  constructor(private readonly deps: SafetyDeps) {
    this.guard = new Guard({
      store: () => this.store(),
      policy: deps.policy,
      tools: machineTools(() => null),
      place: (seat) => this.placeOf(seat),
      repeated: (seat, rule, count, command) => deps.repeated(seat.id, rule, count, command),
    });
    this.council = new Council({
      store: () => this.store(),
      decider: deps.decider,
      policy: () => deps.policy()?.council,
      log: deps.log,
      snapshot,
    });
  }

  get on(): boolean {
    return this.deps.policy()?.mode !== "off";
  }

  store(): SafetyStore {
    if (!this.storeHandle) {
      mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      this.storeHandle = new SafetyStore(this.deps.dir, BUSY_MS);
    }
    return this.storeHandle;
  }

  get claudePluginDir(): string {
    return join(this.deps.dir, "claude");
  }

  /** Lays down Claude's plugin folder; idempotent. */
  install(): void {
    for (const [path, text] of Object.entries(claudePlugin()))
      writeIfChanged(join(this.claudePluginDir, path), text, 0o600);
  }

  /** The env a seat's session opens with, guard on or off: a hook that cannot reach the room blocks. */
  env(agentId: string, url: string): Record<string, string> {
    return { [GATE_ENV.url]: url, [GATE_ENV.seat]: agentId };
  }

  /** One hook's question, answered in its CLI's shape; `note` rides on an allow, and `noted` says it did. */
  async answer(
    cli: Cli,
    body: Record<string, unknown>,
    agentId: string | null,
    note?: string,
  ): Promise<{ type: string; text: string; noted: boolean }> {
    if (!this.on)
      return { type: "text/plain", text: cli === "pi" || cli === "opencode" ? '{"block":false}' : "", noted: false };
    return answerHook(this.guard, cli, body, agentId ? this.seatRef(agentId) : null, note);
  }

  /** What the guard would make of a command, without running it or keeping anything. */
  async explain(agentId: string, command: string, cwd: string | null): Promise<string> {
    const verdict = await this.guard.check(this.seatRef(agentId), "tool", command, cwd, true);
    if (verdict.allow) return verdict.message ?? "Allowed: no rule of the room's guard holds for this command.";
    return verdict.message ?? "Blocked.";
  }

  /** A new seat: where it starts, and the commit its hand-ins are read from. */
  async started(agentId: string, cwd: string): Promise<void> {
    this.starts.set(agentId, Date.now());
    const head = await gitHead(cwd);
    this.store().noteStart(agentId, cwd, head);
  }

  inherit(from: string, to: string): void {
    this.store().inherit(from, to);
  }

  /** The hand-in check of a seat's candidate; null when the check is off. */
  async handIn(agentId: string): Promise<HandIn | null> {
    const policy = this.deps.policy();
    if (!this.on || policy?.handin?.mode === "off") return null;
    const seat = this.seatRef(agentId);
    const place = this.placeOf(seat);
    return inspectHandIn(agentId, this.store(), {
      place,
      config: {
        packs: packsInForce(policy?.packs?.add, policy?.packs?.remove),
        exempt: policy?.exempt ?? {},
        budgetMs: 1000,
        maxBytes: 64 * 1024,
      },
      tools: machineTools(() => this.starts.get(agentId) ?? null),
    });
  }

  /** Whether a hand-in check's findings send the candidate back, or only ride up with it. */
  get handInBlocks(): boolean {
    return (this.deps.policy()?.handin?.mode ?? "block") === "block";
  }

  /** A grant of a code: only a seat above the blocked one; the person's, only the person. */
  grant(code: string, by: string | "human"): string {
    const rows = this.store().byCode(code);
    if (!rows.length) return `No open code ${code}: it was used, it expired, or it never existed.`;
    const out: string[] = [];
    for (const row of rows) {
      if (by !== "human") {
        if (row.grantor === "human") {
          out.push(`Code ${code} (${row.rule}) is one only the person can grant: tell them what the seat asked for.`);
          continue;
        }
        if (!row.seat || !this.deps.isAncestor(by, row.seat) || row.seat === by) {
          out.push(`Code ${code} belongs to a seat that is not under you; you cannot grant it.`);
          continue;
        }
      }
      this.store().grant(row.hash, by === "human" ? "human" : by);
      out.push(`Granted: the seat may run this once, in ${row.cwd ?? "its folder"}: ${row.shown}`);
    }
    return out.join("\n");
  }

  /** The codes waiting on a seat's word: those of the seats under it. */
  waitingUnder(agentId: string, all: readonly string[]): CodeRow[] {
    return this.store().waiting(all.filter((id) => id !== agentId && this.deps.isAncestor(agentId, id)));
  }

  acknowledge(agentId: string, fingerprint: string, reason: string): boolean {
    return this.store().acknowledge(agentId, fingerprint, reason);
  }

  /** The room's line about a seat's blocked commands since the last time it was said. */
  blocksLine(agentId: string): string | null {
    if (!this.storeHandle) return null;
    const since = this.noted.get(agentId) ?? new Date(this.starts.get(agentId) ?? 0).toISOString();
    this.noted.set(agentId, new Date().toISOString());
    const rows = this.store().blocksSince(agentId, since);
    if (!rows.length) return null;
    return `the guard blocked ${rows.length} command(s) of this seat: ${rows
      .slice(0, 5)
      .map((r) => `${r.rule} (code ${r.code}) ${r.command.slice(0, 80)}`)
      .join("; ")}`;
  }

  /** An archived seat: what the district held for it in memory goes. */
  forget(agentId: string): void {
    this.starts.delete(agentId);
    this.noted.delete(agentId);
    this.council.forget(agentId);
    if (this.storeHandle || existsSync(join(this.deps.dir, "safety.db"))) this.store().forgetSeat(agentId);
  }

  expire(before: Date): number {
    return this.storeHandle || existsSync(join(this.deps.dir, "safety.db")) ? this.store().expire(before) : 0;
  }

  /** A seat's word on a council finding about a seat under it. */
  label(by: string, id: number, value: "right" | "wrong", reason: string): string {
    const seat = this.storeHandle || existsSync(join(this.deps.dir, "safety.db")) ? this.store().readingSeat(id) : null;
    if (!seat) return `No council finding #${id}: copy the number from the [council] line.`;
    if (seat === by || !this.deps.isAncestor(by, seat)) return `Finding #${id} is about a seat that is not under you.`;
    const member = this.council.label(id, `seat:${by}`, value, reason);
    return `Noted: finding #${id} was ${value}. ${member} speaks at level ${member ? this.council.level(member) : 0} now.`;
  }

  /** How each council member has read turns over the last `days`, as lines. */
  councilLines(days: number): string {
    const counts = this.storeHandle || existsSync(join(this.deps.dir, "safety.db")) ? this.council.counts(days) : [];
    if (!counts.length) return `The council read no turn in the last ${days} days.`;
    return counts
      .map(
        (c) =>
          `${c.member}: ${c.readings} readings, ${c.found} found, ${c.grey} unsure, ${c.shown} shown; labelled ${c.right} right, ${c.wrong} wrong`,
      )
      .join("\n");
  }

  /** Drops council readings past the policy's days that no label holds. */
  expireCouncil(): number {
    return this.storeHandle || existsSync(join(this.deps.dir, "safety.db")) ? this.council.expire() : 0;
  }

  close(): void {
    this.storeHandle?.close();
    this.storeHandle = null;
  }

  private seatRef(agentId: string): SeatRef {
    const seat = this.deps.seat(agentId);
    return {
      id: agentId,
      role: seat?.role ?? null,
      project: this.deps.projectOf(agentId),
      tmp: this.deps.tmpOf(agentId),
      start: seat?.cwd ?? null,
    };
  }

  private placeOf(seat: SeatRef | null): Place {
    return {
      home: this.deps.userHome,
      project: seat?.project ?? null,
      tmp: seat?.tmp ?? null,
      start: seat?.start ?? null,
      guard: this.deps.guard,
      roomFolder: this.deps.roomFolder,
    };
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  const ran = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs: 3000, maxBytes: 1 << 20 });
  return ran.code === 0 ? ran.out.trim() || null : null;
}

function writeIfChanged(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && readFileSync(path, "utf8") === text) return;
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
}
