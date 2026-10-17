import { GATE, type Gate, type Older, type Reading } from "./gate";
import { isoTime, lintSentence } from "./lint";
import type { PairBook } from "./pairs";
import { parseAddress } from "./record";
import { KnowledgeRefused } from "./refused";
import type { NextCall } from "../refusal";
import { ftsQueries } from "./search";
import type { Decision, KnowledgeStore, PairChoice, Settled, SourceWords } from "./store";

/** Decisions: what a person with the authority decided, recorded by a seat, settled on the person's words, pushed. */

const IN_FORCE: NextCall = { tool: "seatwork_knowledge", args: { do: "list" } };

const DECISION_LIMITS = {
  statement: 300,
  topic: 60,
  nearby: 5,
  promptChars: 4000,
  notices: 5,
  fromTurns: 3,
  held: 10,
  pending: 10,
  inForce: 100,
  taskDays: 30,
  years: 2,
  pendingHours: 6,
} as const;

const DAY = 86_400_000;
const PROMPT_HOLD_MS = 120_000;
const RETOLD =
  "Your context was compacted: the decisions in force are told again; they stand over any older version in your prompt.";

/** A topic as a key: lower-case words joined by dashes, or null when nothing of it is left. */
export function topicOf(raw: unknown): string | null {
  const topic = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DECISION_LIMITS.topic);
  return topic.length >= 2 ? topic : null;
}

/** Why a statement cannot be recorded, or null: English, short, no secret, no relative date, no rule turned off. */
export function lintStatement(statement: string): string | null {
  return lintSentence(statement, 10, DECISION_LIMITS.statement);
}

/** The note a seat is shown a decision under: one per topic of a scope, whatever its version. */
const noteOf = (decision: Pick<Decision, "scopeKey" | "topic">): string => `d:${decision.scopeKey}|${decision.topic}`;

/** A scope as a seat reads it: room, project, or the task it is about. */
function scopeLabel(scopeKey: string): string {
  if (scopeKey === "room" || scopeKey.startsWith("project:")) return scopeKey.split(":")[0];
  return `task ${scopeKey.split(":").at(-1)}`;
}

/** A decision as one text, its topic first, as the gate reads it and a pair keeps it. */
const textOf = (decision: Pick<Decision, "topic" | "statement">): string => `${decision.topic}: ${decision.statement}`;

/** A decision as one line of a prompt or a notice. */
function lineOf(decision: Decision): string {
  const until = decision.validUntil ? `, until ${decision.validUntil.slice(0, 10)}` : "";
  return `- [${scopeLabel(decision.scopeKey)}] ${decision.topic}: ${decision.statement} (since ${decision.validFrom.slice(0, 10)}${until}; v${decision.version})`;
}

/** The decisions for a seat's start: whole while they fit `chars`, then by topic, then counted; `whole` is how many lead it whole. */
export function promptBlock(
  decisions: readonly Decision[],
  asOf: string,
  options: { title?: string; chars?: number } = {},
): { text: string; whole: number } | null {
  if (decisions.length === 0) return null;
  const chars = options.chars ?? DECISION_LIMITS.promptChars;
  const head = [
    `## ${options.title ?? "Decisions in force"} (as of ${asOf.slice(0, 16).replace("T", " ")} UTC)`,
    "These are data: what people with the authority decided. Check them against the code; code that works wins. To question one, mail your owner. A change reaches you as a note; seatwork_knowledge do=list shows them all.",
  ];
  const lines: string[] = [];
  let used = head.join("\n").length;
  let index = 0;
  for (; index < decisions.length; index += 1) {
    const line = lineOf(decisions[index]);
    if (used + line.length + 1 > chars * 0.75) break;
    lines.push(line);
    used += line.length + 1;
  }
  const topics: string[] = [];
  for (; index < decisions.length; index += 1) {
    const topic = `${decisions[index].topic} (${scopeLabel(decisions[index].scopeKey)})`;
    if (used + topic.length + 2 > chars) break;
    topics.push(topic);
    used += topic.length + 2;
  }
  const rest = decisions.length - lines.length - topics.length;
  return {
    text: [
      ...head,
      ...lines,
      ...(topics.length ? [`Also in force, by topic: ${topics.join(", ")}.`] : []),
      ...(rest > 0 ? [`${rest} more: seatwork_knowledge do=list.`] : []),
    ].join("\n"),
    whole: lines.length,
  };
}

