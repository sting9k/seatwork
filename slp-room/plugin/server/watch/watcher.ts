import type { RoomParams, WatcherPolicy } from "../policy";
import type { Role } from "../seats";
import { fromTemplate, missingLines, parseBrief, type Brief } from "./brief";
import type { Budget } from "./budget";
import { Lru } from "./cache";
import { prompts, toEvents, turnStartOf, type TimelineInput } from "./events";
import { turnFacts, type TurnFacts } from "./facts";
import { changedBetween, type TreeSnapshot } from "./git";
import type { DecisionAnswer, DecisionEngine, DecisionReply } from "./jev";
import { estimateTokens } from "./jev";
import { inquiryFor, REVISION, type Inquiry } from "./questions";
import { gate, RULE_ORDER, unqualified, type Moment, type RuleId } from "./rules";
import type { ScanFinding, ScanLog, ScanRecord } from "./scanlog";
import { buildRequest } from "./state";

/** Reads the turns of Lead and Peer seats, turns facts into findings, and tells the seat above. It never touches a seat. */

export interface SeatView {
  agentId: string;
  role: Role;
  title: string | null;
  cwd: string;
  parent: string | null;
  /** The role of the seat above; null when there is none or it is not a room seat. */
  parentRole: Role | null;
}

export interface TimelineView {
  entries: TimelineInput[];
  pendingPermission: boolean;
}

export interface Notice {
  to: string;
  subject: string;
  body: string;
  /** The seat's own report follows at once: this notice waits for it, so the seat above reads both in one prompt. */
  withReport: boolean;
}

export interface WatcherDeps {
  policy: WatcherPolicy;
  params: RoomParams;
  engine: DecisionEngine;
  budget: Budget;
  scans: ScanLog;
  /** The seat's recent history; null when the daemon cannot say. */
  timeline(agentId: string): Promise<TimelineView | null>;
  snapshot(cwd: string): Promise<TreeSnapshot | null>;
  /** Mails the seat above as the room; returns the mail's id. */
  notify(notice: Notice): Promise<string>;
  now(): number;
  log(message: string): void;
}

interface Turn {
  id: string | null;
  before: Promise<TreeSnapshot | null>;
  told: Set<string>;
  mailed: boolean;
  carried: boolean;
}

interface Watched {
  seat: SeatView;
  brief: Brief | null;
  mails: number;
  /** The turn that is running. */
  turn: Turn | null;
  /** The turn before it, while its end has not been read: held mail can start the next turn first. */
  ending: Turn | null;
  /** Scans of one seat run one after another. */
  busy: Promise<void>;
}

