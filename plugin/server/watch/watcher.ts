import type { RoomParams, WatcherPolicy } from "../policy";
import type { Role } from "../orchestration/seats";
import { fromTemplate, missingLines, parseBrief, type Brief } from "./brief";
import type { Budget } from "./budget";
import { Lru } from "./cache";
import { letters, prompts, toEvents, turnStartOf, type TimelineInput } from "./events";
import { turnFacts, type TurnFacts } from "./facts";
import { changedBetween, trackedAt, type TreeSnapshot } from "./git";
import { isTestPath } from "./scope";
import type { DecisionAnswer, DecisionEngine, DecisionReply } from "./jev";
import { estimateTokens } from "./jev";
import { inquiryFor, REVISION, type Inquiry } from "./questions";
import { CREATED_WITH, gate, RULE_ORDER, unqualified, type BriefGap, type Moment, type RuleId } from "./rules";
import type { ScanFinding, ScanLog, ScanRecord } from "./scanlog";
import { buildRequest, fitting } from "./state";

/** Reads the turns of Lead and Peer seats, turns facts into findings, and tells the seat above. */

export interface SeatView {
  agentId: string;
  role: Role;
  title: string | null;
  cwd: string;
  parent: string | null;
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
  /** The skills of the seat's role that its project's law names. */
  lawSkills(seat: SeatView): string[];
  /** Mails the seat above as the room; returns the mail's id. */
  notify(notice: Notice): Promise<string>;
  now(): number;
  log(message: string): void;
}

const SPANS_KEPT = 20;

interface Turn {
  id: string | null;
  startedAt: number;
  reads: number;
  before: Promise<TreeSnapshot | null>;
  told: Set<string>;
  mailed: boolean;
  carried: boolean;
}

/** One watched seat: `ending` is the turn before the running one while its end is unread; its scans run one at a time. */
interface Watched {
  seat: SeatView;
  brief: Brief | null;
  mails: number;
  briefsTold: Set<string>;
  skills: Set<string>;
  skillsTold: Set<string>;
  turn: Turn | null;
  ending: Turn | null;
  busy: Promise<void>;
}

