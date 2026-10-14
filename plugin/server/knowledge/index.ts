import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Message } from "../coordination/store";
import type { TurnEvent } from "../host";
import { redact } from "../redact";
import { addressOf, entriesOf, parseAddress, turnRef, type EntryKind } from "./record";
import { DecisionBook } from "./decisions";
import { Gate, type Judge } from "./gate";
import { PairBook } from "./pairs";
import { KnowledgeRefused } from "./refused";
import { isoTime } from "./lint";
import { ftsQueries, fuse, pack, QUERY_CHARS } from "./search";
import { KnowledgeStore, type Filters, type Found, type Source, type SourceWords } from "./store";

/** The Knowledge district: the room's record of turns and mail, and its decisions, for seats to search and be told. */

/** The policy's knowledge section: `mode`, the record's `keepDays` and `maxEntries`, and `gate` for the keep gate. */
export interface KnowledgePolicy {
  mode: "on" | "off";
  keepDays: number;
  maxEntries?: number;
  gate?: boolean;
}

/** What the district takes from the room: its seats, projects, mail and tasks, and the decision model. */
export interface KnowledgeDeps {
  roomDir: string;
  policy(): KnowledgePolicy | undefined;
  projectOf(agentId: string): string | null;
  projects(): string[];
  mailAfter(root: string | null, id: number, limit: number): (Message & { to: string[] })[];
  seen(reader: string): readonly string[] | null;
  ownedTask(agentId: string, task: string): string | null;
  isRoomSeat(agentId: string): boolean;
  briefs(agentId: string): boolean;
  taskOf(agentId: string): string;
  rootOf(cwd: string): string | null;
  threadsOf(agentId: string): string[];
  judge?: Judge | null;
  busyTimeoutMs: number;
  now?: () => Date;
  log(line: string): void;
}

/** A seat's turn as it ends: whose, how it ended, and what it did. */
export interface EndedTurn {
  agent: string;
  parentId: string | null;
  role: string;
  task: string;
  turnId: string | null;
  outcome: string;
  events: readonly TurnEvent[];
}

const PROJECT_DIR = join(".seatwork", ".knowledge");

const MAIL = { batch: 500, batches: 5, chars: 20_000 } as const;
const SEARCH = { pool: 50, limit: 10, most: 50, phrases: 4 } as const;
const AROUND = { default: 5, most: 20 } as const;
const PACK = { default: 6000, most: 20_000, pool: 2000 } as const;
const MAX_ENTRIES = 300_000;
const DECISIONS_KEPT_DAYS = 365;
const NOTES_HELD = 5;
const FOLLOWED_CALLS = 3;
const ADDRESS_CHARS = 500;
const COMMAND = /^\/[\w:-]+(\s|$)/;
const TELLING_MS = 30_000;
const KINDS: readonly EntryKind[] = ["owner", "prompt", "say", "shell", "change", "read", "tool", "mail"];

/** A found entry as a seat reads it: where it is, when, whose, and the words. */
function shown(found: Found, text: string) {
  return {
    address: addressOf(found.source.kind, found.source.ref, found.ordinal),
    kind: found.kind,
    at: found.source.startedAt,
    agent: found.source.agent,
    role: found.source.role,
    task: found.source.task,
    ...(found.exitCode !== null ? { exitCode: found.exitCode } : {}),
    text,
  };
}

/** The first number of the policy the district could not run with, by its name; null when all are in range. */
function outOfRange(policy: KnowledgePolicy): string | null {
  const whole = (value: unknown, least: number, most: number) =>
    Number.isInteger(value) && (value as number) >= least && (value as number) <= most;
  if (!whole(policy.keepDays, 1, 3650)) return "keepDays";
  if (policy.maxEntries !== undefined && !whole(policy.maxEntries, 1000, 100_000_000)) return "maxEntries";
  return null;
}

/** A whole number a seat gave, held to `most`; `fallback` when it gave none. */
const bounded = (value: unknown, fallback: number, most: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, most) : fallback;
};

