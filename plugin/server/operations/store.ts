import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite, type SqliteFailure } from "../sqlite";

/** The operations store in the room home: the room's log, its incidents, the traces of their causes, and the changes made to its policy. */

/** A store that cannot be used: another process holds it, or its layout is newer or invalid; `code` says which. */
export class OperationsError extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Where an incident stands with the operator. */
export type IncidentState = "open" | "acknowledged" | "snoozed" | "resolved";

/** One kind of trouble the room met: how often, how often in the last hour, where it stands, what the decision model read it as, and when its operator was last told. */
export interface Incident {
  id: number;
  district: string;
  firstAt: string;
  lastAt: string;
  count: number;
  lastHour: number;
  line: string;
  state: IncidentState;
  note: string;
  back: boolean;
  kind: string | null;
  toldAt: string | null;
}

/** What one project's seats spent in a UTC day: dollars and turns that ended. */
export interface Sums {
  usd: number;
  turns: number;
}

/** A project the breaker holds for a UTC day, why, and whether it was told. */
export interface HoldRow {
  project: string;
  day: string;
  since: string;
  reason: string;
  told: boolean;
}

/** One change to the policy as the store keeps it; `before`, `after` and `baseline` are JSON, before and after null when the key was absent. */
export interface Tune {
  id: number;
  at: string;
  seat: string;
  path: string;
  before: string | null;
  after: string | null;
  reason: string;
  evidence: string;
  baseline: string;
  trace: number | null;
  reverts: number | null;
}

/** A search for a cause, with what it learned in order and how many changes made for it were undone. */
export interface Trace {
  id: number;
  incident: number | null;
  openedAt: string;
  seat: string;
  hypothesis: string;
  closedAt: string | null;
  conclusion: string | null;
  notes: { at: string; kind: TraceNoteKind; text: string }[];
  undone: number;
}

/** What a note of a trace holds: evidence found, a hypothesis set aside, a hypothesis taken up. */
export type TraceNoteKind = "evidence" | "eliminated" | "hypothesis";

const SLICE = 2000;
const NOTES_SHOWN = 12;
const SPEND_ROWS = 2000;
const INCIDENT = `i.id, i.district, i.first_at AS firstAt, i.last_at AS lastAt, i.count, i.line, i.state, i.note,
  i.back, i.kind, i.told_at AS toldAt, (SELECT count(*) FROM log WHERE log.incident = i.id AND log.at >= ?) AS lastHour`;
const TUNE = "id, at, seat, path, before, after, reason, evidence, baseline, trace, reverts";
const TRACE = `t.id, t.incident, t.opened_at AS openedAt, t.seat, t.hypothesis, t.closed_at AS closedAt, t.conclusion,
  (SELECT count(*) FROM tunes u WHERE u.trace = t.id AND EXISTS (SELECT 1 FROM tunes r WHERE r.reverts = u.id)) AS undone`;

/** An incident row as the district reads it. */
const toIncident = (row: Record<string, unknown>): Incident => ({
  ...(row as unknown as Incident),
  back: row.back === 1,
});

