import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/** One SQLite file of the room: opened sound, brought to its layout by versioned scripts. */

export type Row = Record<string, unknown>;
export type Param = string | number | null;

export type SqliteFailure = "DATABASE_LOCKED" | "SCHEMA_TOO_NEW" | "MIGRATION_INVALID";

/** One step of a store's layout, read from its file. */
export interface Script {
  version: number;
  description: string;
  name: string;
  sql: string;
  checksum: string;
}

const SCRIPT_NAME = /^V(\d+)__(.+)\.sql$/;
const MAX_STATEMENTS = 512;
const WAL_LIMIT_BYTES = 16 * 1024 * 1024;
const HISTORY = `CREATE TABLE IF NOT EXISTS schema_history (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  script TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`;

/** A room folder, made, with the note that keeps it out of the project's commits. */
export function keptOutOfGit(dir: string): string {
  if (!existsSync(join(dir, ".gitignore"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "*\n");
  }
  return dir;
}

/** The scripts of a folder, in version order. */
export function readScripts(dir: string): Script[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const match = SCRIPT_NAME.exec(name);
      if (!match) return [];
      const sql = readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n").trimEnd();
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      return [{ version: Number(match[1]), description: match[2].replace(/_/g, " "), name, sql, checksum }];
    })
    .sort((a, b) => a.version - b.version);
}

/** `busyTimeoutMs`: how long a write waits on another process; `scripts`: the folder of `V<number>__<what>.sql` files; `fail`: the store's own error; `name`: the store as messages call it; `reclaims`: a new file gives freed pages back; `now`: the clock. */
export interface SqliteOptions {
  busyTimeoutMs: number;
  scripts: string;
  fail: (code: SqliteFailure, message: string) => Error;
  name: string;
  now?: () => Date;
  reclaims?: boolean;
}

/** The file is damaged or no database: SQLITE_CORRUPT, SQLITE_NOTADB, a failed check. */
const isDamaged = (error: unknown) =>
  [11, 26].includes(((error as { errcode?: number })?.errcode ?? 0) & 0xff) ||
  /malformed|not a database|quick_check/i.test((error as Error)?.message ?? "");

/** Another process holds the write lock: SQLITE_BUSY. */
const isBusy = (error: unknown) =>
  (error as { errcode?: number })?.errcode === 5 || /database is locked/i.test((error as Error)?.message ?? "");