/** What a seat asked in a search, checked: its phrasings, what narrows them, and how many hits it wants. */
function searchAsked(
  args: Record<string, unknown>,
  seen: readonly string[] | null,
): { phrases: string[]; filters: Filters; limit: number } {
  const phrases = [args.q, ...(Array.isArray(args.also) ? args.also.slice(0, SEARCH.phrases) : [])]
    .map((one) =>
      String(one ?? "")
        .slice(0, QUERY_CHARS)
        .normalize("NFC")
        .trim(),
    )
    .filter(Boolean);
  if (phrases.length === 0) throw new KnowledgeRefused("search: give the words to look for in `q`");
  const kinds = (Array.isArray(args.kinds) ? args.kinds : args.kind ? [args.kind] : []).map(String);
  const unknown = kinds.find((kind) => !KINDS.includes(kind as EntryKind));
  if (unknown) throw new KnowledgeRefused(`search: no entry kind ${unknown}; kinds are ${KINDS.join(", ")}`);
  const since = typeof args.since === "string" && args.since ? isoTime(args.since) : undefined;
  if (since === null)
    throw new KnowledgeRefused("search: `since` is an ISO date like 2026-10-01, or a time with its zone");
  const filters: Filters = {
    seen,
    ...(typeof args.task === "string" && args.task ? { task: args.task } : {}),
    ...(typeof args.agent === "string" && args.agent ? { agent: args.agent } : {}),
    ...(kinds.length ? { kinds: kinds as EntryKind[] } : {}),
    ...(since ? { since: since.toISOString() } : {}),
  };
  return { phrases, filters, limit: bounded(args.limit, SEARCH.limit, SEARCH.most) };
}

/** The district: turns and mail kept as a record seats search, decisions kept and told to the seats they bind. */
export class Knowledge {
  private readonly stores = new Map<string, KnowledgeStore>();
  private readonly started = new Map<string, string>();
  private readonly briefedSeats = new Set<string>();
  private refused: string | null = null;
  private readonly notes = new Map<string, { key: string; line: string }[]>();
  private readonly telling = new Map<string, number>();
  private readonly searched = new Map<string, { store: KnowledgeStore; id: number; hits: string[]; left: number }>();
  readonly decisions: DecisionBook;
  readonly gate: Gate;
  readonly pairs: PairBook;

  constructor(private readonly deps: KnowledgeDeps) {
    const judge = deps.judge ?? null;
    this.gate = new Gate({ judge, on: () => this.on && this.deps.policy()?.gate === true, log: deps.log });
    this.pairs = new PairBook({ judge, log: deps.log });
    this.decisions = new DecisionBook({
      book: () => this.storeOf(null),
      recordOf: (agent) => this.existing(deps.projectOf(agent)),
      isRoomSeat: deps.isRoomSeat,
      briefs: deps.briefs,
      ownedTask: deps.ownedTask,
      taskOf: deps.taskOf,
      projectOf: deps.projectOf,
      projects: deps.projects,
      rootOf: deps.rootOf,
      gate: this.gate,
      pairs: this.pairs,
      now: () => this.now(),
    });
  }