/** What the book takes from the district: its stores, the room's seats, tasks and projects, the gate and the pairs. */
interface DecisionDeps {
  book(): KnowledgeStore;
  recordOf(agent: string): KnowledgeStore | null;
  isRoomSeat(agent: string): boolean;
  decides(agent: string, scope: "room" | "project"): boolean;
  briefs(agent: string): boolean;
  ownedTask(agent: string, task: string): string | null;
  taskOf(agent: string): string;
  projectOf(agent: string): string | null;
  projects(): string[];
  rootOf(cwd: string): string | null;
  gate: Gate;
  pairs: PairBook;
  now(): Date;
}

/** A notice as made for a seat: its text, the changes it holds, what it was made against, and its last own note. */
interface Told {
  text: string;
  seen: { note: string; version: number }[];
  complete: boolean;
  stamp: string;
  upTo: number;
  retold: boolean;
}

/** The decisions of the room: recorded by seats, settled on a person's words, and shown to the seats they bind. */
export class DecisionBook {
  private readonly waiting = new Map<string, { seq: number; line: string }[]>();
  private readonly checked = new Map<string, string>();
  private readonly prompted = new Map<string, { at: number; held: { note: string; version: number }[] }>();
  private readonly nearShown = new Map<string, { key: string; topic: string; near: Decision[] }>();
  private readonly retelling = new Set<string>();
  private generation = 0;
  private seq = 0;

  constructor(private readonly deps: DecisionDeps) {}

  private now(): string {
    return this.deps.now().toISOString();
  }

  /** The scopes a seat is bound by: the room's, its project's and its task's. */
  scopesOf(agent: string): string[] {
    const root = this.deps.projectOf(agent);
    if (!root) return ["room"];
    const task = this.deps.taskOf(agent);
    return ["room", `project:${root}`, ...(task ? [`task:${root}:${task}`] : [])];
  }

  /** The scopes of a seat about to start in `cwd`. */
  private scopesAt(cwd: string): string[] {
    const root = this.deps.rootOf(cwd);
    return ["room", ...(root ? [`project:${root}`] : [])];
  }

  private inDate(decision: Decision, at: string): boolean {
    return decision.validFrom <= at && (decision.validUntil === null || decision.validUntil > at);
  }

  /** What a seat's notices were made against: the book's changes, and the scopes that bind it now. */
  private stampOf(scopes: readonly string[]): string {
    return `${this.generation}|${scopes.join(" ")}`;
  }

  private queue(agent: string, line: string): void {
    const lines = this.waiting.get(agent) ?? [];
    lines.push({ seq: (this.seq += 1), line });
    // a seat that never calls back keeps its newest notes, not every one
    this.waiting.set(agent, lines.slice(-DECISION_LIMITS.held));
  }

