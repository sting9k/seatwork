import { runGit } from "../git";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Guard, type SafetyPolicy, type SeatRef } from "./guard";
import type { Place } from "./gate/types";
import { inspectHandIn, workDigest, type HandIn } from "./handin";
import { buildControl, buildCopy } from "./control";
import {
  ACCEPTS_READ,
  doneGaps,
  GATE_KEEP_DAYS,
  OPEN_MOST,
  gapsOf,
  HEADS_READ,
  isPush,
  pushedBy,
  PUSHES_READ,
  TURN_ENTRIES,
  type Gate,
  type Pushed,
} from "./acceptance";
import { stamp } from "../gc";
import { CONTROLS_DIR } from "../paths";
import { Chair, type ChairDeps } from "./council/chair";
import { acceptanceOf, Council, type Decider, type HandInDiff, type VerdictWork } from "./council/council";
import { snapshot } from "./council/git";
import { answerHook, claudePlugin, GATE_ENV, type Cli } from "./hooks";
import type { TurnEvent } from "../host";
import { databaseIn, SafetyStore } from "./store";
import { machineTools } from "./system";

/** The Safety district: guard, hand-in check, control, gates, council and chair. */

/** What the district needs of the room: a folder for its store and hooks, the app's listen address, the room's own files the guard watches, and the seat that rules on appeals. */
export interface SafetyDeps {
  dir: string;
  userHome: string;
  daemon: string;
  policy(): SafetyPolicy | undefined;
  seat(agentId: string): { role: string; cwd: string | null } | null;
  projectOf(agentId: string): string | null;
  isAncestor(ancestor: string, agentId: string): boolean;
  tmpOf(agentId: string): string;
  guard: { paths: string[]; except: string[]; secrets?: readonly string[] };
  roomFolder: string;
  decider: Decider | null;
  log(message: string): void;
  chair?: ChairDeps;
}

const BUSY_MS = 2000;
const DIFFS_KEPT = 64;
const BLOCKING_READ = 100;
const OWED_MOST = 8;
const GUARD_READ = 200;

export class Safety {
  private storeHandle: SafetyStore | null = null;
  readonly guard: Guard;
  readonly council: Council;
  private readonly chair: Chair | null;
  private readonly starts = new Map<string, number>();
  private readonly diffs = new Map<string, HandInDiff>();
  private readonly owed = new Map<string, string[]>();

  constructor(private readonly deps: SafetyDeps) {
    this.guard = new Guard({
      store: () => this.store(),
      policy: deps.policy,
      tools: (seat) => machineTools(() => this.startedAt(seat?.id ?? null), this.baseOf),
      place: (seat) => this.placeOf(seat),
    });
    this.chair = deps.chair
      ? new Chair({
          room: deps.chair,
          store: () => this.store(),
          minutes: () => deps.policy()?.council?.chairMinutes,
          log: deps.log,
        })
      : null;
    this.council = new Council({
      store: () => this.store(),
      decider: deps.decider,
      policy: () => deps.policy()?.council,
      log: deps.log,
      snapshot,
      seen: (seat) => void this.existing()?.seen(seat),
      diffOf: (seat) => this.takeDiff(seat),
      chair: this.chair,
    });
  }

  get on(): boolean {
    return this.deps.policy()?.mode !== "off";
  }

  /** The district's store, opened on first use. */
  store(): SafetyStore {
    if (!this.storeHandle) this.storeHandle = new SafetyStore(this.deps.dir, BUSY_MS);
    return this.storeHandle;
  }

  /** Lays down Claude's plugin folder; idempotent. */
  install(): void {
    for (const [path, text] of Object.entries(claudePlugin()))
      writeIfChanged(join(this.deps.dir, "claude", path), text, 0o600);
  }

  /** The env a seat's session opens with, guard on or off: its hooks find the room by it. */
  env(agentId: string, url: string): Record<string, string> {
    return { [GATE_ENV.url]: url, [GATE_ENV.seat]: agentId };
  }

  /** One hook's question, answered in its CLI's shape; `note` rides on the answer, and `noted` says it did. */
  async answer(
    cli: Cli,
    body: Record<string, unknown>,
    agentId: string | null,
    note?: string,
  ): Promise<{ type: string; text: string; noted: boolean }> {
    if (!this.on) return { type: "text/plain", text: "", noted: false };
    const answered = await answerHook(this.guard, cli, body, agentId ? this.seatRef(agentId) : null, note);
    if (answered.wrote && agentId) this.council.wrote(agentId, answered.wrote);
    return answered;
  }

