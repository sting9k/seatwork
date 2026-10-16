import { createHash } from "node:crypto";
import council from "../../../shared/safety/council.json";
import type { RoleTraits } from "../../../shared/workflow";
import type { TurnEvent } from "../../host";
import { briefFields, quotedCommands, scopeGlobs } from "../../orchestration/brief";
import { redact } from "../../redact";
import { CLOSES_WORK, signalOf } from "../../signals";
import type { MemberCount, MemberState, ReadingRow, SafetyStore } from "../store";
import { counted, hiFor, levelFor } from "./calibration";
import type { Chair, Packet } from "./chair";
import {
  claimsIn,
  clip,
  loopIn,
  maskOf,
  outsideScope,
  quietMinutes,
  runsOneOf,
  testsNotRun,
  turnFacts,
  unborneIn,
  type Unborne,
} from "./facts";
import { gamingLine, hardSigns, softSigns, type GamingEvidence } from "./gaming";
import { changedSince, type Snapshot } from "./git";

/** The council: each member reads a turn for one concern, and speaks at the level it has earned. */

type MemberName = keyof typeof council.members;
type Juror = "claims" | "scope" | "gaming";
const MEMBERS = Object.keys(council.members) as MemberName[];
const MAILS_LEVEL = 2;
const SEND_BACK_LEVEL = 3;

/** The council's settings in the policy: `levels` pins a member's level (2 at most), readings no label holds are kept `keepDays`, an appeal lapses after `chairMinutes`. */
export interface CouncilPolicy {
  mode: "on" | "off";
  keepDays: number;
  tickSeconds: number;
  levels?: Partial<Record<MemberName, number>>;
  chairMinutes?: number;
}

/** What the hand-in saw of a candidate's diff; `returned` once sent back; `related` the unchanged tests naming it. */
export interface HandInDiff {
  gaming: GamingEvidence | null;
  returned: boolean;
  related?: readonly string[];
}

/** The decision district as the council uses it; any provider of typed decisions fits, one that answers a repeated question from memory unless asked `fresh`. */
export interface Decider {
  why(): string | null;
  decide(
    caller: string,
    state: Record<string, unknown>,
    questions: Record<string, unknown>,
    options?: { deadlineMs?: number; fresh?: boolean },
  ): Promise<{ answers: Record<string, { type: string; noul?: number }>; asks: Record<string, number> }>;
}

/** The seat a turn belongs to: its traits say which members read it, `root` is its work tree, `task` its task. */
interface CouncilSeat {
  id: string;
  role: string | null;
  traits: RoleTraits;
  root: string;
  task: string | null;
}

/** A verdict the seat gave this turn on work handed in to it, with what the room knows of that work. */
export interface Verdict {
  to: string;
  accepted: boolean;
  brief: string | null;
  task: string | null;
  rejected: number;
  contextTokens: number | null;
  costUsd: number | null;
  work?: VerdictWork | null;
}

/** The work a verdict is given on: the digest handed in, the digest now, and the verdict given on it before. */
export interface VerdictWork {
  handed: string | null;
  now: string | null;
  previous: { accepted: boolean; digest: string | null } | null;
}

/** A turn that ended, as the room gathers it; `changed` is the files git saw change, when it was asked. */
export interface TurnInput {
  seat: CouncilSeat;
  turn: string | null;
  events: readonly TurnEvent[];
  text: string;
  brief: string | null;
  verdicts: readonly Verdict[];
  changed?: readonly string[] | null;
}

/** What a member says with the report of a turn: its reading's id, its level and one line. */
export interface Finding {
  id: number;
  member: MemberName;
  level: number;
  line: string;
}

/** One member's reading before it is logged: a juror's comes back later, `contested` marks answers that part company, `diff` is what the chair reads of the changes. */
interface Reading {
  tier: "fact" | "juror";
  zone: ReadingRow["zone"];
  line?: string;
  fingerprint?: string;
  evidence?: unknown;
  score?: number;
  scores?: number[];
  askId?: number;
  contested?: "disagree" | "contradicted";
  diff?: string;
  returned?: boolean;
}