  /** The scope key a call names, refused when the caller has no authority for it. */
  private scopeFor(agent: string, args: Record<string, unknown>): { key: string; needsPerson: boolean } {
    const scope = String(args.scope ?? "");
    if (scope === "task") {
      if (!this.deps.briefs(agent))
        throw new KnowledgeRefused("only a seat that briefs work records a task's decision");
      const root = this.deps.projectOf(agent);
      const task = String(args.task ?? this.deps.taskOf(agent)).trim();
      if (!root || !/^[\w.-]{1,80}$/.test(task))
        throw new KnowledgeRefused("a task's decision needs the seat's project and a `task` id");
      // a short id names the same task as its full one: the key always holds the full one
      const owned = this.deps.ownedTask(agent, task);
      if (!owned) throw new KnowledgeRefused(`${task} is not a task of yours or of a seat under you`);
      return { key: `task:${root}:${owned}`, needsPerson: false };
    }
    if (scope !== "room" && scope !== "project") throw new KnowledgeRefused("`scope` is room, project or task");
    if (!this.deps.decides(agent, scope))
      throw new KnowledgeRefused(
        `a ${scope}'s decision is recorded by the seat the person speaks to about the ${scope}: mail it there`,
      );
    if (scope === "room") return { key: "room", needsPerson: true };
    const named = String(args.project ?? "").trim();
    const own = this.deps.projectOf(agent);
    if (own) {
      if (named && named !== own && named !== own.split("/").at(-1))
        throw new KnowledgeRefused(`you record the decisions of your own project, ${own.split("/").at(-1)}`);
      return { key: `project:${own}`, needsPerson: true };
    }
    const roots = this.deps.projects().filter((one) => one === named || one.split("/").at(-1) === named);
    if (roots.length > 1) throw new KnowledgeRefused(`more than one project is named ${named}: give its full path`);
    if (roots.length === 0)
      throw new KnowledgeRefused(`a project's decision names its \`project\`; none is named ${named || "at all"}`);
    return { key: `project:${roots[0]}`, needsPerson: true };
  }

  /** A date a seat gave, checked: ISO with its zone, not past for an end, not past the years a decision may run. */
  private dateOf(raw: unknown, what: string, fallback: string | null): string | null {
    if (raw === undefined || raw === null || raw === "") return fallback;
    const at = isoTime(String(raw));
    if (!at)
      throw new KnowledgeRefused(
        `${what} is not an ISO date like 2026-11-01, or a time with its zone like 2026-11-01T09:00Z; today is ${this.now()}`,
      );
    const now = this.deps.now().getTime();
    if (what === "valid_until" && at.getTime() <= now)
      throw new KnowledgeRefused(`valid_until ${at.toISOString()} is past; today is ${this.now()}`);
    if (at.getTime() > now + DECISION_LIMITS.years * 365 * DAY)
      throw new KnowledgeRefused(`${what} is more than ${DECISION_LIMITS.years} years away; today is ${this.now()}`);
    return at.toISOString();
  }

  /** The dates a call gives, checked: a decision takes effect when recorded, and a task's ends after its days unless told. */
  private datesOf(args: Record<string, unknown>, forTask: boolean): { validFrom: string; validUntil: string | null } {
    const validFrom = this.dateOf(args.valid_from, "valid_from", this.now())!;
    if (validFrom > new Date(this.deps.now().getTime() + 60_000).toISOString())
      throw new KnowledgeRefused("valid_from is ahead: a decision takes effect when it is recorded; record it then");
    const validUntil = this.dateOf(
      args.valid_until,
      "valid_until",
      forTask ? new Date(this.deps.now().getTime() + DECISION_LIMITS.taskDays * DAY).toISOString() : null,
    );
    if (validUntil !== null && validUntil <= validFrom)
      throw new KnowledgeRefused("valid_until must come after valid_from");
    return { validFrom, validUntil };
  }

  /** The person's words a `from` address names, checked as the caller's own recent words that carry no decision yet. */
  private wordsAt(agent: string, from: string): SourceWords {
    const at = parseAddress(from);
    const record = this.deps.recordOf(agent);
    if (!at || at.kind !== "turn" || !at.ref.startsWith(`${agent}:`) || !record)
      throw new KnowledgeRefused(`from: ${from} is not one of your turns`);
    const entry = record.slice("turn", at.ref, at.ordinal, at.ordinal)[0];
    if (!entry || entry.kind !== "owner") throw new KnowledgeRefused(`from: ${from} holds no person's words`);
    if (!record.recentTurns(agent, DECISION_LIMITS.fromTurns).includes(at.ref))
      throw new KnowledgeRefused(`from: ${from} is older than your last ${DECISION_LIMITS.fromTurns} turns`);
    if (this.deps.book().sourceUsed(from)) throw new KnowledgeRefused(`from: ${from} already carries a decision`);
    return { address: from, saidAt: entry.source.startedAt, text: entry.text };
  }