/** Findings that are told even when the turn has had its one mail: they cannot wait for the next turn. */
const URGENT: ReadonlySet<RuleId> = new Set(["irreversible", "outside-project"]);
/** What a brief lacks is its writer's doing, not the turn's: it is told beside the turn's one finding and does not take its place. */
const ABOUT_BRIEF: ReadonlySet<RuleId> = new Set(["incomplete-brief"]);
const READ_ONLY_TITLE = /\[(?:peer:(?:review|research)|lens)\b/i;
const MAIL = /^\s*SLP MAIL\b/;

export class Watcher {
  private readonly seats = new Map<string, Watched>();
  private readonly answers = new Lru<Record<string, DecisionAnswer>>(256);

  constructor(private readonly deps: WatcherDeps) {}

  private watches(seat: SeatView): boolean {
    return this.deps.policy.mode !== "off" && this.deps.policy.watch.includes(seat.role);
  }

  private open(seat: SeatView, turnId: string | null): Turn {
    return { id: turnId, before: this.deps.snapshot(seat.cwd).catch(() => null), told: new Set(), mailed: false, carried: false };
  }

  turnStarted(seat: SeatView, turnId: string | null): void {
    if (!this.watches(seat)) return;
    const watched = this.seats.get(seat.agentId) ?? { seat, brief: null, mails: 0, turn: null, ending: null, busy: Promise.resolve() };
    watched.seat = seat;
    watched.ending = watched.turn ?? watched.ending;
    const turn = (watched.turn = this.open(seat, turnId));
    this.seats.set(seat.agentId, watched);
    // a brief that lacks a line is worth knowing while the Peer has barely begun
    void this.queue(watched, turn, "start");
  }

  async tick(): Promise<void> {
    await Promise.all([...this.seats.values()].flatMap((watched) => (watched.turn ? [this.queue(watched, watched.turn, "live")] : [])));
  }

  /** `carried`: a mail that starts the parent's turn follows at once (the seat's report), so a notice may wait for it. */
  async turnEnded(seat: SeatView, turnId: string | null, carried: boolean): Promise<void> {
    if (!this.watches(seat)) return;
    const watched = this.seats.get(seat.agentId) ?? { seat, brief: null, mails: 0, turn: null, ending: null, busy: Promise.resolve() };
    this.seats.set(seat.agentId, watched);
    // a turn that started before the plugin did is still read at its end
    const turn = [watched.turn, watched.ending].find((known) => known?.id === turnId) ?? this.open(seat, turnId);
    turn.carried = carried;
    await this.queue(watched, turn, "end");
    if (watched.turn === turn) watched.turn = null;
    if (watched.ending === turn) watched.ending = null;
  }

  forget(agentId: string): void {
    this.seats.delete(agentId);
  }

  private queue(watched: Watched, turn: Turn, moment: Moment): Promise<void> {
    watched.busy = watched.busy.then(() => this.scan(watched, turn, moment)).catch((error) => this.deps.log(`watch: scan of ${watched.seat.agentId} failed: ${error instanceof Error ? error.message : String(error)}`));
    return watched.busy;
  }

  private silentMinutes(seat: SeatView): number {
    if (seat.role === "lead") return this.deps.params.leadStallMinutes;
    return READ_ONLY_TITLE.test(seat.title ?? "") ? this.deps.params.reviewStallMinutes : this.deps.params.peerStallMinutes;
  }

  private async scan(watched: Watched, turn: Turn, moment: Moment): Promise<void> {
    const { seat } = watched;
    const { policy } = this.deps;
    const view = await this.deps.timeline(seat.agentId);
    if (!view) {
      if (moment === "end") this.deps.log(`watch: the turn of ${seat.agentId} was not read: the daemon gave no timeline`);
      return;
    }
    // the next turn may have begun before this one's end is read: the history stops where this turn does
    const last = turn.id === null ? -1 : view.entries.findLastIndex((entry) => entry.turnId === turn.id);
    const next = last < 0 ? -1 : view.entries.findIndex((entry, index) => index > last && entry.turnId !== undefined && entry.turnId !== turn.id);
    const entries = next < 0 ? view.entries : view.entries.slice(0, next);
    const events = toEvents(entries, seat.cwd);
    const received = prompts(entries);
    // the latest prompt written from the brief template is the brief in force (a REVISED BRIEF is the whole brief again)
    for (const prompt of received) {
      const parsed = parseBrief(prompt, seat.cwd);
      if (fromTemplate(parsed)) watched.brief = parsed;
    }
    // a Peer a Lead created has, in its first turn, one prompt: the brief, whatever shape the Lead gave it
    const created = seat.role === "peer" && seat.parentRole === "lead" && received.length === 1 && !MAIL.test(received[0]);
    const briefGaps = created ? missingLines(parseBrief(received[0], seat.cwd)) : [];
    const before = await turn.before;
    const after = before && moment === "end" ? await this.deps.snapshot(seat.cwd).catch(() => null) : null;
    const changed = before && after ? await changedBetween(before, after) : null;
    const facts = turnFacts({ events, turnStart: turnStartOf(entries, events, turn.id), cwd: seat.cwd, root: before?.root ?? seat.cwd, brief: watched.brief, ended: moment === "end", changed, now: this.deps.now() });
    const silent = this.silentMinutes(seat);
    const result = gate({ facts, brief: watched.brief, moment, briefGaps, now: this.deps.now(), pendingPermission: view.pendingPermission, thresholds: { ...policy.thresholds, silentMinutes: silent, inFlightMinutes: silent * policy.thresholds.inFlightFactor } });

    const modeOf = (rule: RuleId) => policy.rules[rule] ?? "log";
    const findings: ScanFinding[] = [];
    for (const finding of result.findings) {
      if (modeOf(finding.rule) === "off" || turn.told.has(finding.key)) continue;
      findings.push({ rule: finding.rule, key: finding.key, by: "facts", evidence: finding.evidence, outcome: "logged" });
    }
    const asked = result.questions.filter((question) => modeOf(question.rule) !== "off" && !turn.told.has(question.key));
    const engine = asked.length > 0 ? await this.ask(asked, facts, watched.brief, moment, findings) : undefined;
    if (findings.length === 0 && !engine && moment !== "end") return;

    const mail = policy.mode === "on" ? await this.tell(watched, turn, findings, facts) : undefined;
    for (const finding of findings) turn.told.add(finding.key);
    const record: ScanRecord = { at: new Date(this.deps.now()).toISOString(), seat: seat.agentId, role: seat.role, parent: seat.parent, turn: turn.id, moment, rev: REVISION, ...(facts.signal ? { signal: facts.signal } : {}), tests: facts.lastEdit ? facts.tests : "nothing-to-verify", statics: facts.lastEdit ? facts.statics : "nothing-to-verify", findings, ...(engine ? { engine } : {}), ...(mail ? { mail } : {}) };
    this.deps.scans.append(record);
  }

  /** Puts the questions of the opened rules to the model and adds what it found to `findings`. */
  private async ask(asked: readonly { rule: RuleId; key: string }[], facts: TurnFacts, brief: Brief | null, moment: Moment, findings: ScanFinding[]): Promise<ScanRecord["engine"]> {
    const { policy, engine, budget } = this.deps;
    const inquiries = asked.map((question) => inquiryFor(question.rule)).filter((inquiry): inquiry is Inquiry => inquiry !== undefined);
    const logFacts = () => {
      for (const { rule, key } of asked) {
        const evidence = unqualified(rule, facts);
        if (evidence) findings.push({ rule, key, by: "facts", evidence, outcome: "logged" });
      }
    };
    if (inquiries.length === 0) return undefined;
    const pace = budget.pace();
    if (!engine.ready() || pace === "closed" || (pace === "saving" && moment !== "end")) {
      logFacts();
      return { ok: false, reason: !engine.ready() ? "not-ready" : `budget-${pace}` };
    }
    const built = buildRequest(inquiries, facts, brief, policy.state);
    if (!built.whole) {
      logFacts();
      return { ok: false, reason: "evidence-too-long" };
    }
    let answers = this.answers.get(built.hash);
    let outcome: ScanRecord["engine"];
    if (answers) outcome = { ok: true, model: "cache", tokens: 0, ms: 0, cached: true };
    else {
      const reply: DecisionReply = await engine.ask(built.request);
      if (!reply.ok) {
        logFacts();
        return { ok: false, reason: `${reply.reason}: ${reply.detail}`.slice(0, 200) };
      }
      budget.record(moment, reply.inputTokens || estimateTokens(built.request));
      answers = reply.answers;
      this.answers.set(built.hash, answers);
      outcome = { ok: true, model: reply.model, tokens: reply.inputTokens, ms: reply.ms };
    }
    for (const inquiry of inquiries) {
      const score = inquiry.score(answers);
      const key = asked.find((question) => question.rule === inquiry.rule)!.key;
      if (score === null) continue;
      // below the bar the reading is kept as a score only: the calibration needs the quiet cases too
      const holds = score >= (policy.scores[inquiry.rule] ?? 1);
      findings.push({ rule: inquiry.rule, key, by: "model", score, evidence: holds ? inquiry.finding(facts, brief) : `asked; score ${score.toFixed(2)} is under the bar`, outcome: "logged" });
    }
    return outcome;
  }

  /** Mails the seat above the weightiest finding of the turn (one mail per turn, urgent ones excepted) and, beside it, what the brief lacks. */
  private async tell(watched: Watched, turn: Turn, findings: ScanFinding[], facts: TurnFacts): Promise<string | undefined> {
    const { policy } = this.deps;
    const { seat } = watched;
    if (!seat.parent) return undefined;
    const ready = findings
      // a rule that needs a reader is mailed only on a reading: its bare facts also fit an honest report
      .filter((finding) => policy.rules[finding.rule] === "raise" && (finding.by === "facts" ? !inquiryFor(finding.rule) : (finding.score ?? 0) >= (policy.scores[finding.rule] ?? 1)))
      .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
    const ofTurn = ready.filter((finding) => !ABOUT_BRIEF.has(finding.rule));
    const pick = ofTurn.find((finding) => URGENT.has(finding.rule)) ?? (turn.mailed ? undefined : ofTurn[0]);
    const ofBrief = ready.find((finding) => ABOUT_BRIEF.has(finding.rule));
    const told = [pick, ofBrief].filter((finding): finding is ScanFinding => finding !== undefined);
    for (const finding of ready) finding.outcome = "held";
    if (told.length === 0 || watched.mails >= policy.maxMailsPerSeat) return undefined;
    const who = `${seat.role} ${seat.title ?? seat.agentId}`;
    const basis = (finding: ScanFinding) => {
      if (ABOUT_BRIEF.has(finding.rule)) return "This is read from the brief it was created with.";
      return finding.by === "model" ? `The reading of its message is a model's (score ${finding.score?.toFixed(2)}); the rest is read from its tool calls.` : "This is read from its tool calls, not from what it says.";
    };
    const advice = [
      ...(pick ? ["Check it in one step (get_agent_activity for that seat, or git status and git diff in its directory). If it holds, deal with it as you would had you seen it yourself; if it does not, carry on."] : []),
      ...(ofBrief ? ["A brief that lacks a line is mended with a REVISED BRIEF: the whole brief again, with the line. The last line is needed word for word: without it a Peer stops asking and guesses. For another line, carry on if the brief says it in other words."] : []),
    ];
    const id = await this.deps.notify({
      to: seat.parent,
      subject: `OBSERVATION: ${who} ${told[0].evidence}`.slice(0, 180),
      body: [
        `The room watched ${who} (${seat.agentId})${facts.ended ? "" : ", whose turn is still running,"} and noticed:`,
        "",
        ...told.map((finding) => `- It ${finding.evidence}. ${basis(finding)}`),
        "",
        `${advice.join(" ")} Nobody waits for an answer to this notice.`,
      ].join("\n"),
      withReport: facts.ended && turn.carried,
    });
    for (const finding of told) finding.outcome = "raised";
    if (pick) turn.mailed = true;
    watched.mails += 1;
    return id;
  }
}