  /** A new seat: where it starts, and the commit its hand-ins are read from. */
  async started(agentId: string, cwd: string): Promise<void> {
    this.starts.set(agentId, Date.now());
    const head = await gitHead(cwd);
    this.store().noteStart(agentId, cwd, head);
    const common = head ? await commonDirOf(cwd) : null;
    if (common && head) this.store().noteBase(common, head);
  }

  /** A successor takes its predecessor's start, so its hand-ins cover the work it took over. */
  inherit(from: string, to: string): void {
    this.store().inherit(from, to);
  }

  /** The hand-in check of a seat's candidate, its diff kept for the council's reading of the same turn; null when the check is off. */
  async handIn(agentId: string): Promise<HandIn | null> {
    this.diffs.delete(agentId);
    if (!this.on || this.deps.policy()?.handin?.mode === "off") return null;
    const place = this.placeOf(this.seatRef(agentId));
    const result = await inspectHandIn(agentId, this.store(), {
      place,
      config: this.guard.gateConfig(),
      tools: machineTools(() => this.startedAt(agentId), this.baseOf),
    });
    if (this.council.on)
      this.keepDiff(agentId, {
        gaming: result.gaming ?? null,
        related: result.related ?? [],
        returned: result.state === "blocked" && this.handInBlocks,
      });
    return result;
  }

  /** The work a verdict is given on, as the room kept it; the verdict is kept with the digest the work has now. */
  async verdictOn(agentId: string, accepted: boolean): Promise<VerdictWork | null> {
    if (!this.on) return null;
    const now = await workDigest(agentId, this.store()).catch(() => null);
    const before = this.store().noteVerdict(agentId, accepted ? "accepted" : "returned", now);
    if (!before) return null;
    const previous = before.verdict ? { accepted: before.verdict === "accepted", digest: before.verdictDigest } : null;
    return { handed: before.handed, now, previous };
  }

  /** A control of a writer's tests: its project at its start, with only the candidate's tests laid in. */
  async control(writer: string): Promise<string> {
    const start = this.store().startOf(writer);
    if (!start?.start_head)
      return `The room has no start of ${writer} in a git repository: there is no base to build a control on.`;
    const made = await buildControl(start.cwd, start.start_head, join(CONTROLS_DIR, stamp(), writer.slice(0, 8)));
    if (typeof made === "string") return `No control for ${writer}: ${made}.`;
    return [
      `A control of ${writer}'s work at ${made.path}: its project at ${made.base.slice(0, 8)}, the commit it started on, with its candidate's tests and the source as it was.`,
      `Tests laid in: ${made.tests.join(", ")}.`,
      `Left at the base: ${made.sources.join(", ") || "nothing"}.`,
      "Run the candidate's tests there: a new test that passes there does not test the change. The copy is cleared in a few days.",
    ].join("\n");
  }

  /** A copy of the commit a writer handed in, for an acceptance run apart. */
  async copy(writer: string): Promise<string> {
    const start = this.store().startOf(writer);
    const handed = this.store().handedOf(writer);
    if (!start || !handed?.head)
      return `The room holds no hand-in of ${writer} with its commit: there is nothing to copy.`;
    const made = await buildCopy(start.cwd, handed.head, join(CONTROLS_DIR, stamp(), `${writer.slice(0, 8)}-head`));
    if (typeof made === "string") return `No copy of ${writer}'s candidate: ${made}.`;
    return [
      `A copy of ${writer}'s candidate at ${made.path}: the commit ${handed.head.slice(0, 8)} HEAD named when it handed in, with the project's installed dependency folders linked.`,
      "Run the brief's acceptance evidence there: what other seats leave in the shared tree is not in it. The copy is cleared in a few days.",
    ].join("\n");
  }