  /** One `decide` or `withdraw` call: checked, read by the gate, then pending until the turn ends, or settled at once on its source. */
  async record(
    agent: string,
    args: Record<string, unknown>,
    action: "decide" | "withdraw",
  ): Promise<Record<string, unknown>> {
    const book = this.deps.book();
    const { key, needsPerson } = this.scopeFor(agent, args);
    const topic = topicOf(args.topic);
    if (!topic) throw new KnowledgeRefused("give the decision a `topic`: a few English words");
    const statement =
      action === "withdraw"
        ? String(args.reason ?? "").trim()
        : String(args.statement ?? "")
            .normalize("NFC")
            .trim();
    const why = lintStatement(statement);
    if (why) throw new KnowledgeRefused(`${action === "withdraw" ? "reason" : "statement"}: ${why}`);
    const current = book.inForce(key, topic);
    const base = Number(args.replaces_version ?? 0);
    if ((current?.version ?? 0) !== base)
      throw new KnowledgeRefused(
        current
          ? `${topic} is in force at version ${current.version}: "${current.statement}". Restate the whole decision and give replaces_version ${current.version}.`
          : `nothing is in force on ${topic}; leave replaces_version out`,
      );
    if (action === "withdraw" && !current)
      throw new KnowledgeRefused(`nothing is in force on ${topic} to withdraw`, IN_FORCE);
    if (action === "decide" && !current && book.countActive(key) >= DECISION_LIMITS.inForce)
      throw new KnowledgeRefused(
        `${DECISION_LIMITS.inForce} decisions are in force for the ${scopeLabel(key)}, the most one scope holds: replace or withdraw one first`,
        IN_FORCE,
      );
    if (action === "decide" && !current && args.new_topic !== true) {
      const words = topic
        .split("-")
        .filter((word) => word.length > 2)
        .map((word) => `"${word}"`)
        .join(" OR ");
      const near = words ? book.nearby(key, words, topic, DECISION_LIMITS.nearby) : [];
      if (near.length) this.refuseNear(agent, key, topic, `topics near ${topic} are in force`, near);
    }
    const { validFrom, validUntil } = this.datesOf(args, key.startsWith("task:"));
    const read = action === "decide" ? await this.gated(agent, key, { topic, statement }, current, args) : null;
    const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : null;
    // read after the gate: another call may have used the same words while the model read this one
    const source = needsPerson && from ? this.wordsAt(agent, from) : null;
    // a person who changes their mind within one turn: the later call stands for the topic
    for (const earlier of book.pendingOf(agent))
      if (earlier.scopeKey === key && earlier.topic === topic)
        book.dropPending(earlier.id, "replaced in the same turn");
    if (needsPerson && !source && book.pendingOf(agent).length >= DECISION_LIMITS.pending)
      throw new KnowledgeRefused(
        `${DECISION_LIMITS.pending} decisions already wait for this turn's end, the most one turn carries: record the rest next turn with \`from\``,
      );
    const pending = book.addDecision({
      action,
      scopeKey: key,
      topic,
      statement,
      baseVersion: base,
      recordedBy: agent,
      validFrom,
      validUntil,
      reason: action === "withdraw" ? statement : "",
    });
    if (read) {
      this.nearShown.delete(agent);
      this.deps.pairs.keep(book, { id: pending.id, text: textOf(pending) }, read.olds, agent, read.reading);
    }
    if (needsPerson && !source)
      return {
        state: "pending",
        id: pending.id,
        topic,
        line: `Pending: ${statement.replace(/[.\s]+$/, "")}. It takes effect when this turn ends, on the person's words in it; nothing is in force yet.`,
        now: this.now(),
      };
    const settled = book.settle(pending.id, source);
    this.changed(agent, settled);
    return { ...this.view(settled), now: this.now() };
  }

  /** Refuses a decision for the ones in force it may be; what the seat does next on that topic says what it made of them. */
  private refuseNear(agent: string, key: string, topic: string, said: string, near: readonly Decision[]): never {
    const seen = this.nearShown.get(agent);
    const same = seen?.key === key && seen.topic === topic;
    this.nearShown.set(agent, { key, topic, near: [...(same ? seen.near : []), ...near].slice(-2 * GATE.most) });
    throw new KnowledgeRefused(
      `${said}: ${near.map((one) => `${one.topic} v${one.version} "${one.statement}"`).join("; ")}. Replace one with its topic and replaces_version, or give new_topic true.`,
    );
  }

