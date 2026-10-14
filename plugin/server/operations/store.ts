import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite, type SqliteFailure } from "../sqlite";

/** The operations store in the room home: the room's log, its incidents, and the changes made to its policy. */

export class OperationsError extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
  }
}

/** One kind of trouble the room met, with how often and when its operator was last told. */
export interface Incident {
  key: string;
  district: string;
  firstAt: string;
  lastAt: string;
  count: number;
  line: string;
  toldAt: string | null;
  toldCount: number;
}

/** One change to the policy as the store keeps it; `before` and `after` are JSON, null when the key was absent. */
export interface Tune {
  id: number;
  at: string;
  seat: string;
  path: string;
  before: string | null;
  after: string | null;
  reason: string;
  evidence: string;
  reverts: number | null;
}

const SLICE = 2000;
const INCIDENT = `key, district, first_at AS firstAt, last_at AS lastAt, count, line, told_at AS toldAt,
  told_count AS toldCount`;
const TUNE = "id, at, seat, path, before, after, reason, evidence, reverts";

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

  /** Keeps a log line, and counts it under its incident key when it is one. */
  record(district: string, line: string, incident: string | null): void {
    const at = this.now().toISOString();
    this.transaction("write", () => {
      this.run("INSERT INTO log (at, district, line) VALUES (?, ?, ?)", at, district, line);
      if (incident)
        this.run(
          `INSERT INTO incidents (key, district, first_at, last_at, count, line) VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT (key) DO UPDATE SET last_at = excluded.last_at, count = count + 1, line = excluded.line`,
          incident,
          district,
          at,
          at,
          line,
        );
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

  /** Incidents seen since `since`, the most recent first. */
  incidents(since: string, limit: number): Incident[] {
    return this.rows<Incident>(
      `SELECT ${INCIDENT} FROM incidents WHERE last_at >= ? ORDER BY last_at DESC LIMIT ?`,
      since,
      limit,
    ).map((row) => ({ ...row }));
  }

  /** Incidents the operator has not been told of, or seen again since it was told longer ago than `retoldBefore`. */
  untold(retoldBefore: string, limit: number): Incident[] {
    return this.rows<Incident>(
      `SELECT ${INCIDENT} FROM incidents
         WHERE told_at IS NULL OR (count > told_count AND told_at < ? AND last_at > told_at)
         ORDER BY last_at DESC LIMIT ?`,
      retoldBefore,
      limit,
    ).map((row) => ({ ...row }));
  }

  /** The operator was told of these incidents at their present counts. */
  told(keys: readonly string[]): void {
    this.run(
      "UPDATE incidents SET told_at = ?, told_count = count WHERE key IN (SELECT value FROM json_each(?))",
      this.now().toISOString(),
      JSON.stringify(keys),
    );
  }

  /** Keeps a change to the policy; its id is what a revert names. */
  addTune(tune: Omit<Tune, "id" | "at">): Tune {
    const at = this.now().toISOString();
    const { lastInsertRowid } = this.run(
      "INSERT INTO tunes (at, seat, path, before, after, reason, evidence, reverts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      at,
      tune.seat,
      tune.path,
      tune.before,
      tune.after,
      tune.reason,
      tune.evidence,
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

  /** Drops log lines before `before` and past `most`, and incidents not seen since `before`; in slices. The record of changes stays. */
  expire(before: Date, most: number): number {
    const cut = before.toISOString();
    let gone = this.sliced("DELETE FROM log WHERE id IN (SELECT id FROM log WHERE at < ? LIMIT ?)", cut);
    const newest = this.row<{ id: number | null }>("SELECT max(id) AS id FROM log")!.id ?? 0;
    // ids only grow: everything at or below the newest minus `most` is past the store's size
    gone += this.sliced("DELETE FROM log WHERE id IN (SELECT id FROM log WHERE id <= ? LIMIT ?)", newest - most);
    gone += this.sliced(
      "DELETE FROM incidents WHERE key IN (SELECT key FROM incidents WHERE last_at < ? LIMIT ?)",
      cut,
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