/** The operations store: log, incidents, traces and the record of changes. */
export class OperationsStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "operations"),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    super(join(dir, "operations.db"), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new OperationsError(code, message),
      name: "the operations store",
      now,
      reclaims: true,
    });
  }

  private hourAgo(): string {
    return new Date(this.now().getTime() - 3_600_000).toISOString();
  }

  /** Keeps a log line, and counts it under its incident key when it is one; a resolved incident seen again opens as back. `ask` false keeps a new incident from being put to the decision model. */
  record(district: string, line: string, key: string | null, ask = true): void {
    const at = this.now().toISOString();
    this.transaction("write", () => {
      const incident = key
        ? this.row<{ id: number }>(
            `INSERT INTO incidents (key, district, first_at, last_at, count, line, asked) VALUES (?, ?, ?, ?, 1, ?, ?)
               ON CONFLICT (key) DO UPDATE SET last_at = excluded.last_at, count = count + 1, line = excluded.line,
                 back = CASE WHEN state = 'resolved' THEN 1 ELSE back END,
                 told_at = CASE WHEN state = 'resolved' THEN NULL ELSE told_at END,
                 state = CASE WHEN state = 'resolved' THEN 'open' ELSE state END
               RETURNING id`,
            key,
            district,
            at,
            at,
            line,
            ask ? 0 : 1,
          )!.id
        : null;
      this.run("INSERT INTO log (at, district, line, incident) VALUES (?, ?, ?, ?)", at, district, line, incident);
    });
  }

  /** The newest log lines, newest first, of one district or all, since a time, holding some words. */
  lines(
    filters: { district?: string; since?: string; words?: string },
    limit: number,
  ): { at: string; district: string; line: string }[] {
    const words = filters.words ?? "";
    // one district reads its own index, newest first; all of them read the log newest first
    const where = filters.district ? "district = ? AND" : "";
    return this.rows<{ at: string; district: string; line: string }>(
      `SELECT at, district, line FROM log
         WHERE ${where} at >= ? AND (? = '' OR instr(lower(line), lower(?)) > 0) ORDER BY id DESC LIMIT ?`,
      ...(filters.district ? [filters.district] : []),
      filters.since ?? "",
      words,
      words,
      limit,
    ).map(({ at, district, line }) => ({ at, district, line }));
  }

  incident(id: number): Incident | null {
    const row = this.row<Record<string, unknown>>(
      `SELECT ${INCIDENT} FROM incidents i WHERE i.id = ?`,
      this.hourAgo(),
      id,
    );
    return row ? toIncident(row) : null;
  }

  /** Incidents seen since `since`, the most recent first. */
  incidents(since: string, limit: number): Incident[] {
    return this.rows<Record<string, unknown>>(
      `SELECT ${INCIDENT} FROM incidents i WHERE i.last_at >= ? ORDER BY i.last_at DESC LIMIT ?`,
      this.hourAgo(),
      since,
      limit,
    ).map(toIncident);
  }

  /** Incidents to tell now: open ones untold or seen more since an older telling, snoozed ones whose time is up, acknowledged ones twice as frequent. */
  untold(retoldBefore: string, limit: number): Incident[] {
    const at = this.now().toISOString();
    const hourAgo = this.hourAgo();
    return this.rows<Record<string, unknown>>(
      `SELECT ${INCIDENT} FROM incidents i
         WHERE (i.state = 'open' AND (i.told_at IS NULL OR (i.count > i.told_count AND i.told_at < ? AND i.last_at > i.told_at)))
           OR (i.state = 'snoozed' AND i.snoozed_until <= ? AND i.last_at > coalesce(i.told_at, ''))
           OR (i.state = 'acknowledged' AND coalesce(i.told_at, '') < ?
             AND (SELECT count(*) FROM log WHERE log.incident = i.id AND log.at >= ?) >= 2 * max(i.acked_rate, 1))
         ORDER BY i.last_at DESC LIMIT ?`,
      hourAgo,
      retoldBefore,
      at,
      retoldBefore,
      hourAgo,
      limit,
    ).map(toIncident);
  }

  /** The operator was told of these incidents at their present counts; one snoozed or acknowledged that was told again is open. */
  told(ids: readonly number[]): void {
    this.run(
      `UPDATE incidents SET told_at = ?, told_count = count,
         state = CASE WHEN state IN ('snoozed', 'acknowledged') THEN 'open' ELSE state END
         WHERE id IN (SELECT value FROM json_each(?))`,
      this.now().toISOString(),
      JSON.stringify(ids),
    );
  }

  /** Sets where an incident stands: acknowledged at its present rate, snoozed until a time, resolved with its cause, or open. */
  setState(id: number, state: IncidentState, note: string, snoozedUntil: string | null = null): boolean {
    return (
      this.run(
        `UPDATE incidents SET state = ?, note = ?, snoozed_until = ?, back = 0,
           acked_rate = (SELECT count(*) FROM log WHERE log.incident = incidents.id AND log.at >= ?)
           WHERE id = ?`,
        state,
        note,
        snoozedUntil,
        this.hourAgo(),
        id,
      ).changes > 0
    );
  }

  /** The oldest incidents not yet put to the decision model, to ask about in one call. */
  unasked(limit: number): { id: number; district: string; line: string; count: number }[] {
    return this.rows<{ id: number; district: string; line: string; count: number }>(
      "SELECT id, district, line, count FROM incidents WHERE asked = 0 ORDER BY id LIMIT ?",
      limit,
    ).map(({ id, district, line, count }) => ({ id, district, line, count }));
  }

  /** What the decision model read each incident as, null where it was not sure; each is asked no more. */
  setKinds(kinds: readonly (readonly [number, string | null])[]): void {
    this.transaction("write", () => {
      for (const [id, kind] of kinds) this.run("UPDATE incidents SET kind = ?, asked = 1 WHERE id = ?", kind, id);
    });
  }

  /** Keeps a change to the policy; its id is what a revert names. */
  addTune(tune: Omit<Tune, "id" | "at">): Tune {
    const { lastInsertRowid } = this.run(
      `INSERT INTO tunes (at, seat, path, before, after, reason, evidence, baseline, trace, reverts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.now().toISOString(),
      tune.seat,
      tune.path,
      tune.before,
      tune.after,
      tune.reason,
      tune.evidence,
      tune.baseline,
      tune.trace,
      tune.reverts,
    );
    return this.tune(lastInsertRowid)!;
  }

  tune(id: number): Tune | null {
    return this.row<Tune>(`SELECT ${TUNE} FROM tunes WHERE id = ?`, id) ?? null;
  }

  /** The newest changes to the policy, newest first. */
  tunes(limit: number): Tune[] {
    return this.rows<Tune>(`SELECT ${TUNE} FROM tunes ORDER BY id DESC LIMIT ?`, limit).map((row) => ({ ...row }));
  }

  /** Changes made since `since` that nothing undid yet, and that undo nothing: what the digest weighs against now. */
  standing(since: string): Tune[] {
    return this.rows<Tune>(
      `SELECT ${TUNE} FROM tunes t WHERE at >= ? AND reverts IS NULL
         AND NOT EXISTS (SELECT 1 FROM tunes r WHERE r.reverts = t.id) ORDER BY id`,
      since,
    ).map((row) => ({ ...row }));
  }

  /** The reverts of a key since `since`, newest first: what a change of it must answer. */
  revertsOf(path: string, since: string): Tune[] {
    return this.rows<Tune>(
      `SELECT ${TUNE} FROM tunes WHERE path = ? AND reverts IS NOT NULL AND at >= ? ORDER BY id DESC`,
      path,
      since,
    ).map((row) => ({ ...row }));
  }

  /** Opens a trace on an incident, or on none, with its first hypothesis. */
  openTrace(seat: string, incident: number | null, hypothesis: string): Trace {
    const { lastInsertRowid } = this.run(
      "INSERT INTO traces (incident, opened_at, seat, hypothesis) VALUES (?, ?, ?, ?)",
      incident,
      this.now().toISOString(),
      seat,
      hypothesis,
    );
    return this.trace(lastInsertRowid)!;
  }

  /** Adds what a trace learned; a hypothesis taken up becomes the trace's own. */
  addNote(trace: number, kind: TraceNoteKind, text: string): void {
    this.transaction("write", () => {
      this.run(
        "INSERT INTO trace_notes (trace, at, kind, text) VALUES (?, ?, ?, ?)",
        trace,
        this.now().toISOString(),
        kind,
        text,
      );
      if (kind === "hypothesis") this.run("UPDATE traces SET hypothesis = ? WHERE id = ?", text, trace);
    });
  }

  /** Ends a trace with what it found. */
  closeTrace(trace: number, conclusion: string): boolean {
    return (
      this.run(
        "UPDATE traces SET closed_at = ?, conclusion = ? WHERE id = ? AND closed_at IS NULL",
        this.now().toISOString(),
        conclusion,
        trace,
      ).changes > 0
    );
  }

  /** One trace with its newest notes, in order. */
  trace(id: number): Trace | null {
    const row = this.row<Omit<Trace, "notes">>(`SELECT ${TRACE} FROM traces t WHERE t.id = ?`, id);
    return row ? { ...row, notes: this.notesOf(id) } : null;
  }

  /** The traces still open, oldest first. */
  openTraces(): Trace[] {
    return this.rows<Omit<Trace, "notes">>(
      `SELECT ${TRACE} FROM traces t WHERE t.closed_at IS NULL ORDER BY t.opened_at`,
    ).map((row) => ({ ...row, notes: this.notesOf(row.id) }));
  }

  private notesOf(trace: number): Trace["notes"] {
    return this.rows<Trace["notes"][number]>(
      `SELECT at, kind, text FROM (SELECT id, at, kind, text FROM trace_notes WHERE trace = ? ORDER BY id DESC LIMIT ?)
         ORDER BY id`,
      trace,
      NOTES_SHOWN,
    ).map(({ at, kind, text }) => ({ at, kind, text }));
  }

  /** A seat is new: its next reading counts whole. */
  baseline(seat: string): void {
    this.run("INSERT OR IGNORE INTO spend_seats (seat, total, at) VALUES (?, 0, ?)", seat, this.now().toISOString());
  }

  /** A seat is gone: its last total is not kept. */
  dropSeat(seat: string): void {
    this.run("DELETE FROM spend_seats WHERE seat = ?", seat);
  }

  /** Adds a turn of a seat to a project's day, with the change in the seat's `total` since it was last read (none at its first reading, and a total that fell is a seat resumed); returns the day's sums. */
  spend(project: string, day: string, seat: string, total: number | null): Sums {
    return this.transaction("write", () => {
      let added = 0;
      if (total !== null) {
        const last = this.row<{ total: number }>("SELECT total FROM spend_seats WHERE seat = ?", seat)?.total;
        added = last === undefined ? 0 : total >= last ? total - last : total;
        this.run(
          `INSERT INTO spend_seats (seat, total, at) VALUES (?, ?, ?)
             ON CONFLICT (seat) DO UPDATE SET total = excluded.total, at = excluded.at`,
          seat,
          total,
          this.now().toISOString(),
        );
      }
      return this.row<Sums>(
        `INSERT INTO spend (project, day, usd, turns) VALUES (?, ?, ?, 1)
           ON CONFLICT (project, day) DO UPDATE SET usd = usd + excluded.usd, turns = turns + 1
           RETURNING usd, turns`,
        project,
        day,
        added,
      )!;
    });
  }

  /** What each project spent on a UTC day. */
  spendOn(day: string): (Sums & { project: string })[] {
    return this.rows<Sums & { project: string }>("SELECT project, usd, turns FROM spend WHERE day = ?", day).map(
      ({ project, usd, turns }) => ({ project, usd, turns }),
    );
  }

  /** What each project spent on each UTC day from `since` on. */
  spendFrom(since: string): (Sums & { project: string; day: string })[] {
    return this.rows<Sums & { project: string; day: string }>(
      "SELECT project, day, usd, turns FROM spend WHERE day >= ? LIMIT ?",
      since,
      SPEND_ROWS,
    ).map(({ project, day, usd, turns }) => ({ project, day, usd, turns }));
  }

  /** Whether any day of a project's spend is kept. */
  knowsProject(project: string): boolean {
    return this.row("SELECT 1 FROM spend WHERE project = ? LIMIT 1", project) !== undefined;
  }

  /** The projects held now, one row each. */
  holdRows(): HoldRow[] {
    return this.rows<Omit<HoldRow, "told"> & { told: number }>(
      "SELECT project, day, since, reason, told FROM holds",
    ).map(({ project, day, since, reason, told }) => ({ project, day, since, reason, told: told === 1 }));
  }

  /** Holds a project, not yet told. */
  addHold(hold: Omit<HoldRow, "told">): void {
    this.run(
      "INSERT OR REPLACE INTO holds (project, day, since, reason, told) VALUES (?, ?, ?, ?, 0)",
      hold.project,
      hold.day,
      hold.since,
      hold.reason,
    );
  }

  /** The hold of a project was told. */
  toldHold(project: string): void {
    this.run("UPDATE holds SET told = 1 WHERE project = ?", project);
  }

  /** A project is held no more. */
  dropHold(project: string): void {
    this.run("DELETE FROM holds WHERE project = ?", project);
  }

  /** Drops days of spend and holds before the UTC day `before`, and totals of seats not read since `seatsBefore`; how many rows went. */
  expireSpend(before: string, seatsBefore: string): number {
    return this.transaction(
      "write",
      () =>
        this.run("DELETE FROM spend WHERE day < ?", before).changes +
        this.run("DELETE FROM holds WHERE day < ?", before).changes +
        this.run("DELETE FROM spend_seats WHERE at < ?", seatsBefore).changes,
    );
  }

  /** Drops log lines past their days and the store's size, incidents not seen within the days, and old closed traces; in slices. The record of changes stays. */
  expire(before: Date, most: number, tracesBefore: Date): number {
    const cut = before.toISOString();
    let gone = this.sliced("DELETE FROM log WHERE id IN (SELECT id FROM log WHERE at < ? LIMIT ?)", cut);
    const newest = this.row<{ id: number | null }>("SELECT max(id) AS id FROM log")!.id ?? 0;
    // ids only grow: everything at or below the newest minus `most` is past the store's size
    gone += this.sliced("DELETE FROM log WHERE id IN (SELECT id FROM log WHERE id <= ? LIMIT ?)", newest - most);
    gone += this.sliced("DELETE FROM incidents WHERE id IN (SELECT id FROM incidents WHERE last_at < ? LIMIT ?)", cut);
    gone += this.sliced(
      "DELETE FROM traces WHERE id IN (SELECT id FROM traces WHERE closed_at < ? LIMIT ?)",
      tracesBefore.toISOString(),
    );
    this.reclaim(SLICE);
    return gone;
  }

  /** Runs a delete that ends in `LIMIT ?` until it removes fewer than a slice, each slice its own write. */
  private sliced(sql: string, ...params: (string | number)[]): number {
    let gone = 0;
    for (;;) {
      const done = this.transaction("write", () => this.run(sql, ...params, SLICE).changes);
      gone += done;
      if (done < SLICE) return gone;
    }
  }
}