/** Findings that are told even when the turn has had its one mail: they cannot wait for the next turn. */
const URGENT: ReadonlySet<RuleId> = new Set(["irreversible", "outside-project"]);
/** A brief's gap is its writer's doing: it is told beside the turn's one finding, not in its place. */
const ABOUT_BRIEF: ReadonlySet<RuleId> = new Set(["incomplete-brief"]);
const READ_ONLY_TITLE = /\[(?:peer:(?:review|research)|lens)\b/i;
const MAIL = /^\s*SEATWORK MAIL\b/;
const isPrompt = (entry: TimelineInput) => (entry.item as { type?: unknown } | null)?.type === "user_message";

/** What the brief that opened a Peer's turn lacks: its creation prompt, or a brief in the mail that started it. */
function briefGapOf(
  entries: readonly TimelineInput[],
  received: readonly string[],
  turnId: string | null,
  cwd: string,
): BriefGap | null {
  const last = received.at(-1);
  if (last === undefined) return null;
  if (!MAIL.test(last)) {
    // a Peer a Lead created has one prompt until its first mail: the brief, whatever its shape
    const lines = received.length === 1 ? missingLines(parseBrief(last, cwd)) : [];
    return lines.length > 0 ? { lines } : null;
  }
  // mail that started an earlier turn was judged then
  const opener = entries.findLast(isPrompt);
  if (turnId !== null && opener?.turnId !== undefined && opener.turnId !== turnId) return null;
  for (const letter of letters(last)) {
    if (letter.from !== "owner" || !/\bBRIEF\b/.test(letter.subject)) continue;
    const lines = missingLines(parseBrief(letter.body, cwd), letter.body);
    if (lines.length > 0) return { lines, mail: { id: letter.id, subject: letter.subject } };
  }
  return null;
}

export class Watcher {
  private readonly seats = new Map<string, Watched>();
  private readonly answers = new Lru<Record<string, DecisionAnswer>>(256);
  /** When and where each Peer had a turn: a shared tree tells nothing about one of them. */
  private readonly spans = new Map<string, { cwd: string; from: number; to: number | null }[]>();

  constructor(private readonly deps: WatcherDeps) {}

  private watches(seat: SeatView): boolean {
    return this.deps.policy.mode !== "off" && this.deps.policy.watch.includes(seat.role);
  }

  private open(seat: SeatView, turnId: string | null): Turn {
    return {
      id: turnId,
      startedAt: this.deps.now(),
      reads: 0,
      before: this.deps.snapshot(seat.cwd).catch(() => null),
      told: new Set(),
      mailed: false,
      carried: false,
    };
  }

  turnStarted(seat: SeatView, turnId: string | null): void {
    if (seat.role === "peer") {
      const spans = [...(this.spans.get(seat.agentId) ?? []), { cwd: seat.cwd, from: this.deps.now(), to: null }];
      this.spans.set(seat.agentId, spans.slice(-SPANS_KEPT));
    }
    if (!this.watches(seat)) return;
    const watched = this.seats.get(seat.agentId) ?? {
      seat,
      brief: null,
      mails: 0,
      briefsTold: new Set(),
      skills: new Set(),
      skillsTold: new Set(),
      turn: null,
      ending: null,
      busy: Promise.resolve(),
    };
    watched.seat = seat;
    watched.ending = watched.turn ?? watched.ending;
    const turn = (watched.turn = this.open(seat, turnId));
    this.seats.set(seat.agentId, watched);
    // a brief that lacks a line is worth knowing while the Peer has barely begun
    void this.queue(watched, turn, "start");
  }

  async tick(): Promise<void> {
    await Promise.all(
      [...this.seats.values()].flatMap((watched) => (watched.turn ? [this.queue(watched, watched.turn, "live")] : [])),
    );
  }

  /** `carried`: the seat's report follows at once, so a notice may wait for it. */
  async turnEnded(seat: SeatView, turnId: string | null, carried: boolean): Promise<void> {
    this.closeSpan(seat.agentId);
    if (!this.watches(seat)) return;
    const watched = this.seats.get(seat.agentId) ?? {
      seat,
      brief: null,
      mails: 0,
      briefsTold: new Set(),
      skills: new Set(),
      skillsTold: new Set(),
      turn: null,
      ending: null,
      busy: Promise.resolve(),
    };
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
    this.spans.delete(agentId);
  }

  private closeSpan(agentId: string): void {
    const open = this.spans.get(agentId)?.findLast((span) => span.to === null);
    if (open) open.to = this.deps.now();
  }

  /** Whether another Peer had a turn in the same directory at any time since `from`. */
  private sharedSince(seat: SeatView, from: number): boolean {
    for (const [agentId, spans] of this.spans)
      if (agentId !== seat.agentId && spans.some((span) => span.cwd === seat.cwd && (span.to ?? Infinity) >= from))
        return true;
    return false;
  }

  /** The seat's runtime closed in mid-turn: that turn gets no end and is not read again. */
  cut(agentId: string): void {
    this.closeSpan(agentId);
    const watched = this.seats.get(agentId);
    if (watched) watched.turn = watched.ending = null;
  }

  private queue(watched: Watched, turn: Turn, moment: Moment): Promise<void> {
    watched.busy = watched.busy
      .then(() => this.scan(watched, turn, moment))
      .catch((error) =>
        this.deps.log(
          `watch: scan of ${watched.seat.agentId} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return watched.busy;
  }

  private silentMinutes(seat: SeatView): number {
    if (seat.role === "lead") return this.deps.params.leadStallMinutes;
    return READ_ONLY_TITLE.test(seat.title ?? "")
      ? this.deps.params.reviewStallMinutes
      : this.deps.params.peerStallMinutes;
  }

  private async scan(watched: Watched, turn: Turn, moment: Moment): Promise<void> {
    const { seat } = watched;
    const { policy } = this.deps;
    const view = await this.deps.timeline(seat.agentId);
    if (!view) {
      if (moment === "end")
        this.deps.log(`watch: the turn of ${seat.agentId} was not read: the daemon gave no timeline`);
      return;
    }
    turn.reads += 1;
    // the next turn may have begun already: the history stops where this turn does
    const last = turn.id === null ? -1 : view.entries.findLastIndex((entry) => entry.turnId === turn.id);
    const next =
      last < 0
        ? -1
        : view.entries.findIndex(
            (entry, index) => index > last && entry.turnId !== undefined && entry.turnId !== turn.id,
          );
    const entries = next < 0 ? view.entries : view.entries.slice(0, next);
    const events = toEvents(entries, seat.cwd);
    const received = prompts(entries);
    // the latest prompt written from the template is the brief in force
    let briefAt = -1;
    received.forEach((prompt, index) => {
      const parsed = parseBrief(prompt, seat.cwd);
      if (!fromTemplate(parsed)) return;
      watched.brief = parsed;
      briefAt = index;
    });
    const briefGap =
      seat.role === "peer" && seat.parentRole === "lead" ? briefGapOf(entries, received, turn.id, seat.cwd) : null;
    const before = await turn.before;
    // git shows what changed, not who: it speaks for a Peer that had the tree to itself
    const alone = !this.sharedSince(seat, turn.startedAt);
    const after = before && alone && moment === "end" ? await this.deps.snapshot(seat.cwd).catch(() => null) : null;
    const changed = before && after ? await changedBetween(before, after) : null;
    const changedTests = before && changed ? await trackedAt(before, changed.filter(isTestPath)) : [];
    const facts = turnFacts({
      events,
      turnStart: turnStartOf(entries, events, turn.id),
      cwd: seat.cwd,
      root: before?.root ?? seat.cwd,
      brief: watched.brief,
      ended: moment === "end",
      changed,
      changedTests,
      now: this.deps.now(),
      startedAt: turn.startedAt,
      later: briefAt < 0 ? [] : received.slice(briefAt + 1),
    });
    // the history read is a window: what a seat loaded before it is kept from scan to scan
    for (const skill of facts.skillsSoFar) watched.skills.add(skill);
    const writes = seat.role === "peer" && !READ_ONLY_TITLE.test(seat.title ?? "") && watched.brief?.readOnly !== true;
    const silent = this.silentMinutes(seat);
    const result = gate({
      facts,
      brief: watched.brief,
      moment,
      briefGap,
      now: this.deps.now(),
      pendingPermission: view.pendingPermission,
      ...(writes && moment === "end"
        ? { skills: { loaded: watched.skills, law: this.deps.lawSkills(seat), told: watched.skillsTold } }
        : {}),
      thresholds: {
        ...policy.thresholds,
        silentMinutes: silent,
        inFlightMinutes: silent * policy.thresholds.inFlightFactor,
      },
    });

    const modeOf = (rule: RuleId) => policy.rules[rule] ?? "log";
    const findings: ScanFinding[] = [];
    for (const finding of result.findings) {
      if (
        modeOf(finding.rule) === "off" ||
        turn.told.has(finding.key) ||
        (ABOUT_BRIEF.has(finding.rule) && watched.briefsTold.has(finding.key))
      )
        continue;
      findings.push({
        rule: finding.rule,
        key: finding.key,
        by: "facts",
        evidence: finding.evidence,
        outcome: "logged",
      });
    }
    const asked = result.questions.filter(
      (question) => modeOf(question.rule) !== "off" && !turn.told.has(question.key),
    );
    const engine = asked.length > 0 ? await this.ask(asked, facts, watched.brief, moment, findings) : undefined;
    if (findings.length === 0 && !engine && moment !== "end") return;

    const mail = policy.mode === "on" ? await this.tell(watched, turn, findings, facts) : undefined;
    // what this seat saw when it first ran a test this turn: the label of the work it was handed
    const ran = facts.checksThisTurn.find((run) => run.what === "test" || run.what === "named")?.result;
    for (const finding of findings) {
      turn.told.add(finding.key);
      if (ABOUT_BRIEF.has(finding.rule)) watched.briefsTold.add(finding.key);
      // the key of a skipped skill is the names it lists
      if (finding.rule === "skill-skipped")
        for (const name of finding.key.slice(finding.key.indexOf(":") + 1).split("|")) watched.skillsTold.add(name);
    }
    const record: ScanRecord = {
      at: new Date(this.deps.now()).toISOString(),
      seat: seat.agentId,
      role: seat.role,
      parent: seat.parent,
      turn: turn.id,
      moment,
      rev: REVISION,
      ...(facts.signal ? { signal: facts.signal } : {}),
      tests: facts.lastEdit ? facts.tests : "nothing-to-verify",
      statics: facts.lastEdit ? facts.statics : "nothing-to-verify",
      reads: turn.reads,
      ...(moment === "end" && ran ? { ran } : {}),
      findings,
      ...(engine ? { engine } : {}),
      ...(mail ? { mail } : {}),
    };
    this.deps.scans.append(record);
  }

  /** Puts the questions of the opened rules to the model and adds what it found to `findings`. */
  private async ask(
    asked: readonly { rule: RuleId; key: string }[],
    facts: TurnFacts,
    brief: Brief | null,
    moment: Moment,
    findings: ScanFinding[],
  ): Promise<ScanRecord["engine"]> {
    const { policy, engine, budget } = this.deps;
    const inquiries = asked
      .map((question) => inquiryFor(question.rule))
      .filter((inquiry): inquiry is Inquiry => inquiry !== undefined);
    // what the facts alone say of a rule whose question could not be put
    const logFacts = (rules: readonly RuleId[] = asked.map((question) => question.rule)) => {
      for (const { rule, key } of asked) {
        const evidence = rules.includes(rule) ? unqualified(rule, facts) : null;
        if (evidence) findings.push({ rule, key, by: "facts", evidence, outcome: "logged" });
      }
    };
    if (inquiries.length === 0) return undefined;
    const pace = budget.pace();
    if (!engine.ready() || pace === "closed" || (pace === "saving" && moment !== "end")) {
      logFacts();
      return { ok: false, reason: !engine.ready() ? "not-ready" : `budget-${pace}` };
    }
    // a question whose lines of the message do not fit is left out; the others are still asked
    const fit = fitting(inquiries, facts.message, policy.state);
    const skipped = inquiries.filter((inquiry) => !fit.includes(inquiry)).map((inquiry) => inquiry.rule);
    if (fit.length === 0) {
      logFacts();
      return { ok: false, reason: "evidence-too-long" };
    }
    logFacts(skipped);
    const built = buildRequest(fit, facts, brief, policy.state);
    let answers = this.answers.get(built.hash);
    let outcome: ScanRecord["engine"];
    if (answers) outcome = { ok: true, model: "cache", tokens: 0, ms: 0, cached: true };
    else {
      const reply: DecisionReply = await engine.ask(built.request);
      if (!reply.ok) {
        logFacts(fit.map((inquiry) => inquiry.rule));
        return { ok: false, reason: `${reply.reason}: ${reply.detail}`.slice(0, 200) };
      }
      budget.record(moment, reply.inputTokens || estimateTokens(built.request));
      answers = reply.answers;
      this.answers.set(built.hash, answers);
      outcome = { ok: true, model: reply.model, tokens: reply.inputTokens, ms: reply.ms };
    }
    if (skipped.length > 0) outcome.skipped = skipped;
    for (const inquiry of fit) {
      const score = inquiry.score(answers);
      const key = asked.find((question) => question.rule === inquiry.rule)!.key;
      if (score === null) continue;
      // below the bar the reading is kept as a score only: calibration needs the quiet cases too
      const holds = score >= (policy.scores[inquiry.rule] ?? 1);
      findings.push({
        rule: inquiry.rule,
        key,
        by: "model",
        score,
        evidence: holds ? inquiry.finding(facts, brief) : `asked; score ${score.toFixed(2)} is under the bar`,
        outcome: "logged",
      });
    }
    return outcome;
  }

  /** Mails the seat above the turn's weightiest finding (one mail per turn, urgent ones excepted). */
  private async tell(
    watched: Watched,
    turn: Turn,
    findings: ScanFinding[],
    facts: TurnFacts,
  ): Promise<string | undefined> {
    const { policy } = this.deps;
    const { seat } = watched;
    if (!seat.parent) return undefined;
    const ready = findings
      // a rule that needs a reader is mailed only on a reading: its bare facts also fit an honest report
      .filter(
        (finding) =>
          policy.rules[finding.rule] === "raise" &&
          (finding.by === "facts"
            ? !inquiryFor(finding.rule)
            : (finding.score ?? 0) >= (policy.scores[finding.rule] ?? 1)),
      )
      .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
    const ofTurn = ready.filter((finding) => !ABOUT_BRIEF.has(finding.rule));
    const pick = ofTurn.find((finding) => URGENT.has(finding.rule)) ?? (turn.mailed ? undefined : ofTurn[0]);
    const ofBrief = ready.find((finding) => ABOUT_BRIEF.has(finding.rule));
    const told = [pick, ofBrief].filter((finding): finding is ScanFinding => finding !== undefined);
    for (const finding of ready) finding.outcome = "held";
    if (told.length === 0 || watched.mails >= policy.maxMailsPerSeat) return undefined;
    const who = `${seat.role} ${seat.title ?? seat.agentId}`;
    const basis = (finding: ScanFinding) => {
      if (ABOUT_BRIEF.has(finding.rule))
        return finding.key.endsWith(`:${CREATED_WITH}`)
          ? "This is read from the brief it was created with."
          : "This is read from the mail as it reached the Peer.";
      return finding.by === "model"
        ? `The reading of its message is a model's (score ${finding.score?.toFixed(2)}); the rest is read from its tool calls.`
        : "This is read from its tool calls, not from what it says.";
    };
    const advice = [
      ...(pick
        ? [
            "Check it in one step (get_agent_activity for that seat, or git status and git diff in its directory). If it holds, deal with it as you would had you seen it yourself; if it does not, carry on.",
          ]
        : []),
      ...(ofBrief
        ? [
            "A brief that lacks a line is mended with a REVISED BRIEF: the whole brief again, with the line. The last line is needed word for word: without it a Peer stops asking and guesses. For another line, carry on if the brief says it in other words.",
          ]
        : []),
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
