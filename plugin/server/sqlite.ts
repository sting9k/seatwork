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
const HISTORY = `CREATE TABLE IF NOT EXISTS schema_history (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  script TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`;

/** A store's folder, made, with the note that keeps all of it out of the project's commits. */
export function storeFolder(dir: string): string {
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

/** `scripts`: the folder of `V<number>__<what>.sql` files; `fail`: the store's own error. */
export interface SqliteOptions {
  busyTimeoutMs: number;
  scripts: string;
  fail: (code: SqliteFailure, message: string) => Error;
  name: string;
  now?: () => Date;
}

const isBusy = (error: unknown) =>
  (error as { errcode?: number })?.errcode === 5 || /database is locked/i.test((error as Error)?.message ?? "");

/** `startedOver` is true when a damaged file was set aside and this one started empty. */
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
    this.migrate();
  }

  private locked(): Error {
    return this.options.fail("DATABASE_LOCKED", `another process is writing ${this.options.name}; try again`);
  }

  /** Opens the database; a damaged one is set aside and a new one started. */
  private open(): { db: DatabaseSync; startedOver: boolean } {
    const attempt = () => {
      const db = new DatabaseSync(this.file);
      try {
        db.exec(`PRAGMA busy_timeout = ${Math.trunc(this.options.busyTimeoutMs)}; PRAGMA journal_mode = WAL;`);
        db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
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

    this.transaction("write", () => {
      this.db.exec(HISTORY);
      // a file from before the history was kept: what its version counter says is taken as applied
      if (applied().size === 0) for (const script of scripts) if (script.version <= version()) record(script);
    });
    const latest = Math.max(version(), ...applied().keys());
    const newest = scripts[scripts.length - 1].version;
    if (latest > newest)
      throw this.options.fail(
        "SCHEMA_TOO_NEW",
        `${name} is at layout ${latest} and this plugin writes ${newest}: update the plugin`,
      );
    for (const script of scripts) {
      const was = applied().get(script.version);
      if (was !== undefined && was !== script.checksum)
        throw invalid(`${script.name} changed after it was applied; a change to the layout is a new script`);
      if (was === undefined && script.version < latest)
        throw invalid(`${script.name} is older than layout ${latest}, which is already applied`);
      if (was !== undefined) continue;
      this.transaction("write", () => {
        // of two processes on a new store, the one that waited finds the step done
        if (applied().has(script.version)) return;
        this.db.exec(script.sql);
        record(script);
        this.db.exec(`PRAGMA user_version = ${script.version}`);
      });
    }
  }

  close(): void {
    this.statements.clear();
    this.db.exec("PRAGMA optimize");
    this.db.close();
  }

  protected statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) this.statements.set(sql, (prepared = this.db.prepare(sql)));
    return prepared;
  }

  protected run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const done = this.statement(sql).run(...params);
    return { changes: Number(done.changes), lastInsertRowid: Number(done.lastInsertRowid) };
  }

  protected rows<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

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