  /** Whether the district runs: the policy turns it on and its numbers are in range. */
  get on(): boolean {
    const policy = this.deps.policy();
    if (policy?.mode !== "on") return false;
    const bad = outOfRange(policy);
    if (bad && bad !== this.refused) this.deps.log(`knowledge: off, the policy's knowledge.${bad} is out of range`);
    this.refused = bad;
    return bad === null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private dirOf(root: string | null): string {
    return root ? join(root, PROJECT_DIR) : this.deps.roomDir;
  }

  /** The store of a project, or of the room's own seats for `null`, made on first use. */
  storeOf(root: string | null): KnowledgeStore {
    const dir = this.dirOf(root);
    let store = this.stores.get(dir);
    if (!store) this.stores.set(dir, (store = new KnowledgeStore(dir, this.deps.busyTimeoutMs, () => this.now())));
    return store;
  }

  /** The store of a project or of the room when it exists: reading never makes one. */
  private existing(root: string | null): KnowledgeStore | null {
    const dir = this.dirOf(root);
    return this.stores.has(dir) || existsSync(join(dir, "knowledge.db")) ? this.storeOf(root) : null;
  }

  /** A turn began: its start time is the time of the words that opened it. */
  turnStarted(agent: string): void {
    if (this.on) this.started.set(agent, this.now().toISOString());
  }

  /** The room started this seat with a brief of its own: its first prompt is not a person's words. */
  briefed(agent: string): void {
    if (this.on) this.briefedSeats.add(agent);
  }

  /** Keeps an ended turn once; a turn that cannot be kept is logged and passed over. */
  turnEnded(turn: EndedTurn): boolean {
    const startedAt = this.started.get(turn.agent) ?? this.now().toISOString();
    this.started.delete(turn.agent);
    const roomBriefed = this.briefedSeats.delete(turn.agent);
    if (!this.on) return false;
    const ref = turnRef(turn.agent, turn.turnId, turn.events, startedAt);
    let store: KnowledgeStore | null = null;
    let owner: SourceWords[] = [];
    try {
      store = this.storeOf(this.deps.projectOf(turn.agent));
      // a seat opened by another seat starts with that seat's brief, whatever the room remembers after a restart
      const briefed = roomBriefed || (turn.parentId !== null && !store.hasTurnOf(turn.agent));
      const entries = entriesOf(turn.events, briefed);
      // a command typed to the seat's program, like /compact, is no decision
      owner = entries
        .filter((entry) => entry.kind === "owner" && !COMMAND.test(entry.text))
        .map((entry) => ({ address: addressOf("turn", ref, entry.ordinal), saidAt: startedAt, text: entry.text }));
      const source: Source = {
        kind: "turn",
        ref,
        agent: turn.agent,
        role: turn.role,
        task: turn.task,
        startedAt,
        outcome: turn.outcome,
        audience: [turn.agent],
      };
      return store.add(source, entries);
    } catch (error) {
      this.deps.log(`knowledge: the turn ${ref} was not kept: ${(error as Error).message}`);
      return false;
    } finally {
      // the decisions recorded in the turn settle on its person's words, kept or not
      try {
        this.decisions.turnEnded(turn.agent, owner, startedAt);
      } catch (error) {
        this.deps.log(`knowledge: the decisions of ${ref} did not settle: ${(error as Error).message}`);
      }
      if (turn.events.some((event) => event.kind === "compaction"))
        try {
          this.decisions.compacted(turn.agent);
          this.retell(turn.agent, store);
        } catch (error) {
          this.deps.log(`knowledge: ${turn.agent} is not told again after its compaction: ${(error as Error).message}`);
        }
    }
  }

  /** The block of decisions a seat starting in `cwd` is given in its system prompt, held for its `launch`; null when there is none. */
  promptFor(cwd: string, launch: string): string | null {
    if (!this.on) return null;
    try {
      return this.decisions.promptFor(cwd, launch);
    } catch (error) {
      this.deps.log(`knowledge: no decisions for a new seat: ${(error as Error).message}`);
      return null;
    }
  }

  /** A new seat holds the decisions the prompt of its `launch` gave it; a store that fails costs the seat nothing but the mark. */
  opened(agent: string, launch: string | null): void {
    if (!this.on) return;
    try {
      this.decisions.opened(agent, launch);
    } catch (error) {
      this.deps.log(`knowledge: a new seat's decisions were not marked: ${(error as Error).message}`);
    }
  }

  /** What a seat should be told now, and the call that marks it told; one notice at a time, never in the way of the guard or the mail. */
  noticesFor(agent: string): { text: string; told(): void } | null {
    if (!this.on) return null;
    const now = this.now().getTime();
    // a notice already on its way is not made again until it is told, or until it is surely lost
    const since = this.telling.get(agent);
    if (since !== undefined && now - since < TELLING_MS) return null;
    try {
      const notices = this.decisions.notices(agent);
      const notes = [...(this.notes.get(agent) ?? [])];
      if (!notices && notes.length === 0) return null;
      this.telling.set(agent, now);
      return {
        text: [notices?.text, ...notes.map((note) => `[knowledge] ${note.line}`)].filter(Boolean).join("\n"),
        told: () => {
          this.telling.delete(agent);
          try {
            if (notices) this.decisions.delivered(agent, notices);
            // only what this notice held is told: a note made while it was on its way waits for the next
            const left = (this.notes.get(agent) ?? []).filter((note) => !notes.includes(note));
            if (left.length) this.notes.set(agent, left);
            else this.notes.delete(agent);
          } catch (error) {
            this.deps.log(`knowledge: what ${agent} was told was not marked: ${(error as Error).message}`);
          }
        },
      };
    } catch (error) {
      this.telling.delete(agent);
      this.deps.log(`knowledge: nothing could be told to ${agent}: ${(error as Error).message}`);
      return null;
    }
  }

  /** After a compaction, where the seat's brief is kept and the mail threads it is in wait to be told, once. */
  private retell(agent: string, store: KnowledgeStore | null): void {
    const brief = store?.briefOf(agent);
    if (brief)
      this.tell(agent, "compacted:brief", `Your brief stands, kept at ${brief}: seatwork_knowledge do=view reads it.`);
    const threads = this.deps.threadsOf(agent);
    if (threads.length)
      this.tell(agent, "compacted:threads", ["The mail threads you are in, newest first:", ...threads].join("\n"));
  }

  /** A line that waits for a seat's next notice; one with the same key is waiting already, so it waits once. */
  private tell(agent: string, key: string, line: string): void {
    const notes = this.notes.get(agent) ?? [];
    if (notes.some((note) => note.key === key)) return;
    notes.push({ key, line });
    // a seat that is never told keeps its newest notes, not every one
    this.notes.set(agent, notes.slice(-NOTES_HELD));
  }

  /** What goes out with a seat's mail: what it should be told, marked as the room's own words. */
  appendix(agent: string): { text: string; told(): void } | null {
    const notices = this.noticesFor(agent);
    // the room's own words are marked, so the record never reads them as a person's
    return notices ? { text: `<knowledge>\n${notices.text}\n</knowledge>`, told: notices.told } : null;
  }

  /** The minute's pass: mail read into the record, and decisions past their time closed. */
  tick(): void {
    if (!this.on) return;
    this.readMail();
    try {
      this.decisions.sweep();
    } catch (error) {
      this.deps.log(`knowledge: the decisions' pass failed: ${(error as Error).message}`);
    }
  }

  /** One call of the knowledge tool; `decide` and `withdraw` wait on the gate before they are kept, the rest are answered at once. */
  async act(agent: string, args: Record<string, unknown>): Promise<unknown> {
    if (args.do !== "decide" && args.do !== "withdraw") return this.recall(agent, args);
    if (!this.on) throw new KnowledgeRefused("the knowledge district is off in this room's policy");
    this.followed(agent, args);
    return this.withNotices(agent, await this.decisions.record(agent, args, args.do));
  }

  /** What a seat reads in its next few calls after a search is kept beside that search: the hits that served it. */
  private followed(agent: string, args: Record<string, unknown>): void {
    const last = this.searched.get(agent);
    if (!last) return;
    if ((last.left -= 1) <= 0) this.searched.delete(agent);
    if (args.do !== "view" && args.do !== "expand") return;
    const address = String(args.address ?? "");
    if (!address || address.length > ADDRESS_CHARS) return;
    try {
      const rank = last.hits.indexOf(address);
      last.store.opened(last.id, address, rank < 0 ? null : rank, args.do);
    } catch (error) {
      this.deps.log(`knowledge: what ${agent} opened after a search was not kept: ${(error as Error).message}`);
    }
  }

  /** Reads the mail posted since the last read into each store, a few batches per store. */
  readMail(): number {
    if (!this.on) return 0;
    let added = 0;
    for (const root of [null, ...this.deps.projects()])
      try {
        added += this.readMailOf(root);
      } catch (error) {
        this.deps.log(`knowledge: the mail of ${root ?? "the room"} was not read: ${(error as Error).message}`);
      }
    return added;
  }

  /** Reads the mail of one store from where its reader stopped, a few batches at most. */
  private readMailOf(root: string | null): number {
    let store = this.existing(root);
    let added = 0;
    for (let batch = 0; batch < MAIL.batches; batch += 1) {
      const last = store?.cursor("mail") ?? 0;
      const mails = this.deps.mailAfter(root, last, MAIL.batch);
      if (mails.length === 0) break;
      store ??= this.storeOf(root);
      added += store.addRead(
        "mail",
        mails[mails.length - 1].id,
        mails.map((mail) => ({
          source: {
            kind: "mail",
            ref: String(mail.id),
            agent: mail.sender,
            role: mail.senderRole,
            task: mail.thread,
            startedAt: mail.at,
            outcome: mail.signal,
            audience: [mail.sender, ...mail.to],
          },
          entries: [
            {
              ordinal: 0,
              kind: "mail",
              text: redact(`${mail.subject}\n\n${mail.body}`.slice(0, MAIL.chars).normalize("NFC")),
              exitCode: null,
            },
          ],
        })),
      );
      if (mails.length < MAIL.batch) break;
    }
    return added;
  }

  /** The store a seat reads: its project's, the room's for `room`, or another project named by folder or name. */
  private storeFor(agent: string, project: unknown): KnowledgeStore | null {
    const named = typeof project === "string" ? project.trim() : "";
    if (!named) return this.existing(this.deps.projectOf(agent));
    if (named === "room") return this.existing(null);
    const roots = this.deps.projects().filter((one) => one === named || basename(one) === named);
    if (roots.length > 1) throw new KnowledgeRefused(`more than one project is named ${named}: give its full path`);
    if (roots.length === 0) throw new KnowledgeRefused(`no project of the room is named ${named}`);
    return this.existing(roots[0]);
  }

  /** One read call of the knowledge tool, with what the seat should be told added to its answer. */
  recall(agent: string, args: Record<string, unknown>): unknown {
    if (!this.on) throw new KnowledgeRefused("the knowledge district is off in this room's policy");
    this.followed(agent, args);
    return this.withNotices(agent, this.answer(agent, args) as Record<string, unknown>);
  }

  /** An answer with what the seat should be told added, marked told. */
  private withNotices(agent: string, answer: Record<string, unknown>): Record<string, unknown> {
    const notices = this.noticesFor(agent);
    if (!notices) return answer;
    notices.told();
    return { ...answer, notices: notices.text.split("\n") };
  }

  /** The answer to one read call: `list`, `search`, `view`, `expand` or `pack`. */
  private answer(agent: string, args: Record<string, unknown>): unknown {
    const action = String(args.do ?? "");
    if (action === "list") return this.decisions.list(agent, args);
    const store = this.storeFor(agent, args.project);
    // a seat reads what it and the seats under it saw, as it reads mail; the store filters before any limit
    const seen = this.deps.seen(agent);
    switch (action) {
      case "search":
        return this.search(agent, store, args, seen);
      case "view":
      case "expand":
        return this.read(store, action, args, seen);
      case "pack": {
        const task = String(args.task ?? "").trim();
        if (!task) throw new KnowledgeRefused("pack: give the `task` whose evidence to pack");
        const budget = bounded(args.budget, PACK.default, PACK.most);
        return pack(task, store?.ofTask(task, PACK.pool, seen) ?? [], budget);
      }
      default:
        throw new KnowledgeRefused("`do` is search, view, expand, pack, decide, withdraw or list");
    }
  }

  /** A search by one or more phrasings, each tried for all its words and then for any, fused into one ranking. */
  private search(
    agent: string,
    store: KnowledgeStore | null,
    args: Record<string, unknown>,
    seen: readonly string[] | null,
  ) {
    const { phrases, filters, limit } = searchAsked(args, seen);
    const understood: { phrase: string; query: string | null; matched: "all" | "any" | "none"; newest?: true }[] = [];
    const lists: (Found & { snippet: string })[][] = [];
    for (const phrase of phrases) {
      const queries = ftsQueries(phrase);
      if (!queries || !store) {
        understood.push({ phrase, query: queries?.all ?? null, matched: "none" });
        continue;
      }
      let found = store.search(queries.all, filters, SEARCH.pool);
      let matched: "all" | "any" | "none" = "all";
      if (found.hits.length === 0 && queries.any !== queries.all) {
        found = store.search(queries.any, filters, SEARCH.pool);
        matched = "any";
      }
      if (found.hits.length === 0) matched = "none";
      const query = matched === "any" ? queries.any : queries.all;
      understood.push({ phrase, query, matched, ...(found.capped ? { newest: true as const } : {}) });
      lists.push(found.hits);
    }
    const found = fuse(lists, SEARCH.most).map((hit) => shown(hit, hit.snippet));
    if (store) this.logSearch(agent, store, understood, found, limit);
    const capped = understood.some((one) => one.newest);
    return {
      store: store ? "kept" : "none yet",
      understood,
      hits: found.slice(0, limit),
      ...(capped
        ? {
            note: "Some wordings match more entries than one search ranks: only the newest were read. Add a telling word.",
          }
        : {}),
    };
  }

  /** Keeps a search with every hit it ranked, so what the seat opens next tells which served it. */
  private logSearch(
    agent: string,
    store: KnowledgeStore,
    understood: readonly { phrase: string; matched: string }[],
    found: readonly { address: string }[],
    shown: number,
  ): void {
    try {
      const hits = found.map((hit) => hit.address);
      const id = store.logSearch({
        seat: agent,
        task: this.deps.taskOf(agent),
        phrases: understood.map((one) => redact(one.phrase)),
        matched: understood.map((one) => one.matched),
        hits,
        shown: Math.min(shown, hits.length),
      });
      this.searched.set(agent, { store, id, hits, left: FOLLOWED_CALLS });
    } catch (error) {
      this.deps.log(`knowledge: a search of ${agent} was not kept: ${(error as Error).message}`);
    }
  }

  /** The entries at an address and around it, or that they are gone. */
  private read(
    store: KnowledgeStore | null,
    action: "view" | "expand",
    args: Record<string, unknown>,
    seen: readonly string[] | null,
  ) {
    const address = String(args.address ?? "");
    const at = parseAddress(address);
    if (!at)
      throw new KnowledgeRefused(`${action}: give an \`address\` as a search returned it, like turn:<seat>:<turn>#3`);
    const around = action === "expand" ? bounded(args.around, AROUND.default, AROUND.most) : 0;
    const [from, to] = [at.ordinal - around, at.ordinal + around];
    const entries = store?.slice(at.kind, at.ref, from, to, seen) ?? [];
    if (entries.length === 0) {
      // entries cut from a long turn or past the store's size are gone for every reader, not hidden from this one
      if (seen && store?.slice(at.kind, at.ref, from, to).length)
        throw new KnowledgeRefused(`${action}: ${address} is not yours to read`);
      return { address, expired: true, entries: [] };
    }
    return { address, entries: entries.map((found) => shown(found, found.text)) };
  }

  /** Drops what is past the policy's days or size from every store of the room, a bounded part a pass; the GC calls it. */
  expire(): number {
    const policy = this.deps.policy();
    if (!policy || !this.on) return 0;
    const now = this.now().getTime();
    const before = new Date(now - policy.keepDays * 86_400_000);
    let gone = 0;
    // one store that fails is said and passed over: the others are still kept small
    for (const root of [null, ...this.deps.projects()])
      try {
        const store = this.existing(root);
        if (!store) continue;
        if (root === null) gone += store.expireDecisions(new Date(now - DECISIONS_KEPT_DAYS * 86_400_000));
        gone += store.expire(before, policy.maxEntries ?? MAX_ENTRIES);
        // a search lives as long as the entries it found
        gone += store.expireMeasures(before);
      } catch (error) {
        this.deps.log(`knowledge: the store of ${root ?? "the room"} was not expired: ${(error as Error).message}`);
      }
    return gone;
  }

  /** A runtime closed and took its turn with it: no end comes for the turn that started. */
  turnLost(agent: string): void {
    this.started.delete(agent);
  }

  /** An archived seat leaves nothing in the district's memory. */
  forget(agent: string): void {
    this.started.delete(agent);
    this.briefedSeats.delete(agent);
    this.notes.delete(agent);
    this.telling.delete(agent);
    this.searched.delete(agent);
    if (!this.on) return;
    try {
      this.decisions.forget(agent);
    } catch (error) {
      this.deps.log(`knowledge: ${agent} was not forgotten everywhere: ${(error as Error).message}`);
    }
  }

  /** Closes every store. */
  close(): void {
    this.searched.clear();
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