type BriefFields = ReturnType<typeof briefFields>;

const shortHash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
const namedChecks = (fields: BriefFields) =>
  quotedCommands([fields.acceptance, fields.contract].filter(Boolean).join("\n"));
const acceptanceOf = (verdict: Verdict) =>
  verdict.brief ? quotedCommands(briefFields(verdict.brief).acceptance ?? "") : [];

/** A reading made at once, or a juror's question to ask when its caller says so. */
type Pending = Reading | (() => Promise<Reading>);

const JUROR_DEADLINE_MS = 8000;
const MAX_JURORS_IN_FLIGHT = 8;
const REPORT_CHARS = 6000;
const COMMANDS_SHOWN = 10;
const COMMAND_CHARS = 200;
const BRIEF_CHARS = 400;
const FINDING_CHARS = 400;

const quoted = (text: string) => `"${clip(text.replace(/\s+/g, " "), 120)}"`;

/** A loop among a turn's last steps, as a found reading. */
function loopReading(events: readonly TurnEvent[]): Reading | null {
  const loop = loopIn(events, council.members.stuck);
  return loop
    ? {
        tier: "fact",
        zone: "found",
        fingerprint: `${loop.pattern}:${loop.command}`,
        line: `stuck: ${loop.pattern} ${loop.count} times in a row: ${quoted(loop.command)}`,
        evidence: loop,
      }
    : null;
}

const LABELS_READ = 500;
const MOVE_EVERY = 20;
const IMPLIED = { acceptanceRun: "implied:acceptance-run", nextVerdict: "implied:next-verdict" } as const;

/** The council over the store: it reads turns, logs every reading, and weighs each member by the labels it gets. */
export class Council {
  private readonly started = new Map<string, { at: number; snapshot: Promise<Snapshot | null> }>();
  private inFlight = 0;

  constructor(
    private readonly deps: {
      store(): SafetyStore;
      decider: Decider | null;
      policy(): CouncilPolicy | undefined;
      log(message: string): void;
      now?: () => number;
      snapshot?: (cwd: string) => Promise<Snapshot | null>;
      seen?: (seat: string) => void;
      diffOf?: (seat: string) => HandInDiff | null;
      chair?: Chair | null;
    },
  ) {}