  /** The gate before `accepter`'s ACCEPT of a writer's work; null when off. */
  async acceptance(a: {
    accepter: string;
    writer: string;
    task: string;
    brief: string | null;
    text: string;
    turn: (entries: number) => Promise<readonly TurnEvent[] | null>;
  }): Promise<Gate | null> {
    const mode = this.deps.policy()?.acceptance?.mode ?? "off";
    if (!this.on || mode === "off") return null;
    const store = this.store();
    const wanted = acceptanceOf(a.brief);
    const handed = store.handedOf(a.writer);
    const start = store.startOf(a.writer);
    const [events, now, repo] = await Promise.all([
      wanted.length ? a.turn(TURN_ENTRIES).catch(() => null) : Promise.resolve([]),
      workDigest(a.writer, store).catch(() => null),
      start ? commonDirOf(start.cwd) : Promise.resolve(null),
    ]);
    const blocking = handed ? store.blockingSince(a.writer, handed.at, BLOCKING_READ) : [];
    const gaps = gapsOf({ wanted, events, handed, now, blocking, text: a.text });
    return {
      mode,
      gaps,
      keep: () => {
        if (gaps.length === 0 && handed?.head && start?.start_head && repo)
          store.noteAccept({
            accepter: a.accepter,
            task: a.task,
            writer: a.writer,
            repo,
            base: start.start_head,
            head: handed.head,
            digest: handed.digest,
            commands: wanted,
          });
      },
    };
  }

  /** The gate before `seat`'s DONE; null when off or nothing is open. */
  async done(a: { seat: string; cwd: string; events: readonly TurnEvent[] }): Promise<Gate | null> {
    const mode = this.deps.policy()?.done?.mode ?? "off";
    if (!this.on || mode === "off") return null;
    const store = this.store();
    const open = store.openAccepts(a.seat, ACCEPTS_READ + 1);
    if (open.length === 0) return null;
    const { gaps, head } = await doneGaps(a.cwd, open.slice(0, ACCEPTS_READ), open.length > ACCEPTS_READ, a.events);
    const repo = head ? await commonDirOf(a.cwd) : null;
    return {
      mode,
      gaps,
      keep: () => {
        if (gaps.length === 0 && head && repo) store.noteDone(a.seat, repo, head);
      },
    };
  }

  /** The pushes a seat's turn made, each kept; none when the record is off. */
  async pushes(a: { seat: string; cwd: string; events: readonly TurnEvent[] }): Promise<Pushed[]> {
    if (!this.on || (this.deps.policy()?.push?.mode ?? "off") === "off") return [];
    const runs = a.events.filter(isPush).slice(0, PUSHES_READ);
    if (runs.length === 0) return [];
    const store = this.store();
    const seen = store.kept(new Date(Date.now() - 86_400_000).toISOString(), GUARD_READ, a.seat);
    const flat = (command: string) => command.replace(/\s+/g, " ").trim();
    const repos = new Map<string, string | null>();
    const repoOf = async (dir: string) => {
      if (!repos.has(dir)) repos.set(dir, await commonDirOf(dir));
      return repos.get(dir)!;
    };
    const out: Pushed[] = [];
    for (const run of runs) {
      const cwd = seen.find((call) => flat(call.command) === flat(run.command))?.cwd ?? a.cwd;
      const pushed = await pushedBy(run.command, cwd, async (dir) => {
        const repo = await repoOf(dir);
        return repo ? { base: store.baseOf(repo), heads: store.headsIn(repo, HEADS_READ) } : null;
      });
      for (const push of pushed) {
        const repo = await repoOf(push.dir);
        if (!repo) continue;
        store.notePush({
          seat: a.seat,
          repo,
          remote: push.remote,
          ref: push.ref,
          sha: push.sha,
          uncovered: push.uncovered === null ? -1 : push.uncovered.length + (push.more ? 1 : 0),
        });
        out.push(push);
      }
    }
    return out;
  }

  /** Keeps a gate's line for `seat`'s next report up, the newest few only. */
  oweUp(seat: string, line: string): void {
    this.owed.set(seat, [...(this.owed.get(seat) ?? []), line].slice(-OWED_MOST));
  }

  /** The gates' lines owed under `seat`'s report up, given once. */
  owedUp(seat: string): string[] {
    const lines = this.owed.get(seat) ?? [];
    this.owed.delete(seat);
    return lines;
  }

  /** Drops gate records past their keep; dropped open ACCEPTs are logged. */
  expireGates(now: Date): number {
    const store = this.existing();
    if (!store) return 0;
    const { gone, dropped } = store.expireGates(new Date(now.getTime() - GATE_KEEP_DAYS * 86_400_000), OPEN_MOST);
    if (dropped)
      this.deps.log(`safety: ${dropped} open ACCEPT(s) past the ${OPEN_MOST} kept were dropped, oldest first`);
    return gone + dropped;
  }

