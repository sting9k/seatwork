import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { keptOutOfGit, Sqlite, type SqliteFailure } from "../sqlite";
import { addressOf, type Entry, type EntryKind, type SourceKind } from "./record";

/** One store of the Knowledge district: the record of a project, or of the room's own seats. */

export class KnowledgeError extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface Source {
  kind: SourceKind;
  ref: string;
  agent: string;
  role: string;
  task: string;
  thread: string;
  startedAt: string;
  endedAt: string;
  outcome: string;
  audience: readonly string[];
}

/** An entry found by a search or read by its address, with the source it belongs to. */
export interface Found {
  id: number;
  kind: EntryKind;
  ordinal: number;
  text: string;
  exitCode: number | null;
  source: Pick<Source, "kind" | "ref" | "agent" | "role" | "task" | "startedAt" | "outcome" | "audience">;
}

/** `seen`: the seats whose sources a reader may read, or null for all of them. */
export interface Filters {
  seen?: readonly string[] | null;
  task?: string;
  agent?: string;
  kinds?: readonly EntryKind[];
  since?: string;
}

export type DecisionState = "pending" | "active" | "applied" | "dropped" | "superseded" | "expired" | "withdrawn";

export interface Decision {
  id: number;
  action: "decide" | "withdraw";
  scopeKey: string;
  topic: string;
  statement: string;
  version: number;
  baseVersion: number;
  state: DecisionState;
  recordedBy: string;
  needsPerson: boolean;
  validFrom: string;
  validUntil: string | null;
  supersedes: number | null;
  supersededBy: number | null;
  reason: string;
  createdAt: string;
  closedAt: string | null;
}

export type NewDecision = Pick<
  Decision,
  | "action"
  | "scopeKey"
  | "topic"
  | "statement"
  | "baseVersion"
  | "recordedBy"
  | "needsPerson"
  | "validFrom"
  | "validUntil"
  | "reason"
>;

/** The person's words a decision rests on, as the record kept them. */
export interface SourceWords {
  address: string;
  saidAt: string;
  text: string;
}

/** What settling one decision did: made it the one in force, applied a withdrawal, or dropped it and why. */
export type Settled =
  | { state: "active"; decision: Decision; replaced: Decision | null }
  | { state: "applied"; decision: Decision; withdrawn: Decision; restored: Decision | null }
  | { state: "dropped"; decision: Decision; why: string };

/** A decision's columns as the district reads them, under a table alias. */
const decisionColumns = (alias: string) =>
  [
    "id",
    "action",
    "scope_key AS scopeKey",
    "topic",
    "statement",
    "version",
    "base_version AS baseVersion",
    "state",
    "recorded_by AS recordedBy",
    "needs_person AS needsPerson",
    "valid_from AS validFrom",
    "valid_until AS validUntil",
    "supersedes",
    "superseded_by AS supersededBy",
    "reason",
    "created_at AS createdAt",
    "closed_at AS closedAt",
  ]
    .map((column) => `${alias}.${column}`)
    .join(", ");
const DECISION = decisionColumns("decisions");

/** A decision row as the district reads it. */
function toDecision(row: Record<string, unknown>): Decision {
  return { ...(row as unknown as Decision), needsPerson: row.needsPerson === 1 };
}

export type PairChoice = "duplicate" | "replaces" | "independent";

/** A new decision beside an older one, as the measures keep it. */
export interface Pair {
  id: number;
  oldId: number;
  newText: string;
  oldText: string;
  seat: string;
  seatChoice: PairChoice | null;
  askId: number | null;
}

/** One search as the measures keep it. */
export interface SearchLog {
  seat: string;
  task: string;
  phrases: readonly string[];
  matched: readonly string[];
  hits: readonly string[];
  shown: number;
}

const SLICE = 2000;
const MERGE_PAGES = 500;
const RECLAIM_PAGES = 4000;
const ERRORS_KEPT = 200;
const SCANNED = 20_000;
const SEEN = `(? IS NULL OR EXISTS (SELECT 1 FROM json_each(?) j WHERE instr(',' || s.audience || ',', ',' || j.value || ',') > 0))`;
const BRIEFED = "('owner', 'prompt', 'mail')";
const FOUND = `e.id, e.kind, e.ordinal, e.text, e.exit_code AS exitCode,
  s.kind AS skind, s.ref, s.agent, s.role, s.task, s.started_at AS startedAt, s.outcome, s.audience`;