  get on(): boolean {
    return this.deps.policy()?.mode === "on";
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A member's state as its labels last set it, for its current version only. */
  private state(member: MemberName): MemberState | null {
    const state = this.deps.store().memberState(member);
    return state && state.version === council.members[member].version ? state : null;
  }

  /** The level a member speaks at: the policy's when it pins one, else the one its labels earned; labels alone earn the level that sends work back. */
  level(member: MemberName): number {
    const pinned = this.deps.policy()?.levels?.[member];
    return pinned === undefined
      ? (this.state(member)?.level ?? council.members[member].level)
      : Math.min(pinned, SEND_BACK_LEVEL - 1);
  }

  /** A juror's threshold: where its labels moved it, else the shipped one. */
  private hi(member: Juror): number {
    return this.state(member)?.hi ?? council.members[member].hi;
  }

  /** Whether a member reads seats with these traits. */
  private watches(member: MemberName, traits: RoleTraits): boolean {
    return council.members[member].traits.some((trait) => traits[trait as keyof RoleTraits] === true);
  }

  /** A turn begins: the seat is noted as seen, and its time and the commit its folder stands on are kept, for what the turn changes. */
  turnStarted(seat: string, cwd: string): void {
    try {
      this.deps.seen?.(seat);
    } catch (error) {
      this.deps.log(`council: seat ${seat} was not noted as seen: ${String(error)}`);
    }
    const snapshot = this.on && this.deps.snapshot ? this.deps.snapshot(cwd).catch(() => null) : Promise.resolve(null);
    this.started.set(seat, { at: this.now(), snapshot });
  }

  /** When the seat's running turn began, if the room saw it begin. */
  startOf(seat: string): number | null {
    return this.started.get(seat)?.at ?? null;
  }

  /** The work tree of the seat's running turn and every file that differs from the commit it began on. */
  async changedIn(seat: string): Promise<{ root: string; files: string[] } | null> {
    const found = await (this.started.get(seat)?.snapshot ?? null);
    const files = found ? await changedSince(found) : null;
    return found && files ? { root: found.root, files } : null;
  }

  /** A seat that is gone: its running turn is no longer kept. */
  forget(seat: string): void {
    this.started.delete(seat);
  }

  /** Reads an ended turn; returns what is to be shown with its report, a member's line at a time. */
  async endOfTurn(input: TurnInput): Promise<Finding[]> {
    this.started.delete(input.seat.id);
    if (!this.on) return [];
    this.implied(input);
    const diff = signalOf(input.text) === "CANDIDATE" ? (this.deps.diffOf?.(input.seat.id) ?? null) : null;
    const fields = input.brief ? briefFields(input.brief) : {};
    const findings: Finding[] = [];
    for (const member of MEMBERS) {
      if (!this.watches(member, input.seat.traits)) continue;
      for (const reading of this.read(member, input, fields, diff)) {
        if (typeof reading !== "function") {
          const shown = this.log(member, input, reading);
          if (shown) findings.push(shown);
        } else if (this.level(member) > 0) {
          // a member that speaks is waited for; one that only logs is not
          const settled = await reading().catch((error) => this.failed(member, error));
          const shown = this.log(member, input, settled);
          if (shown) findings.push(shown);
        } else if (this.inFlight < MAX_JURORS_IN_FLIGHT) {
          // a juror past the cap is never asked: its question is not even sent
          this.inFlight += 1;
          void reading()
            .catch((error) => this.failed(member, error))
            .then((settled) => this.log(member, input, settled))
            .catch((error) => this.deps.log(`council: ${member} could not be logged: ${String(error)}`))
            .finally(() => (this.inFlight -= 1));
        }
      }
    }
    return findings;
  }

  /** Reads a running turn for loops and silence; returns what is to be mailed now. */
  whileRunning(seat: CouncilSeat, events: readonly TurnEvent[]): Finding[] {
    if (!this.on || !this.watches("stuck", seat.traits)) return [];
    const quiet = quietMinutes(events, this.now());
    const reading: Reading | null =
      loopReading(events) ??
      (quiet !== null && quiet >= council.members.stuck.silenceMinutes
        ? {
            tier: "fact",
            zone: "found",
            fingerprint: `silence:${events.findLast((event) => event.at)?.at}`,
            line: `stuck: no step for ${Math.round(quiet)} minutes in a running turn`,
            evidence: { quietMinutes: Math.round(quiet) },
          }
        : null);
    // a running turn is logged only for a finding not yet logged: the turn's end logs the turn
    if (!reading || this.deps.store().readBefore(seat.id, "stuck", reading.fingerprint!)) return [];
    const shown = this.log("stuck", { seat, turn: null, events, text: "", brief: null, verdicts: [] }, reading, true);
    return shown ? [shown] : [];
  }

  /** Each member's readings and labels over the last `days`. */
  counts(days: number): MemberCount[] {
    return this.deps.store().councilCounts(new Date(this.now() - days * 86_400_000).toISOString());
  }

  /** Notes that findings reached the seat above, so the same thing found again is not said again. */
  shown(findings: readonly Finding[]): void {
    this.deps.store().markShown(findings.map((finding) => finding.id));
  }

  /** A seat's word on a finding; the member is weighed again. Null when no such finding is kept. */
  label(id: number, source: string, value: "right" | "wrong", note: string | null): MemberName | null {
    const member = this.deps.store().labelReading(id, source, value, note) as MemberName | null;
    if (member && member in council.members) this.weigh(member);
    return member;
  }

  /** What a seat's verdicts this turn say of earlier findings: a check run on the work, a task sent back again. */
  private implied(input: TurnInput): void {
    const store = this.deps.store();
    const touched = new Set<MemberName>();
    for (const verdict of input.verdicts) {
      const wanted = acceptanceOf(verdict);
      const runs = input.events.filter(
        (event): event is Extract<TurnEvent, { kind: "shell" }> =>
          event.kind === "shell" &&
          event.status !== "running" &&
          runsOneOf(event.command, wanted) &&
          maskOf(event.command, wanted) === null,
      );
      const claim = runs.length ? store.openFinding("claims", verdict.to, IMPLIED.acceptanceRun) : null;
      if (claim !== null) {
        // the Owner ran the work's own check: a claim it passes was true, one it fails was not
        store.labelReading(claim, IMPLIED.acceptanceRun, runs.at(-1)!.exitCode === 0 ? "wrong" : "right", null);
        touched.add("claims");
      }
      const repair = store.openFinding(
        "repair",
        input.seat.id,
        IMPLIED.nextVerdict,
        `${verdict.task ?? verdict.to}:`,
        input.turn,
      );
      if (repair !== null) {
        // after a repair finding, the same seat's work sent back again bears it out; accepted, it did not
        store.labelReading(repair, IMPLIED.nextVerdict, verdict.accepted ? "wrong" : "right", null);
        touched.add("repair");
      }
    }
    for (const member of touched) this.weigh(member);
  }

  /** Weighs a member again from its newest labels: the level they earn, and a juror's threshold, moved every 20 labels. */
  private weigh(member: MemberName): void {
    const store = this.deps.store();
    const shipped = council.members[member];
    const labels = counted(store.labelsOf(member, shipped.version, LABELS_READ));
    const total = store.labelCount(member, shipped.version);
    const held = this.state(member);
    // only a member that may send a hand-in back reaches the level that does
    const reach = "sendsBack" in shipped && shipped.sendsBack ? SEND_BACK_LEVEL : SEND_BACK_LEVEL - 1;
    const level = Math.min(levelFor(labels, held?.level ?? 0), reach);
    const shippedHi = "hi" in shipped ? shipped.hi : null;
    const due = shippedHi !== null && total - (held?.labels ?? 0) >= MOVE_EVERY;
    const hi = due ? hiFor(labels, held?.hi ?? shippedHi) : (held?.hi ?? shippedHi);
    if (held && held.level === level && !due) return;
    store.setMemberState({ member, version: shipped.version, level, hi, labels: due || !held ? total : held.labels });
    if (level !== (held?.level ?? shipped.level))
      this.deps.log(`council: ${member} now speaks at level ${level}, from ${labels.length} labels`);
  }

  /** Drops readings older than the policy keeps that no label holds. */
  expire(): number {
    const keepDays = this.deps.policy()?.keepDays ?? 90;
    return this.deps.store().expireCouncil(new Date(this.now() - keepDays * 86_400_000));
  }

  /** A juror that could not be asked is logged as skipped. */
  private failed(member: MemberName, error: unknown): Reading {
    this.deps.log(`council: the ${member} juror could not be asked: ${error instanceof Error ? error.message : error}`);
    return { tier: "juror", zone: "skipped", evidence: { error: String(error).slice(0, 200) } };
  }

  /** Logs a reading; returns it as a finding when it is found, new, and its member speaks; it is shown once its line or its mail reaches the seat above (`shown`). */
  private log(member: MemberName, input: TurnInput, reading: Reading, mailed = false): Finding | null {
    const level = this.level(member);
    const store = this.deps.store();
    const shows =
      reading.zone === "found" &&
      level >= (mailed ? MAILS_LEVEL : 1) &&
      !!reading.line &&
      !(reading.fingerprint && store.shownBefore(input.seat.id, member, reading.fingerprint));
    const id = store.read({
      member,
      version: council.members[member].version,
      seat: input.seat.id,
      role: input.seat.role,
      task: input.seat.task,
      turn: input.turn,
      tier: reading.tier,
      zone: reading.zone,
      score: reading.score ?? null,
      askId: reading.askId ?? null,
      level,
      shown: false,
      fingerprint: reading.fingerprint ?? null,
      evidence: reading.evidence === undefined ? null : JSON.stringify(reading.evidence),
    });
    this.appealIfWarranted(member, input, reading, level, id);
    // the number lets the seat above say whether the finding was right
    return shows ? { id, member, level, line: reading.line!.replace(/^(\w+):/, `$1 #${id}:`) } : null;
  }

  /** A member at the level that sends work back asks the chair about a candidate it found something in or is unsure of. */
  private appealIfWarranted(member: MemberName, input: TurnInput, reading: Reading, level: number, id: number): void {
    const chair = this.deps.chair;
    const shipped = council.members[member];
    if (!chair || level < SEND_BACK_LEVEL || !("sendsBack" in shipped && shipped.sendsBack)) return;
    if (reading.zone !== "found" && reading.zone !== "grey") return;
    if (reading.returned || input.seat.traits.writes !== true || signalOf(input.text) !== "CANDIDATE") return;
    const line = (reading.line ?? `${member}: a finding about this candidate`).replace(/^(\w+):/, `$1 #${id}:`);
    const why = reading.contested ?? (reading.zone === "grey" ? "unsure" : "found");
    void chair
      .appeal({
        reading: id,
        member,
        seat: input.seat.id,
        finding: reading.fingerprint ?? shortHash(reading.line ?? member),
        packet: this.packetOf(member, input, reading, why, line),
      })
      .catch((error) => this.deps.log(`council: ${member} could not ask the chair: ${String(error)}`));
  }

  /** The evidence the chair reads: the finding, the readings, the turn's last commands with exit codes, the diff, the brief. */
  private packetOf(member: MemberName, input: TurnInput, reading: Reading, why: Packet["why"], line: string): Packet {
    const fields = input.brief ? briefFields(input.brief) : {};
    const brief: Record<string, string> = {};
    for (const [name, key] of [
      ["Outcome", "outcome"],
      ["Write scope", "writeScope"],
      ["Non-goals", "nonGoals"],
      ["Acceptance", "acceptance"],
    ] as const)
      if (fields[key]) brief[name] = clip(fields[key]!, BRIEF_CHARS);
    const commands = input.events
      .filter((event): event is Extract<TurnEvent, { kind: "shell" }> => event.kind === "shell")
      .slice(-COMMANDS_SHOWN)
      .map((event) => ({ command: redact(clip(event.command, COMMAND_CHARS)), exit: event.exitCode }));
    const readings = (reading.scores ?? (reading.score === undefined ? [] : [reading.score])).map((score) => ({
      tier: "juror",
      zone: reading.zone,
      score,
    }));
    return {
      member,
      why,
      finding: redact(clip(line, FINDING_CHARS)),
      readings: reading.tier === "fact" ? [{ tier: "fact", zone: reading.zone }, ...readings] : readings,
      commands,
      ...(reading.diff ? { diff: reading.diff } : {}),
      brief,
    };
  }

  /** One answer of a juror's question, placed in the member's grey band; null when none comes. `fresh` is a second reading, never the first one remembered. */
  private async asked(
    member: Juror,
    state: Record<string, unknown>,
    fresh = false,
  ): Promise<{ score: number; zone: ReadingRow["zone"]; askId: number } | null> {
    const { question, lo } = council.members[member];
    const decided = await this.deps.decider!.decide(
      `council.${member}@${council.members[member].version}`,
      state,
      { [member]: question },
      { deadlineMs: JUROR_DEADLINE_MS, fresh },
    );
    const score = decided.answers[member]?.noul;
    if (typeof score !== "number") return null;
    return {
      score,
      zone: score >= this.hi(member) ? "found" : score <= lo ? "clear" : "grey",
      askId: decided.asks[member],
    };
  }

  /** A juror's question as a reading; a member that may send work back asks twice what it did not find clear, and answers that part company make the reading contested. */
  private async ask(
    member: Juror,
    state: Record<string, unknown>,
    line: (score: number) => string,
    evidence: unknown,
  ): Promise<Reading> {
    const first = await this.asked(member, state);
    if (!first) return { tier: "juror", zone: "skipped", evidence };
    const reading: Reading = {
      tier: "juror",
      zone: first.zone,
      score: first.score,
      askId: first.askId,
      line: line(first.score),
      evidence,
    };
    if (first.zone === "clear" || this.level(member) < SEND_BACK_LEVEL) return reading;
    const second = await this.asked(member, state, true);
    if (!second) return reading;
    const scores = [first.score, second.score];
    if (second.zone === "clear")
      return { ...reading, zone: "grey", scores, contested: "disagree", evidence: { evidence, scores } };
    const zone = first.zone === "found" && second.zone === "found" ? "found" : "grey";
    return { ...reading, zone, scores, evidence: { evidence, scores } };
  }

  /** Whether a decision provider is there and ready to be asked. */
  private jurorReady(): boolean {
    return !!this.deps.decider && this.deps.decider.why() === null;
  }

  /** A member's readings of a turn; `diff` is what the hand-in check saw of a candidate's. */
  private read(member: MemberName, input: TurnInput, fields: BriefFields, diff: HandInDiff | null): Pending[] {
    switch (member) {
      case "claims":
        return this.readClaims(input, fields);
      case "scope":
        return this.readScope(input, fields);
      case "gaming":
        return this.readGaming(fields, diff);
      case "radius":
        return readRadius(input, fields, diff);
      case "report":
        return readReport(input, fields);
      case "stuck":
        return [loopReading(input.events) ?? { tier: "fact", zone: "clear" }];
      case "repair":
        return readRepair(input);
      case "verdict":
        return readVerdicts(input);
    }
  }

  /** Holds a report that says the work was checked to the checks the turn ran; a juror is asked only where facts cannot tell. */
  private readClaims(input: TurnInput, fields: BriefFields): Pending[] {
    const named = namedChecks(fields);
    const facts = turnFacts(input.events, named);
    const writes = input.seat.traits.writes === true;
    // a writer's checks count after its last change; a reviewer changes nothing, so any check counts
    const after = writes ? facts.checksAfterChange : facts.checks;
    if (writes && facts.lastChange < 0) return [{ tier: "fact", zone: "skipped" }];
    if (after.some((run) => run.exitCode === 0 && run.masked === null))
      return [{ tier: "fact", zone: "clear", evidence: { checks: after } }];
    const claims = claimsIn(input.text);
    const masked = after.find((run) => run.exitCode === 0 && run.masked !== null);
    const where = `${writes ? "after the last change" : "in the turn"}${masked ? ` (${quoted(masked.command)}: ${masked.masked})` : ""}`;
    if (claims.length)
      return [
        {
          tier: "fact",
          zone: "found",
          line: `claims: the report says ${quoted(claims[0])}, and no check passed ${where}`,
          evidence: { claim: claims[0], checks: after },
        },
      ];
    const signal = signalOf(input.text);
    if (!signal || !CLOSES_WORK.has(signal) || !this.jurorReady()) return [{ tier: "fact", zone: "clear" }];
    return [
      () =>
        this.ask(
          "claims",
          { report: clip(input.text, REPORT_CHARS) },
          (score) => `claims: the report reads as tested (${score.toFixed(2)}), and no check passed ${where}`,
          { signal, checks: after },
        ),
    ];
  }

  /** The files a turn changed are held to its write scope; a juror is asked whether the work touched a non-goal. */
  private readScope(input: TurnInput, fields: BriefFields): Pending[] {
    // git sees every change, a shell's included; the tool calls are what is left without it
    const changed = input.changed ?? turnFacts(input.events, []).changed;
    if (changed.length === 0) return [{ tier: "fact", zone: "skipped" }];
    const out: Pending[] = [];
    const globs = fields.writeScope ? scopeGlobs(fields.writeScope) : [];
    if (globs.length) {
      const outside = outsideScope(changed, globs, input.seat.root);
      out.push(
        outside.length
          ? {
              tier: "fact",
              zone: "found",
              fingerprint: [...outside].sort().join("|"),
              line: `scope: changed ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""}, outside the write scope ${clip(fields.writeScope!, 80)}`,
              evidence: { outside, globs },
            }
          : { tier: "fact", zone: "clear" },
      );
    }
    if (fields.nonGoals && this.jurorReady())
      out.push(() =>
        this.ask(
          "scope",
          { nonGoals: fields.nonGoals, changed: changed.slice(0, 50), report: clip(input.text, REPORT_CHARS) },
          (score) =>
            `scope: the work reads as touching a non-goal (${score.toFixed(2)}): ${clip(fields.nonGoals!, 80)}`,
          { nonGoals: fields.nonGoals },
        ),
      );
    return out.length ? out : [{ tier: "fact", zone: "skipped" }];
  }

  /** Firm signs of bent tests speak for themselves, softer ones go to a juror, and a member that may send the hand-in back checks firm signs against a juror too. */
  private readGaming(fields: BriefFields, diff: HandInDiff | null): Pending[] {
    const evidence = diff?.gaming ?? null;
    if (!evidence) return [];
    const [hard, soft] = [hardSigns(evidence), softSigns(evidence)];
    if (evidence.sourceCount === 0 || hard + soft === 0) return [{ tier: "fact", zone: "clear" }];
    const line = gamingLine(evidence);
    const fingerprint = shortHash(evidence.excerpt);
    const signs = { ...evidence, excerpt: undefined };
    const common = { fingerprint, diff: evidence.excerpt, returned: diff!.returned };
    const facts: Reading = { tier: "fact", zone: "found", line, evidence: signs, ...common };
    const sends = this.level("gaming") >= SEND_BACK_LEVEL;
    if (hard > 0 && !(sends && this.jurorReady())) return [facts];
    if (!this.jurorReady()) return [{ tier: "fact", zone: "clear", evidence: signs }];
    const state = {
      excerpt: evidence.excerpt,
      sourceFiles: evidence.sourceFiles,
      outcome: fields.outcome ? clip(fields.outcome, 600) : null,
    };
    return [
      async () => {
        const juror = await this.ask("gaming", state, (score) => `${line} (${score.toFixed(2)})`, signs);
        if (hard === 0) return { ...juror, ...common };
        if (juror.zone === "skipped") return facts;
        // firm signs the reading of the excerpt does not bear out are a question for the chair, not a finding
        return juror.zone === "clear"
          ? { ...facts, zone: "grey", contested: "contradicted", scores: juror.scores ?? [juror.score!] }
          : {
              ...facts,
              zone: juror.zone === "found" ? "found" : "grey",
              score: juror.score,
              scores: juror.scores,
              askId: juror.askId,
            };
      },
    ];
  }
}

/** A task sent back as often as the member allows is a finding: a fresh seat may do better. */
function readRepair(input: TurnInput): Reading[] {
  return input.verdicts
    .filter((verdict) => !verdict.accepted)
    .map((verdict) =>
      verdict.rejected >= council.members.repair.rejections
        ? {
            tier: "fact",
            zone: "found",
            fingerprint: `${verdict.task ?? verdict.to}:${verdict.rejected}`,
            line: `repair: ${verdict.to}'s work was sent back ${verdict.rejected} times${verdict.contextTokens ? `; its context holds ${Math.round(verdict.contextTokens / 1000)}K tokens` : ""}${verdict.costUsd ? `, it cost ${verdict.costUsd.toFixed(2)} USD` : ""}: a fresh seat, given a failing test for what is wrong, may do better`,
            evidence: verdict,
          }
        : { tier: "fact", zone: "clear", evidence: { rejected: verdict.rejected } },
    );
}

/** The tests that use what a candidate changed are held to the checks that passed after its last change. */
function readRadius(input: TurnInput, fields: BriefFields, diff: HandInDiff | null): Reading[] {
  const related = diff?.related ?? [];
  if (related.length === 0) return [];
  const missed = testsNotRun(input.events, namedChecks(fields), related, input.seat.root);
  if (missed.length === 0) return [{ tier: "fact", zone: "clear", evidence: { related } }];
  return [
    {
      tier: "fact",
      zone: "found",
      fingerprint: shortHash(missed.join("\n")),
      line: `radius: ${missed.length} test(s) that name what changed did not pass after the last change: ${missed.slice(0, 5).join(", ")}${missed.length > 5 ? ", …" : ""}`,
      evidence: { missed, related },
    },
  ];
}

/** A final message held to its turn: the paths it cites or says it changed, the runs it names, the test count it gives. */
function readReport(input: TurnInput, fields: BriefFields): Reading[] {
  const unborne = unborneIn(input.text, input.events, namedChecks(fields), input.seat.root);
  if (unborne.length === 0) return [{ tier: "fact", zone: "clear" }];
  return [
    {
      tier: "fact",
      zone: "found",
      fingerprint: shortHash(JSON.stringify(unborne)),
      line: `report: ${unborne.slice(0, 4).map(unborneLine).join("; ")}`,
      evidence: { unborne },
    },
  ];
}

/** One thing a report says that its turn does not bear out, as the finding names it. */
function unborneLine(one: Unborne): string {
  switch (one.kind) {
    case "path":
      return `names ${quoted(one.said)}, which is not there`;
    case "line":
      return `cites ${quoted(one.said)}, the file has ${one.found}`;
    case "run":
      return `says it ran ${quoted(one.said)}, which this turn did not`;
    case "count":
      return `says ${one.said} pass, the output shows ${one.found}`;
  }
}

/** A verdict held to the work: its acceptance run, the work as handed in, a verdict turned on unchanged work. */
function readVerdicts(input: TurnInput): Reading[] {
  return input.verdicts.flatMap((verdict) => [
    ...(verdict.accepted ? [acceptanceRun(input, verdict)] : []),
    ...workReadings(verdict),
  ]);
}

/** Work accepted without a run of its own acceptance check is a finding. */
function acceptanceRun(input: TurnInput, verdict: Verdict): Reading {
  const wanted = acceptanceOf(verdict);
  if (wanted.length === 0) return { tier: "fact", zone: "skipped" };
  const passed = input.events.filter(
    (event): event is Extract<TurnEvent, { kind: "shell" }> =>
      event.kind === "shell" && event.exitCode === 0 && runsOneOf(event.command, wanted),
  );
  if (passed.some((event) => maskOf(event.command, wanted) === null)) return { tier: "fact", zone: "clear" };
  const masked = passed.at(-1);
  return {
    tier: "fact",
    zone: "found",
    fingerprint: `${verdict.to}:${input.turn}`,
    line: masked
      ? `verdict: accepted ${verdict.to}'s work on a run of ${quoted(wanted[0])} whose exit code proves nothing: ${maskOf(masked.command, wanted)}`
      : `verdict: accepted ${verdict.to}'s work without running its acceptance check ${quoted(wanted[0])}`,
    evidence: { wanted, ...(masked ? { ran: masked.command } : {}) },
  };
}

/** The work under a verdict: accepted after it changed from the hand-in, or the verdict before turned with no change. */
function workReadings(verdict: Verdict): Reading[] {
  const work = verdict.work;
  if (!work?.now) return [];
  const out: Reading[] = [];
  if (verdict.accepted && work.handed && work.handed !== work.now)
    out.push({
      tier: "fact",
      zone: "found",
      fingerprint: `${verdict.to}:${work.now}:changed`,
      line: `verdict: accepted ${verdict.to}'s work, which changed after it was handed in`,
      evidence: { handed: work.handed, now: work.now },
    });
  const before = work.previous;
  if (before && before.accepted !== verdict.accepted && before.digest === work.now)
    out.push({
      tier: "fact",
      zone: "found",
      fingerprint: `${verdict.to}:${work.now}:turned`,
      line: `verdict: ${verdict.accepted ? "accepted" : "sent back"} ${verdict.to}'s work, ${before.accepted ? "accepted" : "sent back"} before with nothing changed since`,
      evidence: { digest: work.now },
    });
  return out;
}