/** A SQLite file of the room: opened sound, brought to its layout by its scripts; `startedOver` says a damaged file was set aside for an empty one. */
export class Sqlite {
  protected readonly db: DatabaseSync;
  readonly startedOver: boolean;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(
    protected readonly file: string,
    private readonly options: SqliteOptions,
  ) {
    const opened = this.open();
    this.db = opened.db;
    this.startedOver = opened.startedOver;
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private locked(): Error {
    return this.options.fail("DATABASE_LOCKED", `another process is writing ${this.options.name}; try again`);
  }

  /** Opens the database; a damaged one is set aside and a new one started. */
  private open(): { db: DatabaseSync; startedOver: boolean } {
    const attempt = () => {
      const db = new DatabaseSync(this.file);
      try {
        // only a file with no table yet takes the setting; an older file keeps its own
        // the wait comes first: another process creating the same file holds it while it sets its layout
        db.exec(`PRAGMA busy_timeout = ${Math.trunc(this.options.busyTimeoutMs)}`);
        if (this.options.reclaims) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("PRAGMA journal_mode = WAL");
        // after a checkpoint the write-ahead log is cut back to this size, so one large write does not keep its size on disk
        db.exec(`PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = ${WAL_LIMIT_BYTES};`);
        const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
        if (check?.quick_check !== "ok") throw new Error(`quick_check: ${check?.quick_check ?? "no answer"}`);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    try {
      return { db: attempt(), startedOver: false };
    } catch (error) {
      if (isBusy(error)) throw this.locked();
      // a file the process cannot open is no damaged one: it stays where it is
      if (!isDamaged(error)) throw error;
      const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(this.file + suffix)) renameSync(this.file + suffix, `${this.file}.damaged-${stamp}${suffix}`);
      return { db: attempt(), startedOver: true };
    }
  }

  /** Applies the scripts this file has not seen, in order; one changed after it ran is refused. */
  private migrate(): void {
    const { scripts: dir, name } = this.options;
    const invalid = (message: string) => this.options.fail("MIGRATION_INVALID", `${name}: ${message}`);
    const scripts = readScripts(dir);
    if (scripts.length === 0) throw invalid(`no layout script in ${dir}; set the room up again`);
    const twice = scripts.find((script, index) => scripts[index + 1]?.version === script.version);
    if (twice) throw invalid(`two scripts for version ${twice.version} in ${dir}`);
    const stamp = () => (this.options.now?.() ?? new Date()).toISOString();
    const record = (script: Script) =>
      this.db
        .prepare(
          "INSERT INTO schema_history (version, description, script, checksum, applied_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(script.version, script.description, script.name, script.checksum, stamp());
    const version = () => (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const applied = () =>
      new Map(
        (
          this.db.prepare("SELECT version, checksum FROM schema_history").all() as {
            version: number;
            checksum: string;
          }[]
        ).map((row) => [row.version, row.checksum]),
      );

    this.transaction("write", () => this.db.exec(HISTORY));
    const was = applied();
    const latest = Math.max(version(), ...was.keys());
    const newest = scripts[scripts.length - 1].version;
    if (latest > newest)
      throw this.options.fail(
        "SCHEMA_TOO_NEW",
        `${name} is at layout ${latest} and this plugin writes ${newest}: update the plugin`,
      );
    for (const script of scripts) {
      const checksum = was.get(script.version);
      if (checksum !== undefined && checksum !== script.checksum)
        throw invalid(`${script.name} changed after it was applied; a change to the layout is a new script`);
      if (checksum === undefined && script.version < latest)
        throw invalid(`${script.name} is older than layout ${latest}, which is already applied`);
      if (checksum !== undefined) continue;
      this.transaction("write", () => {
        // of two processes on a new store, the one that waited finds the step done
        if (applied().has(script.version)) return;
        this.db.exec(script.sql);
        record(script);
        this.db.exec(`PRAGMA user_version = ${script.version}`);
      });
    }
  }

  /** How SQLite runs each statement prepared so far: what the tests hold to the indexes. */
  plans(): { sql: string; plan: string }[] {
    return [...this.statements.keys()].map((sql) => ({
      sql,
      plan: (this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((row) => row.detail)
        .join(" | "),
    }));
  }

  /** Gives up to `pages` of the pages deletes freed back to the file system, on a file made to reclaim them. */
  reclaim(pages = 0): void {
    this.db.exec(`PRAGMA incremental_vacuum(${Math.max(0, Math.trunc(pages))})`);
  }

  /** Lets SQLite refresh its statistics, then closes the file. */
  close(): void {
    this.statements.clear();
    this.db.exec("PRAGMA optimize");
    this.db.close();
  }

  /** A statement prepared once per text; past MAX_STATEMENTS the oldest is dropped, so SQL built per call cannot grow the cache without end. */
  protected statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      if (this.statements.size >= MAX_STATEMENTS) this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, (prepared = this.db.prepare(sql)));
    }
    return prepared;
  }

  /** Runs a write; how many rows it changed and the last row id. */
  protected run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const done = this.statement(sql).run(...params);
    return { changes: Number(done.changes), lastInsertRowid: Number(done.lastInsertRowid) };
  }

  /** Every row a read returns. */
  protected rows<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** The first row a read returns, if any. */
  protected row<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  /** One unit of work; a write takes the write lock first, so nothing it read can change. */
  protected transaction<T>(mode: "read" | "write", work: () => T): T {
    if (this.depth > 0) return work();
    try {
      this.db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    } catch (error) {
      throw isBusy(error) ? this.locked() : error;
    }
    this.depth += 1;
    try {
      const done = work();
      this.db.exec("COMMIT");
      return done;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw isBusy(error) ? this.locked() : error;
    } finally {
      this.depth -= 1;
    }
  }
}