  /** The decisions a new one is read beside: the one it replaces, those the seat called other matters, the nearest by words. */
  private oldsOf(
    agent: string,
    key: string,
    decision: Pick<Decision, "topic" | "statement">,
    current: Decision | null,
    newTopic: boolean,
  ) {
    const byId = new Map<number, Decision>();
    const olds: Older[] = [];
    const add = (one: Decision, choice: PairChoice | null) => {
      if (byId.has(one.id) || olds.length >= GATE.most) return;
      byId.set(one.id, one);
      olds.push({ id: one.id, text: textOf(one), choice });
    };
    if (current) add(current, "replaces");
    const seen = this.nearShown.get(agent);
    // the seat's new_topic answers the refusal on this topic, never one on another
    if (newTopic && seen?.key === key && seen.topic === decision.topic)
      for (const one of seen.near) add(one, "independent");
    const queries = ftsQueries(decision.statement);
    if (queries) for (const one of this.deps.book().nearby(key, queries.any, decision.topic, GATE.most)) add(one, null);
    return { olds, byId };
  }

  /** The gate's word on a decision before it is recorded: noise and repeats are refused, the reading kept for its pairs. */
  private async gated(
    agent: string,
    key: string,
    decision: Pick<Decision, "topic" | "statement">,
    current: Decision | null,
    args: Record<string, unknown>,
  ): Promise<{ olds: Older[]; reading: Reading | null }> {
    const { olds, byId } = this.oldsOf(agent, key, decision, current, args.new_topic === true);
    const verdict = await this.deps.gate.check(
      this.deps.book(),
      { text: textOf(decision), facts: { scope: key.split(":")[0] } },
      olds,
    );
    if ("noise" in verdict)
      throw new KnowledgeRefused(
        `not recorded: it reads as ${verdict.noise.label}, ${verdict.noise.meaning}. A decision is a rule that later work follows; if the person meant one, restate it as that rule.`,
      );
    if ("repeats" in verdict)
      this.refuseNear(
        agent,
        key,
        decision.topic,
        "in force on the same matter",
        verdict.repeats.map((id) => byId.get(id)!),
      );
    return { olds, reading: verdict.reading };
  }

  /** A settled decision as the seat that recorded it reads it. */
  private view(settled: Settled): Record<string, unknown> {
    const { decision } = settled;
    if (settled.state === "dropped")
      return { state: "dropped", id: decision.id, topic: decision.topic, line: `Dropped: ${settled.why}.` };
    if (settled.state === "applied")
      return {
        state: "withdrawn",
        topic: decision.topic,
        line: `Withdrawn: ${settled.withdrawn.topic} v${settled.withdrawn.version}.${settled.restored ? ` In force again: ${settled.restored.statement}` : ""}`,
      };
    return {
      state: "active",
      id: decision.id,
      topic: decision.topic,
      version: decision.version,
      line: `Recorded: ${decision.statement}`,
    };
  }

  /** A decision settled: counted, and the seat that recorded a change reads it in its own answer. */
  private changed(agent: string, settled: Settled): void {
    const book = this.deps.book();
    book.tally(`decision-${settled.state}`);
    if (settled.state === "dropped") return;
    this.generation += 1;
    // the seat that recorded the change reads it in its own answer: it is not told it again as news
    const now = settled.state === "active" ? settled.decision : (settled.restored ?? settled.withdrawn);
    if (this.scopesOf(agent).includes(now.scopeKey))
      book.markShown(agent, [{ note: noteOf(now), version: now.state === "active" ? now.id : 0 }]);
  }