  /** The chair's word on an appeal of the council's: the candidate goes back to its seat, or stays. */
  async rule(by: string, id: number, sendBack: boolean, reason: string): Promise<string> {
    return this.chair ? this.chair.rule(by, id, sendBack, reason) : "This room has no chair: nothing to rule on.";
  }

  /** Whether a hand-in check's findings send the candidate back, or only ride up with it. */
  get handInBlocks(): boolean {
    return (this.deps.policy()?.handin?.mode ?? "block") === "block";
  }

  /** A seat's word on one of its hand-in findings. */
  acknowledge(agentId: string, fingerprint: string, reason: string): boolean {
    return this.store().acknowledge(agentId, fingerprint, reason);
  }

  /** An archived seat: what the district held for it goes. */
  forget(agentId: string): void {
    this.starts.delete(agentId);
    this.diffs.delete(agentId);
    this.owed.delete(agentId);
    this.council.forget(agentId);
    this.existing()?.forgetSeat(agentId);
  }

  /** Drops what the guard saw past its keep. */
  expire(before: Date): number {
    return this.existing()?.expire(before) ?? 0;
  }

  /** A seat's word on a council finding about a seat under it. */
  label(by: string, id: number, value: "right" | "wrong", reason: string): string {
    const seat = this.existing()?.readingSeat(id) ?? null;
    if (!seat) return `No council finding #${id}: copy the number from the [council] line.`;
    if (seat === by || !this.deps.isAncestor(by, seat)) return `Finding #${id} is about a seat that is not under you.`;
    const member = this.council.label(id, `seat:${by}`, value, reason);
    return `Noted: finding #${id} was ${value}. ${member} speaks at level ${member ? this.council.level(member) : 0} now.`;
  }

  /** The guard's audit log of the last `days`: the calls each rule held for, then the newest `most` of them. */
  guardLines(days: number, most: number): string[] {
    if (!this.existing()) return [];
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const counts = this.store().keptCounts(since);
    if (!counts.length) return [`The guard kept no call in the last ${days} days.`];
    return [
      `guard, last ${days} days: ${counts.map((c) => `${c.rule} ${c.n}`).join(", ")}`,
      ...this.store()
        .kept(since, most)
        .map(
          (c) =>
            `${c.at} ${c.role ?? "?"} ${c.seat ?? "?"} ${c.pack}:${c.rule} (${c.severity ?? "unread"}): ${c.command}`,
        ),
    ];
  }

  /** How each council member has read turns over the last `days`, as lines. */
  councilLines(days: number): string {
    const counts = this.existing() ? this.council.counts(days) : [];
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
    return this.existing() ? this.council.expire() : 0;
  }

  close(): void {
    this.storeHandle?.close();
    this.storeHandle = null;
  }

  /** What the hand-in check saw of a candidate's diff, kept for the council's reading of that turn; the oldest goes past the limit. */
  private keepDiff(agentId: string, diff: HandInDiff): void {
    this.diffs.delete(agentId);
    if (this.diffs.size >= DIFFS_KEPT) this.diffs.delete(this.diffs.keys().next().value!);
    this.diffs.set(agentId, diff);
  }

  /** The diff kept for a seat's candidate, given once. */
  private takeDiff(agentId: string): HandInDiff | null {
    const diff = this.diffs.get(agentId) ?? null;
    this.diffs.delete(agentId);
    return diff;
  }

  /** The store when the room has one; a look or a sweep never makes an empty one. */
  private existing(): SafetyStore | null {
    return this.storeHandle ?? (existsSync(databaseIn(this.deps.dir)) ? this.store() : null);
  }

  /** The commit the room first saw a repository at; null before the room has a store. */
  private readonly baseOf = (commonDir: string): string | null => this.existing()?.baseOf(commonDir) ?? null;

  /** When a seat began: this process saw it begin, or the store remembers it from an earlier run. */
  private startedAt(agentId: string | null): number | null {
    if (!agentId) return null;
    const seen = this.starts.get(agentId);
    if (seen !== undefined) return seen;
    const stored = this.existing()?.startOf(agentId);
    if (!stored) return null;
    const at = Date.parse(stored.started_at);
    this.starts.set(agentId, at);
    return at;
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
      daemon: this.deps.daemon,
    };
  }
}

/** The git folder a repository's worktrees share, which names the repository wherever a seat starts in it. */
async function commonDirOf(cwd: string): Promise<string | null> {
  const ran = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    timeoutMs: 3000,
    maxBytes: 1 << 16,
  });
  return ran.code === 0 ? ran.out.trim() || null : null;
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
