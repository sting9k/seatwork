import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite } from "../sqlite";

/** The operations store in the room home: the room's log, its incidents, the traces of their causes, the changes made to its policy, and what each project spends with the holds on it and the skills seats load. */

/** Where an incident stands with the operator. */
export type IncidentState = "open" | "acknowledged" | "snoozed" | "resolved";

/** One kind of trouble the room met, `lastHour` of its `count` in the last hour; `kind` is what the decision model read it as (null where unsure), `toldAt` null until its operator is told. */
export interface Incident {
  id: number;
  district: string;
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
const INCIDENT = `i.id, i.district, i.last_at AS lastAt, i.count, i.line, i.state, i.note,
  i.back, i.kind, i.told_at AS toldAt, (SELECT count(*) FROM log WHERE log.incident = i.id AND log.at >= ?) AS lastHour`;
const TUNE = "id, at, seat, path, before, after, reason, evidence, baseline, trace, reverts";
const TRACE = `t.id, t.incident, t.hypothesis, t.closed_at AS closedAt, t.conclusion,
  (SELECT count(*) FROM tunes u WHERE u.trace = t.id AND EXISTS (SELECT 1 FROM tunes r WHERE r.reverts = u.id)) AS undone`;

/** An incident row as the district reads it. */
const toIncident = (row: Record<string, unknown>): Incident => ({
  ...(row as unknown as Incident),
  back: row.back === 1,
});

/** The operations store; its deletes run in slices, each its own write, so none holds the write lock long. */
export class OperationsStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    super(join(dir, "operations.db"), {
      busyTimeoutMs,
      scripts: join(SQL_DIR, "operations"),
      name: "the operations store",
      now,
      reclaims: true,
    });
  }

  private hourAgo(): string {
    return new Date(this.now().getTime() - 3_600_000).toISOString();
  }

  /** Keeps a log line, counted under its incident `key` when it has one; a resolved incident seen again opens as back; `ask` false keeps the decision model from reading it. */
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
    );
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
    return this.rows<Tune>(`SELECT ${TUNE} FROM tunes ORDER BY id DESC LIMIT ?`, limit);
  }

  /** Changes made since `since` that nothing undid yet, and that undo nothing: what the digest weighs against now. */
  standing(since: string): Tune[] {
    return this.rows<Tune>(
      `SELECT ${TUNE} FROM tunes t INDEXED BY tunes_by_at WHERE at >= ? AND reverts IS NULL
         AND NOT EXISTS (SELECT 1 FROM tunes r WHERE r.reverts = t.id) ORDER BY id`,
      since,
    );
  }

  /** The reverts of a key since `since`, newest first: what a change of it must answer. */
  revertsOf(path: string, since: string): Tune[] {
    return this.rows<Tune>(
      `SELECT ${TUNE} FROM tunes WHERE path = ? AND reverts IS NOT NULL AND at >= ? ORDER BY id DESC`,
      path,
      since,
    );
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

  /** Closes, with `conclusion`, the open traces that no note and no change touched since `before`; how many were closed. */
  closeIdleTraces(before: Date, conclusion: string): number {
    const cut = before.toISOString();
    return this.deleteInSlices(
      `UPDATE traces SET closed_at = ?, conclusion = ? WHERE id IN (
         SELECT t.id FROM traces t WHERE t.closed_at IS NULL AND t.opened_at < ?
           AND coalesce((SELECT at FROM trace_notes WHERE trace = t.id ORDER BY id DESC LIMIT 1), '') < ?
           AND coalesce((SELECT at FROM tunes WHERE trace = t.id ORDER BY id DESC LIMIT 1), '') < ? LIMIT ?)`,
      [this.now().toISOString(), conclusion, cut, cut, cut],
    );
  }

  /** One trace with its newest notes, in order. */
  trace(id: number): Trace | null {
    const row = this.row<Omit<Trace, "notes">>(`SELECT ${TRACE} FROM traces t WHERE t.id = ?`, id);
    return row ? { ...row, notes: this.notesOf(id) } : null;
  }

  /** The traces still open, oldest first, each with its newest notes from one read of them all; the CROSS JOIN keeps the traces the outer loop, so each one's newest notes are found by the index. */
  openTraces(): Trace[] {
    const traces = this.rows<Omit<Trace, "notes">>(
      `SELECT ${TRACE} FROM traces t WHERE t.closed_at IS NULL ORDER BY t.opened_at`,
    );
    const notes = this.rows<Trace["notes"][number] & { trace: number }>(
      `SELECT n.trace, n.at, n.kind, n.text FROM traces t CROSS JOIN trace_notes n ON n.trace = t.id
         AND n.id >= coalesce((SELECT id FROM trace_notes WHERE trace = t.id ORDER BY id DESC LIMIT 1 OFFSET ?), 0)
         WHERE t.closed_at IS NULL ORDER BY n.trace, n.id`,
      NOTES_SHOWN - 1,
    );
    const byTrace = new Map<number, Trace["notes"]>();
    for (const { trace, at, kind, text } of notes) {
      const kept = byTrace.get(trace) ?? [];
      kept.push({ at, kind, text });
      byTrace.set(trace, kept);
    }
    return traces.map((row) => ({ ...row, notes: byTrace.get(row.id) ?? [] }));
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

  /** Counts a turn for a project's day and a `role`, costing the change in the seat's `total` since it was last read (nothing at a first reading; a fallen total is a seat resumed); returns the day's sums. */
  spend(project: string, day: string, seat: string, total: number | null, role?: string, outTokens?: number): Sums {
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
      if (role)
        this.run(
          `INSERT INTO spend_roles (project, day, role, usd, turns, out_tokens) VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT (project, day, role) DO UPDATE SET usd = usd + excluded.usd, turns = turns + 1,
               out_tokens = out_tokens + excluded.out_tokens`,
          project,
          day,
          role,
          added,
          Math.max(0, Math.round(outTokens ?? 0)),
        );
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
    return this.rows<Sums & { project: string }>("SELECT project, usd, turns FROM spend WHERE day = ?", day);
  }

  /** What each project spent on each UTC day from `since` on, the newest days first and `SPEND_ROWS` rows at most; `leftOut` counts the older rows past them. */
  spendFrom(since: string): { rows: (Sums & { project: string; day: string })[]; leftOut: number } {
    const rows = this.rows<Sums & { project: string; day: string }>(
      "SELECT project, day, usd, turns FROM spend WHERE day >= ? ORDER BY day DESC, project DESC LIMIT ?",
      since,
      SPEND_ROWS + 1,
    );
    if (rows.length <= SPEND_ROWS) return { rows, leftOut: 0 };
    const total = this.row<{ n: number }>("SELECT count(*) AS n FROM spend WHERE day >= ?", since)!.n;
    return { rows: rows.slice(0, SPEND_ROWS), leftOut: total - SPEND_ROWS };
  }

  /** What each role's seats spent in each project on one UTC day. */
  spendByRole(
    day: string,
    projects: readonly string[],
  ): (Sums & { project: string; role: string; outTokens: number })[] {
    if (projects.length === 0) return [];
    return this.rows<Sums & { project: string; role: string; outTokens: number }>(
      `SELECT project, role, usd, turns, out_tokens AS outTokens FROM spend_roles WHERE day = ? AND project IN (${projects.map(() => "?").join(", ")})`,
      day,
      ...projects,
    );
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

  /** Drops days of spend, holds and skill loads before the UTC day `before`, and totals of seats not read since `seatsBefore`; how many rows went. */
  expireSpend(before: string, seatsBefore: string): number {
    return this.transaction(
      "write",
      () =>
        this.run("DELETE FROM spend WHERE day < ?", before).changes +
        this.run("DELETE FROM spend_roles WHERE day < ?", before).changes +
        this.run("DELETE FROM holds WHERE day < ?", before).changes +
        this.run("DELETE FROM spend_seats WHERE at < ?", seatsBefore).changes +
        this.run("DELETE FROM skill_loads WHERE day < ?", before).changes,
    );
  }

  /** Counts one load of each skill by a seat of `role` on the UTC day `day`. */
  skillsLoaded(day: string, role: string, skills: readonly string[]): void {
    if (skills.length === 0) return;
    this.transaction("write", () => {
      for (const skill of skills)
        this.run(
          `INSERT INTO skill_loads (day, role, skill, loads) VALUES (?, ?, ?, 1)
             ON CONFLICT (day, role, skill) DO UPDATE SET loads = loads + 1`,
          day,
          role,
          skill,
        );
    });
  }

  /** Each role's loads of each skill since the UTC day `since`. */
  skillLoads(since: string): { role: string; skill: string; loads: number }[] {
    return this.rows<{ role: string; skill: string; loads: number }>(
      "SELECT role, skill, SUM(loads) AS loads FROM skill_loads WHERE day >= ? GROUP BY role, skill ORDER BY role, skill",
      since,
    ).map(({ role, skill, loads }) => ({ role, skill, loads }));
  }

  /** Drops, in slices, log lines past their days or the store's size (ids only grow, so the size is cut by id), incidents not seen within the days and old closed traces; the record of changes stays. */
  expire(before: Date, most: number, tracesBefore: Date): number {
    const cut = before.toISOString();
    let gone = this.deleteInSlices("DELETE FROM log WHERE id IN (SELECT id FROM log WHERE at < ? LIMIT ?)", [cut]);
    const newest = this.row<{ id: number | null }>("SELECT max(id) AS id FROM log")!.id ?? 0;
    gone += this.deleteInSlices("DELETE FROM log WHERE id IN (SELECT id FROM log WHERE id <= ? LIMIT ?)", [
      newest - most,
    ]);
    gone += this.deleteInSlices(
      "DELETE FROM incidents WHERE id IN (SELECT id FROM incidents WHERE last_at < ? LIMIT ?)",
      [cut],
    );
    gone += this.deleteInSlices("DELETE FROM traces WHERE id IN (SELECT id FROM traces WHERE closed_at < ? LIMIT ?)", [
      tracesBefore.toISOString(),
    ]);
    this.reclaim(SLICE);
    return gone;
  }
}