  /** A turn ended: the seat's pending decisions settle on the person's words in it, or drop. */
  turnEnded(agent: string, ownerWords: readonly SourceWords[], startedAt: string): void {
    const book = this.deps.book();
    for (const pending of book.pendingOf(agent)) {
      let settled: Settled;
      if (pending.createdAt < startedAt)
        settled = {
          state: "dropped",
          decision: book.dropPending(pending.id, "its turn ended where the room did not see it"),
          why: "its turn ended where the room did not see it; record it again with `from`",
        };
      else if (ownerWords.length === 0)
        settled = {
          state: "dropped",
          decision: book.dropPending(pending.id, "no person's words in its turn"),
          why: "no person's words in its turn; a decision rests on what a person said",
        };
      else settled = book.settle(pending.id, ownerWords[ownerWords.length - 1]);
      this.changed(agent, settled);
      this.queue(agent, String(this.view(settled).line));
    }
  }

  /** What a seat should read now: its own settled decisions, and every change to what binds it. */
  notices(agent: string): Told | null {
    const own = this.waiting.get(agent) ?? [];
    // a seat that takes another task is bound by other decisions, though none changed
    const scopes = this.scopesOf(agent);
    const stamp = this.stampOf(scopes);
    const changes = this.checked.get(agent) === stamp ? [] : this.changesFor(agent, scopes);
    if (own.length === 0 && changes.length === 0) {
      this.checked.set(agent, stamp);
      this.retelling.delete(agent);
      return null;
    }
    // what does not fit stays unseen, to be told next time
    const told = changes.slice(0, Math.max(0, DECISION_LIMITS.notices - own.length));
    const left = changes.length - told.length;
    const retold = this.retelling.has(agent) && told.length > 0;
    const lines = [...(retold ? [RETOLD] : []), ...own.map((one) => one.line), ...told.map((change) => change.line)];
    if (left > 0) lines.push(`${left} more changes follow; seatwork_knowledge do=list shows them all.`);
    return {
      text: `[knowledge] ${lines.join("\n[knowledge] ")}`,
      seen: told.map(({ note, version }) => ({ note, version })),
      complete: left === 0,
      stamp,
      upTo: own.at(-1)?.seq ?? 0,
      retold,
    };
  }

  /** A seat's context was compacted: what it was told may be gone, so every decision binding it is told again. */
  compacted(agent: string): void {
    const book = this.deps.book();
    book.forgetShown(agent);
    book.tally("seat-compacted");
    this.checked.delete(agent);
    this.retelling.add(agent);
  }

  /** The changes a seat has not seen: decisions new or changed since it was shown them, and ones no longer in force. */
  private changesFor(agent: string, scopes: readonly string[]): { note: string; version: number; line: string }[] {
    const book = this.deps.book();
    const at = this.now();
    const shown = book.shownTo(agent);
    const active = book.activeIn(scopes).filter((decision) => this.inDate(decision, at));
    const live = new Set(active.map(noteOf));
    // a seat holds the id of the decision it was shown: a restored older one is a change too
    const changes = active
      .filter((decision) => shown.get(noteOf(decision)) !== decision.id)
      .map((decision) => ({
        note: noteOf(decision),
        version: decision.id,
        line: `${shown.has(noteOf(decision)) ? "Decision changed" : "New decision"}: ${lineOf(decision).slice(2)}`,
      }));
    for (const [note] of shown)
      if (note.startsWith("d:") && !live.has(note))
        changes.push({ note, version: 0, line: `No longer in force: ${note.slice(2).replace("|", " ")}.` });
    return changes;
  }

  /** What a seat was given is now seen: only the own notes it held, and changes up to when it was made, never later ones. */
  delivered(agent: string, told: Told): void {
    // own notes go by number: one queued while the notice was on its way stays, wherever the queue moved it
    const left = (this.waiting.get(agent) ?? []).filter((one) => one.seq > told.upTo);
    if (left.length) this.waiting.set(agent, left);
    else this.waiting.delete(agent);
    if (told.seen.length) this.deps.book().markShown(agent, told.seen);
    if (told.complete && told.stamp === this.stampOf(this.scopesOf(agent))) this.checked.set(agent, told.stamp);
    else this.checked.delete(agent);
    if (told.retold) this.retelling.delete(agent);
  }