/** The two parameters of a reader's filter: whether it sees all, and the seats it sees. */
const seenParams = (seen: readonly string[] | null | undefined): [string | null, string | null] =>
  seen ? ["", JSON.stringify(seen)] : [null, null];

/** A joined row as an entry and its source. */
function toFound(row: Record<string, unknown>): Found {
  return {
    id: Number(row.id),
    kind: row.kind as EntryKind,
    ordinal: Number(row.ordinal),
    text: String(row.text),
    exitCode: row.exitCode === null ? null : Number(row.exitCode),
    source: {
      kind: row.skind as SourceKind,
      ref: String(row.ref),
      agent: String(row.agent),
      role: String(row.role),
      task: String(row.task),
      startedAt: String(row.startedAt),
      outcome: String(row.outcome),
      audience: String(row.audience).split(","),
    },
  };
}

export class KnowledgeStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "knowledge"),
  ) {
    super(join(keptOutOfGit(dir), "knowledge.db"), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new KnowledgeError(code, message),
      name: "the knowledge store",
      now,
      reclaims: true,
    });
  }

  /** Keeps one source and its entries once; false when the source was kept before, so nothing is written twice. */
  add(source: Source, entries: readonly Entry[]): boolean {
    return this.transaction("write", () => this.insert(source, entries));
  }

  private insert(source: Source, entries: readonly Entry[]): boolean {
    const added = this.run(
      `INSERT INTO sources (kind, ref, agent, role, task, thread, started_at, ended_at, outcome, audience)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, ref) DO NOTHING`,
      source.kind,
      source.ref,
      source.agent,
      source.role,
      source.task,
      source.thread,
      source.startedAt,
      source.endedAt,
      source.outcome,
      source.audience.join(","),
    );
    if (added.changes === 0) return false;
    for (const entry of entries)
      this.run(
        "INSERT INTO entries (source_id, ordinal, kind, text, exit_code) VALUES (?, ?, ?, ?, ?)",
        added.lastInsertRowid,
        entry.ordinal,
        entry.kind,
        entry.text,
        entry.exitCode,
      );
    return true;
  }

  /** Keeps several sources read from another store and moves that reader's place, all in one write. */
  addRead(name: string, last: number, read: readonly { source: Source; entries: readonly Entry[] }[]): number {
    return this.transaction("write", () => {
      let added = 0;
      for (const { source, entries } of read) if (this.insert(source, entries)) added += 1;
      this.run(
        "INSERT INTO cursors (name, last) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last = max(last, excluded.last)",
        name,
        last,
      );
      return added;
    });
  }

  /** Where the reader `name` stopped; 0 before its first read. */
  cursor(name: string): number {
    return this.row<{ last: number }>("SELECT last FROM cursors WHERE name = ?", name)?.last ?? 0;
  }

  /** Entries matching a full-text query, best first by BM25, within the filters; past `SCANNED` matches, the newest are read. */
  search(
    match: string,
    filters: Filters,
    limit: number,
  ): { hits: (Found & { snippet: string; rank: number })[]; capped: boolean } {
    // ranking scores every match: a query that matches most of the store ranks only its newest matches
    const newest = this.row<{ floor: number | null; n: number }>(
      "SELECT min(rowid) AS floor, count(*) AS n FROM (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rowid DESC LIMIT ?)",
      match,
      SCANNED,
    )!;
    const capped = newest.n === SCANNED;
    const kinds = filters.kinds?.length ? filters.kinds.join(",") : "";
    const ranked = this.rows<{ id: number; rank: number }>(
      `SELECT e.id AS id, bm25(entries_fts) AS rank
         FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid JOIN sources s ON s.id = e.source_id
         WHERE entries_fts MATCH ? AND entries_fts.rowid >= ?
           AND (? = '' OR s.task = ?) AND (? = '' OR s.agent = ?) AND (? = '' OR instr(',' || ? || ',', ',' || e.kind || ','))
           AND s.started_at >= ? AND ${SEEN}
         ORDER BY rank, e.id LIMIT ?`,
      match,
      capped ? newest.floor : 0,
      filters.task ?? "",
      filters.task ?? "",
      filters.agent ?? "",
      filters.agent ?? "",
      kinds,
      kinds,
      filters.since ?? "",
      ...seenParams(filters.seen),
      limit,
    );
    if (ranked.length === 0) return { hits: [], capped };
    const ids = JSON.stringify(ranked.map((one) => one.id));
    // what is shown is read for the hits alone, never for every match
    const found = new Map(
      this.rows<Record<string, unknown>>(
        `SELECT ${FOUND} FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id IN (SELECT value FROM json_each(?))`,
        ids,
      ).map((row) => [Number(row.id), toFound(row)]),
    );
    const snippets = new Map(
      this.rows<{ id: number; snippet: string }>(
        "SELECT rowid AS id, snippet(entries_fts, 0, '[', ']', '…', 24) AS snippet FROM entries_fts WHERE entries_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))",
        match,
        ids,
      ).map((row) => [Number(row.id), String(row.snippet)]),
    );
    return {
      hits: ranked.flatMap(({ id, rank }) => {
        const one = found.get(Number(id));
        return one ? [{ ...one, snippet: snippets.get(one.id) ?? one.text.slice(0, 200), rank: Number(rank) }] : [];
      }),
      capped,
    };
  }

  /** The entries of one source from `from` to `to` in its order that the reader may see; empty when none are kept. */
  slice(kind: SourceKind, ref: string, from: number, to: number, seen: readonly string[] | null = null): Found[] {
    return this.rows<Record<string, unknown>>(
      `SELECT ${FOUND} FROM sources s CROSS JOIN entries e ON e.source_id = s.id
         WHERE s.kind = ? AND s.ref = ? AND e.ordinal BETWEEN ? AND ? AND ${SEEN} ORDER BY e.ordinal`,
      kind,
      ref,
      from,
      to,
      ...seenParams(seen),
    ).map(toFound);
  }

  /** The address of the brief a seat started on, when its first turn kept here holds one. */
  briefOf(agent: string): string | null {
    const row = this.row<{ ref: string; ordinal: number }>(
      `SELECT s.ref AS ref, e.ordinal AS ordinal FROM sources s JOIN entries e ON e.source_id = s.id
         WHERE s.id = (SELECT id FROM sources WHERE agent = ? AND kind = 'turn' ORDER BY started_at LIMIT 1)
           AND e.kind = 'prompt'
         ORDER BY e.ordinal LIMIT 1`,
      agent,
    );
    return row ? addressOf("turn", row.ref, row.ordinal) : null;
  }

  /** Whether a seat has a turn kept here: a seat opened by another seat with none yet is on its brief. */
  hasTurnOf(agent: string): boolean {
    return !!this.row("SELECT 1 AS kept FROM sources WHERE agent = ? AND kind = 'turn' LIMIT 1", agent);
  }

  /** The refs of a seat's newest turns, newest first. */
  recentTurns(agent: string, count: number): string[] {
    return this.rows<{ ref: string }>(
      "SELECT ref FROM sources WHERE agent = ? AND kind = 'turn' ORDER BY started_at DESC LIMIT ?",
      agent,
      count,
    ).map((row) => row.ref);
  }

  /** A task's entries the reader may see, at most `limit`: a person's words, briefs and mail first, then the newest of the rest. */
  ofTask(task: string, limit: number, seen: readonly string[] | null = null): Found[] {
    // on a long task the newest entries alone would leave out the brief and the words it started on
    const read = (kinds: "IN" | "NOT IN", most: number) =>
      this.rows<Record<string, unknown>>(
        `SELECT ${FOUND} FROM sources s CROSS JOIN entries e ON e.source_id = s.id
           WHERE s.task = ? AND e.kind ${kinds} ${BRIEFED} AND ${SEEN} ORDER BY s.started_at DESC, s.id DESC, e.ordinal LIMIT ?`,
        task,
        ...seenParams(seen),
        most,
      ).map(toFound);
    const first = read("IN", limit);
    return first.length < limit ? [...first, ...read("NOT IN", limit - first.length)] : first;
  }

  /** One decision by its id. */
  decision(id: number): Decision | null {
    const row = this.row<Record<string, unknown>>(`SELECT ${DECISION} FROM decisions WHERE id = ?`, id);
    return row ? toDecision(row) : null;
  }

  /** The decision in force on a topic of a scope. */
  inForce(scopeKey: string, topic: string): Decision | null {
    const row = this.row<Record<string, unknown>>(
      `SELECT ${DECISION} FROM decisions WHERE scope_key = ? AND topic = ? AND state = 'active'`,
      scopeKey,
      topic,
    );
    return row ? toDecision(row) : null;
  }

  /** The decisions in force in any of these scopes, newest first. */
  activeIn(scopeKeys: readonly string[]): Decision[] {
    return this.rows<Record<string, unknown>>(
      `SELECT ${DECISION} FROM decisions
         WHERE state = 'active' AND scope_key IN (SELECT value FROM json_each(?)) ORDER BY valid_from DESC, id DESC`,
      JSON.stringify(scopeKeys),
    ).map(toDecision);
  }

  /** Decisions in force in a scope on other topics that share a word with `words`: the ones a new topic may repeat. */
  nearby(scopeKey: string, words: string, topic: string, limit: number): Decision[] {
    return this.rows<Record<string, unknown>>(
      `SELECT ${decisionColumns("d")} FROM decisions_fts JOIN decisions d ON d.id = decisions_fts.rowid
         WHERE decisions_fts MATCH ? AND d.state = 'active' AND d.scope_key = ? AND d.topic <> ?
         ORDER BY bm25(decisions_fts), d.id LIMIT ?`,
      words,
      scopeKey,
      topic,
      limit,
    ).map(toDecision);
  }

  /** Keeps a decision waiting for its turn to end, at version 0 until it is settled. */
  addDecision(decision: NewDecision): Decision {
    const at = this.now().toISOString();
    const { lastInsertRowid } = this.run(
      `INSERT INTO decisions (action, scope_key, topic, statement, version, base_version, state, recorded_by, needs_person,
         valid_from, valid_until, reason, created_at) VALUES (?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      decision.action,
      decision.scopeKey,
      decision.topic,
      decision.statement,
      decision.baseVersion,
      decision.recordedBy,
      decision.needsPerson ? 1 : 0,
      decision.validFrom,
      decision.validUntil,
      decision.reason,
      at,
    );
    return this.decision(lastInsertRowid)!;
  }

  /** The decisions a seat recorded that still wait for their source, oldest first. */
  pendingOf(agent: string): Decision[] {
    return this.rows<Record<string, unknown>>(
      `SELECT ${DECISION} FROM decisions WHERE recorded_by = ? AND state = 'pending' ORDER BY created_at, id`,
      agent,
    ).map(toDecision);
  }

  /** How many decisions are in force in a scope. */
  countActive(scopeKey: string): number {
    return this.row<{ n: number }>(
      "SELECT count(*) AS n FROM decisions WHERE state = 'active' AND scope_key = ?",
      scopeKey,
    )!.n;
  }

  /** Drops every decision a seat left pending, with the reason. */
  dropPendingOf(agent: string, why: string): number {
    return this.run(
      "UPDATE decisions SET state = 'dropped', reason = ?, closed_at = ? WHERE recorded_by = ? AND state = 'pending'",
      why,
      this.now().toISOString(),
      agent,
    ).changes;
  }

  /** Pending decisions older than `before`, whatever seat recorded them. */
  stalePending(before: string): Decision[] {
    return this.rows<Record<string, unknown>>(
      `SELECT ${DECISION} FROM decisions WHERE state = 'pending' AND created_at < ? ORDER BY id`,
      before,
    ).map(toDecision);
  }

  /** Whether a person's words already carry a decision: one source, one decision. */
  sourceUsed(address: string): boolean {
    return !!this.row("SELECT 1 AS used FROM decision_sources WHERE address = ?", address);
  }

  /** Makes a pending decision the one in force, or applies a withdrawal, in one write; a base that moved drops it. */
  settle(id: number, source: SourceWords | null): Settled {
    const at = this.now().toISOString();
    return this.transaction("write", () => {
      const pending = this.decision(id)!;
      const current = this.inForce(pending.scopeKey, pending.topic);
      const drop = (why: string): Settled => {
        this.run("UPDATE decisions SET state = 'dropped', reason = ?, closed_at = ? WHERE id = ?", why, at, id);
        return { state: "dropped", decision: this.decision(id)!, why };
      };
      if ((current?.version ?? 0) !== pending.baseVersion)
        return drop(
          `the topic changed to version ${current?.version ?? 0} after this was asked against version ${pending.baseVersion}`,
        );
      if (source)
        this.run(
          "INSERT INTO decision_sources (decision_id, address, said_at, text) VALUES (?, ?, ?, ?)",
          id,
          source.address,
          source.saidAt,
          source.text,
        );
      if (pending.action === "withdraw") {
        if (!current) return drop("no decision is in force on this topic");
        this.run(
          "UPDATE decisions SET state = 'withdrawn', superseded_by = ?, closed_at = ? WHERE id = ?",
          id,
          at,
          current.id,
        );
        this.run(
          "UPDATE decisions SET state = 'applied', version = ?, closed_at = ? WHERE id = ?",
          current.version,
          at,
          id,
        );
        const restored = this.restore(current, at);
        return { state: "applied", decision: this.decision(id)!, withdrawn: this.decision(current.id)!, restored };
      }
      if (current)
        this.run(
          "UPDATE decisions SET state = 'superseded', superseded_by = ?, closed_at = ? WHERE id = ?",
          id,
          at,
          current.id,
        );
      this.run(
        "UPDATE decisions SET state = 'active', version = ?, supersedes = ? WHERE id = ?",
        (current?.version ?? 0) + 1,
        current?.id ?? null,
        id,
      );
      return { state: "active", decision: this.decision(id)!, replaced: current };
    });
  }

  /** Gives a topic back to the decision `ended` had replaced, when that one is still in date. */
  private restore(ended: Decision, at: string): Decision | null {
    const before = ended.supersedes === null ? null : this.decision(ended.supersedes);
    if (!before || before.state !== "superseded" || (before.validUntil !== null && before.validUntil <= at))
      return null;
    this.run("UPDATE decisions SET state = 'active', superseded_by = NULL, closed_at = NULL WHERE id = ?", before.id);
    return this.decision(before.id);
  }

  /** Drops a pending decision with the reason. */
  dropPending(id: number, why: string): Decision {
    this.run(
      "UPDATE decisions SET state = 'dropped', reason = ?, closed_at = ? WHERE id = ? AND state = 'pending'",
      why,
      this.now().toISOString(),
      id,
    );
    return this.decision(id)!;
  }

  /** Ends the decisions whose date has passed, each giving its topic back to the one it replaced. */
  expireDue(): { ended: Decision; restored: Decision | null }[] {
    const at = this.now().toISOString();
    const due = this.rows<Record<string, unknown>>(
      `SELECT ${DECISION} FROM decisions WHERE state = 'active' AND valid_until IS NOT NULL AND valid_until <= ? LIMIT 200`,
      at,
    ).map(toDecision);
    return due.map((ended) =>
      this.transaction("write", () => {
        this.run("UPDATE decisions SET state = 'expired', closed_at = ? WHERE id = ?", at, ended.id);
        return { ended: this.decision(ended.id)!, restored: this.restore(ended, at) };
      }),
    );
  }

  /** What a seat was shown, by note, with the id of what it saw. */
  shownTo(seat: string): Map<string, number> {
    return new Map(
      this.rows<{ note: string; shown: number }>("SELECT note, shown FROM shown WHERE seat = ?", seat).map((row) => [
        row.note,
        row.shown,
      ]),
    );
  }

  /** Notes a seat has now seen, each with the id of what it saw; an id of 0 means the note is gone and is forgotten. */
  markShown(seat: string, seen: readonly { note: string; version: number }[]): void {
    const at = this.now().toISOString();
    this.transaction("write", () => {
      for (const { note, version } of seen)
        if (version === 0) this.run("DELETE FROM shown WHERE seat = ? AND note = ?", seat, note);
        else
          this.run(
            `INSERT INTO shown (seat, note, shown, at) VALUES (?, ?, ?, ?)
               ON CONFLICT (seat, note) DO UPDATE SET shown = excluded.shown, at = excluded.at`,
            seat,
            note,
            version,
            at,
          );
    });
  }

  /** A seat that is gone was shown nothing anymore. */
  forgetShown(seat: string): void {
    this.run("DELETE FROM shown WHERE seat = ?", seat);
  }

  /** Counts one more of `name` today. */
  tally(name: string): void {
    this.run(
      "INSERT INTO tallies (day, name, n) VALUES (?, ?, 1) ON CONFLICT (day, name) DO UPDATE SET n = n + 1",
      this.now().toISOString().slice(0, 10),
      name,
    );
  }

  /** The day counts since `since`, summed by name. */
  tallies(since: string): Record<string, number> {
    return Object.fromEntries(
      this.rows<{ name: string; n: number }>(
        "SELECT name, sum(n) AS n FROM tallies WHERE day >= ? GROUP BY name ORDER BY name",
        since.slice(0, 10),
      ).map((row) => [row.name, row.n]),
    );
  }

  /** Drops decisions closed before `before`, their sources with them, in slices; one that may still come back stays. */
  expireDecisions(before: Date): number {
    // a replaced decision in date comes back when the one above it ends, so it stays while that one can end
    return this.sliced(
      `DELETE FROM decisions WHERE id IN (
         SELECT d.id FROM decisions d WHERE d.closed_at < ?
           AND NOT (d.state = 'superseded' AND (d.valid_until IS NULL OR d.valid_until > ?)
             AND EXISTS (SELECT 1 FROM decisions up WHERE up.id = d.superseded_by AND up.state IN ('active', 'superseded')))
         LIMIT ?)`,
      before.toISOString(),
      this.now().toISOString(),
    );
  }

  /** Keeps one search; its id follows what the seat opens next. */
  logSearch(search: SearchLog): number {
    return this.run(
      "INSERT INTO searches (at, seat, task, phrases, matched, hits, shown) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.now().toISOString(),
      search.seat,
      search.task,
      JSON.stringify(search.phrases),
      JSON.stringify(search.matched),
      JSON.stringify(search.hits),
      search.shown,
    ).lastInsertRowid;
  }

  /** An address a seat read after a search, with its place among the hits; the first reading counts. */
  opened(searchId: number, address: string, rank: number | null, how: "view" | "expand"): void {
    this.run(
      `INSERT INTO search_opens (search_id, address, rank, how, at) SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM searches WHERE id = ?) ON CONFLICT DO NOTHING`,
      searchId,
      address,
      rank,
      how,
      this.now().toISOString(),
      searchId,
    );
  }

  /** Keeps pairs of a new decision with older ones; a seat's later word on a pair replaces its earlier one. */
  addPairs(
    newId: number,
    newText: string,
    seat: string,
    olds: readonly { id: number; text: string; choice: PairChoice | null }[],
  ): void {
    const at = this.now().toISOString();
    this.transaction("write", () => {
      for (const old of olds)
        this.run(
          `INSERT INTO pairs (new_id, old_id, new_text, old_text, seat, at, seat_choice) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (new_id, old_id) DO UPDATE SET
               labelled = CASE WHEN excluded.seat_choice IS NOT NULL AND excluded.seat_choice IS NOT seat_choice THEN 0 ELSE labelled END,
               seat = CASE WHEN excluded.seat_choice IS NOT NULL THEN excluded.seat ELSE seat END,
               seat_choice = coalesce(excluded.seat_choice, seat_choice)`,
          newId,
          old.id,
          newText,
          old.text,
          seat,
          at,
          old.choice,
        );
    });
  }

  /** The pairs of a new decision. */
  pairsOf(newId: number): Pair[] {
    return this.rows<Pair>(
      `SELECT id, old_id AS oldId, new_text AS newText, old_text AS oldText, seat, seat_choice AS seatChoice, ask_id AS askId
         FROM pairs WHERE new_id = ? ORDER BY old_id`,
      newId,
    ).map((row) => ({ ...row }));
  }

  /** The decision model's reading of pairs, each with the id its log answered under. */
  judged(
    found: readonly { id: number; choice: PairChoice; probabilities: Record<string, number>; askId: number }[],
  ): void {
    this.transaction("write", () => {
      for (const one of found)
        this.run(
          "UPDATE pairs SET jev_choice = ?, jev_probabilities = ?, ask_id = ? WHERE id = ?",
          one.choice,
          JSON.stringify(one.probabilities),
          one.askId,
          one.id,
        );
    });
  }

  /** Pairs of a new decision with the seat's word and the model's answer whose label the model's log has not had. */
  unlabelled(newId: number): { id: number; askId: number; seat: string; seatChoice: PairChoice }[] {
    return this.rows<{ id: number; askId: number; seat: string; seatChoice: PairChoice }>(
      `SELECT id, ask_id AS askId, seat, seat_choice AS seatChoice FROM pairs
         WHERE new_id = ? AND seat_choice IS NOT NULL AND ask_id IS NOT NULL AND labelled = 0`,
      newId,
    ).map((row) => ({ ...row }));
  }

  /** The model's log has these pairs' labels. */
  labelled(ids: readonly number[]): void {
    this.run("UPDATE pairs SET labelled = 1 WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
  }

  /** Drops searches, what was opened after them going too, pairs and day counts from before `before`. */
  expireMeasures(before: Date): number {
    const cut = before.toISOString();
    this.run("DELETE FROM tallies WHERE day < ?", cut.slice(0, 10));
    return (
      this.sliced("DELETE FROM searches WHERE id IN (SELECT id FROM searches WHERE at < ? LIMIT ?)", cut) +
      this.sliced("DELETE FROM pairs WHERE id IN (SELECT id FROM pairs WHERE at < ? LIMIT ?)", cut)
    );
  }

  /** A source that could not be kept, so the next one is not held back; only the newest few are kept. */
  failed(ref: string, error: string): void {
    this.transaction("write", () => {
      const { lastInsertRowid } = this.run(
        "INSERT INTO ingest_errors (at, ref, error) VALUES (?, ?, ?)",
        this.now().toISOString(),
        ref,
        error.slice(0, 500),
      );
      this.run("DELETE FROM ingest_errors WHERE id <= ?", lastInsertRowid - ERRORS_KEPT);
    });
  }

  /** Drops entries before `before`, then the oldest past `maxEntries`, and the sources left empty; in slices. */
  expire(before: Date, maxEntries = Infinity): number {
    const cut = before.toISOString();
    let gone = this.dropEntries(
      "SELECT e.id FROM sources s CROSS JOIN entries e ON e.source_id = s.id WHERE s.started_at < ? LIMIT ?",
      cut,
    );
    // past its size the store gives up its oldest entries, a slice at a time, never more than it is over
    for (let over = this.row<{ n: number }>("SELECT count(*) AS n FROM entries")!.n - maxEntries; over > 0;) {
      const done = this.transaction(
        "write",
        () =>
          this.run(
            `DELETE FROM entries WHERE id IN (SELECT e.id FROM sources s CROSS JOIN entries e ON e.source_id = s.id
               ORDER BY s.started_at, s.id, e.ordinal LIMIT ?)`,
            Math.min(SLICE, over),
          ).changes,
      );
      if (done === 0) break;
      over -= done;
      gone += done;
    }
    this.sliced(
      `DELETE FROM sources WHERE id IN (
         SELECT s.id FROM sources s WHERE s.started_at < ?
           AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.source_id = s.id) LIMIT ?)`,
      cut,
    );
    // deleted rows leave marks in the full-text index until its segments merge: a bounded merge
    if (gone > 0) this.run("INSERT INTO entries_fts (entries_fts, rank) VALUES ('merge', ?)", MERGE_PAGES);
    // freed pages go back a bounded run at a time, every pass, until none are left
    this.reclaim(RECLAIM_PAGES);
    return gone;
  }

  /** Deletes the entries a query names, `SLICE` at a time; the query takes its own parameters, then the slice size. */
  private dropEntries(select: string, ...params: string[]): number {
    return this.sliced(`DELETE FROM entries WHERE id IN (${select})`, ...params);
  }

  /** Runs a delete that ends in `LIMIT ?` until it removes fewer than a slice, each slice its own write. */
  private sliced(sql: string, ...params: string[]): number {
    let gone = 0;
    for (;;) {
      const done = this.transaction("write", () => this.run(sql, ...params, SLICE).changes);
      gone += done;
      if (done < SLICE) return gone;
    }
  }
}