  /** The decisions in force for the task a seat works on, as a block of at most `chars` for the seat that takes its place; null when none. */
  forSuccessor(agent: string, chars: number): { text: string; held: Told["seen"] } | null {
    const scope = this.scopesOf(agent).find((key) => key.startsWith("task:"));
    if (!scope) return null;
    const at = this.now();
    const active = this.deps
      .book()
      .activeIn([scope])
      .filter((decision) => this.inDate(decision, at));
    const block = promptBlock(active, at, { title: "Decisions in force for your task", chars });
    if (!block) return null;
    return {
      text: block.text,
      held: active.slice(0, block.whole).map((one) => ({ note: noteOf(one), version: one.id })),
    };
  }

  /** A seat was given these decisions in its prompt: they count as shown. */
  givenInPrompt(agent: string, held: Told["seen"]): void {
    if (held.length > 0) this.deps.book().markShown(agent, held);
    this.checked.delete(agent);
  }

  /** The block a seat starting in `cwd` is given in its system prompt; what it showed whole is kept for that `launch`. */
  promptFor(cwd: string, launch: string): string | null {
    const at = this.now();
    const active = this.deps
      .book()
      .activeIn(this.scopesAt(cwd))
      .filter((decision) => this.inDate(decision, at));
    const now = this.deps.now().getTime();
    for (const [key, held] of this.prompted) if (now - held.at > PROMPT_HOLD_MS) this.prompted.delete(key);
    const block = promptBlock(active, at);
    if (!block) return null;
    // a decision named only by its topic, or only counted, still reaches the seat as a notice
    const held = active.slice(0, block.whole).map((one) => ({ note: noteOf(one), version: one.id }));
    this.prompted.set(launch, { at: now, held });
    return block.text;
  }

  /** A seat just started on the block of `promptFor` for its launch: what that block showed counts as shown, nothing made after it. */
  opened(agent: string, launch: string | null): void {
    const kept = launch === null ? undefined : this.prompted.get(launch);
    if (launch !== null) this.prompted.delete(launch);
    if (kept?.held.length) this.deps.book().markShown(agent, kept.held);
    // its task's decisions are not in its prompt: its first notice looks at everything that binds it
    this.checked.delete(agent);
  }

  /** The decisions binding a seat, and its own pending ones; a room seat may ask for every scope. */
  list(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const book = this.deps.book();
    const at = this.now();
    const scopes =
      args.all === true && this.deps.isRoomSeat(agent)
        ? ["room", ...this.deps.projects().map((root) => `project:${root}`)]
        : this.scopesOf(agent);
    return {
      now: at,
      inForce: book
        .activeIn(scopes)
        .filter((decision) => this.inDate(decision, at))
        .map(lineOf),
      pending: book.pendingOf(agent).map((decision) => `${decision.topic}: ${decision.statement}`),
    };
  }

  /** The minute's pass: pending decisions past their hours drop, and decisions past their date end. */
  sweep(): void {
    const book = this.deps.book();
    const before = new Date(this.deps.now().getTime() - DECISION_LIMITS.pendingHours * 3_600_000).toISOString();
    for (const pending of book.stalePending(before)) {
      const dropped = book.dropPending(pending.id, "its turn never ended where the room saw it");
      this.queue(pending.recordedBy, `Dropped: ${dropped.topic}: its turn never ended where the room saw it.`);
    }
    if (book.expireDue().length) this.generation += 1;
  }

  /** A seat's first claim gave its task a new key: what it recorded under the old one is the new one's, and the seat is not told it again as news. */
  rekey(agent: string, from: string, to: string): void {
    if (this.deps.book().moveScope(from, to, agent) === 0) return;
    this.generation += 1;
    this.checked.delete(agent);
  }

  /** A seat that is gone: what it left pending drops, nothing waits for it, and nothing it was shown is kept. */
  forget(agent: string): void {
    this.nearShown.delete(agent);
    this.retelling.delete(agent);
    this.waiting.delete(agent);
    this.checked.delete(agent);
    const book = this.deps.book();
    // a turn end or a sweep after this finds nothing of the seat to settle, so nothing comes back for it
    book.dropPendingOf(agent, "its seat is gone");
    book.forgetShown(agent);
  }
}
