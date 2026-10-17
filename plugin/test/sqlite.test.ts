import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Sqlite, readScripts, storeStats, type Row, type SqliteFailure } from "../server/sqlite";

const base = mkdtempSync(join(tmpdir(), "seatwork-sqlite-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

class Failure extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
  }
}

/** A store that only shows what its layout came to. */
class Probe extends Sqlite {
  constructor(file: string, scripts: string, busyTimeoutMs = 2000) {
    super(file, {
      busyTimeoutMs,
      scripts,
      name: "the probe",
      fail: (code, message) => new Failure(code, message),
    });
  }
  tables(): string[] {
    return this.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(
      (r) => r.name,
    );
  }
  history(): { version: number; script: string }[] {
    return this.rows<{ version: number; script: string }>(
      "SELECT version, script FROM schema_history ORDER BY version",
    ).map((row) => ({ version: row.version, script: row.script }));
  }
  raw(sql: string): void {
    this.db.exec(sql);
  }
  ask(sql: string): Row[] {
    return this.rows(sql);
  }
}

let folders = 0;
function fresh(scripts: Record<string, string>): { file: string; dir: string } {
  const root = join(base, `case-${(folders += 1)}`);
  const dir = join(root, "sql");
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(scripts)) writeFileSync(join(dir, name), sql);
  return { file: join(root, "probe.db"), dir };
}

const refuses = (code: SqliteFailure, work: () => unknown, message?: RegExp) =>
  assert.throws(
    work,
    (error: unknown) => error instanceof Failure && error.code === code && (!message || message.test(error.message)),
  );

test("a new store runs every script in version order and keeps the history of it", () => {
  const { file, dir } = fresh({
    "V2__add_notes.sql": "CREATE TABLE notes (id INTEGER PRIMARY KEY);",
    "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);",
    "README.md": "not a script",
  });
  const store = new Probe(file, dir);
  assert.deepEqual(store.tables(), ["notes", "schema_history", "things"]);
  assert.deepEqual(store.history(), [
    { version: 1, script: "V1__layout.sql" },
    { version: 2, script: "V2__add_notes.sql" },
  ]);
  store.close();
});

test("a script added later is applied at the next open, and only that one", () => {
  const { file, dir } = fresh({ "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  new Probe(file, dir).close();
  writeFileSync(join(dir, "V27__add_notes.sql"), "CREATE TABLE notes (id INTEGER PRIMARY KEY);");
  const store = new Probe(file, dir);
  assert.deepEqual(store.tables(), ["notes", "schema_history", "things"]);
  assert.deepEqual(
    store.history().map((row) => row.version),
    [1, 27],
  );
  store.close();
  new Probe(file, dir).close();
});

test("a script that changed after it was applied is refused: a change to the layout is a new script", () => {
  const { file, dir } = fresh({ "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  new Probe(file, dir).close();
  writeFileSync(join(dir, "V1__layout.sql"), "CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT);");
  refuses("MIGRATION_INVALID", () => new Probe(file, dir), /V1__layout\.sql changed after it was applied/);
});

test("a script older than what is applied, two scripts for one version, and an empty folder are refused", () => {
  const late = fresh({ "V2__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  new Probe(late.file, late.dir).close();
  writeFileSync(join(late.dir, "V1__forgotten.sql"), "CREATE TABLE old (id INTEGER PRIMARY KEY);");
  refuses("MIGRATION_INVALID", () => new Probe(late.file, late.dir), /V1__forgotten\.sql is older than layout 2/);
  const twice = fresh({ "V1__a.sql": "CREATE TABLE a (id INTEGER);", "V01__b.sql": "CREATE TABLE b (id INTEGER);" });
  refuses("MIGRATION_INVALID", () => new Probe(twice.file, twice.dir), /two scripts for version 1/);
  const none = fresh({});
  refuses("MIGRATION_INVALID", () => new Probe(none.file, none.dir), /no layout script/);
});

test("a script that fails leaves nothing of itself behind", () => {
  const { file, dir } = fresh({
    "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);",
    "V2__broken.sql": "CREATE TABLE half (id INTEGER PRIMARY KEY); CREATE TABLE things (id INTEGER);",
  });
  assert.throws(() => new Probe(file, dir), /already exists/);
  writeFileSync(join(dir, "V2__broken.sql"), "CREATE TABLE half (id INTEGER PRIMARY KEY);");
  const store = new Probe(file, dir);
  assert.deepEqual(store.tables(), ["half", "schema_history", "things"]);
  store.close();
});

test("a store at a newer layout than this plugin writes is refused", () => {
  const { file, dir } = fresh({ "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  const store = new Probe(file, dir);
  store.raw("PRAGMA user_version = 99");
  store.close();
  refuses("SCHEMA_TOO_NEW", () => new Probe(file, dir), /at layout 99 and this plugin writes 1/);
});

test("the scripts that ship are well formed: one per version, named for what they do", () => {
  const sql = join(__dirname, "..", "room", "sql");
  for (const store of readdirSync(sql)) {
    const scripts = readScripts(join(sql, store));
    assert.ok(scripts.length > 0, store);
    assert.deepEqual(
      scripts.map((script) => script.version),
      scripts.map((_, index) => index + 1),
      `${store}: versions run from 1 with no gap`,
    );
  }
});

test("a store keeps a bounded number of prepared statements, however many different ones it is asked for", () => {
  const { file, dir } = fresh({ "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  const store = new Probe(file, dir);
  for (let i = 0; i < 1000; i += 1) assert.equal(store.ask(`SELECT ${i} AS n`)[0].n, i);
  assert.ok(store.plans().length <= 512, `${store.plans().length} statements kept`);
  assert.equal(store.ask("SELECT 999 AS n")[0].n, 999, "the newest statement still runs");
  store.close();
});

test("a store limits its write-ahead log, so a large write does not keep its size on disk", () => {
  const { file, dir } = fresh({ "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  const store = new Probe(file, dir);
  const limit = Number(
    (store.ask("PRAGMA journal_size_limit")[0] as { journal_size_limit: number }).journal_size_limit,
  );
  assert.ok(limit > 0 && limit <= 64 * 1024 * 1024, `journal_size_limit is ${limit}`);
  store.close();
});

test("an open store is counted call by call with its slowest and its write-ahead log, and leaves the count when closed", () => {
  const { file, dir } = fresh({ "V1__t.sql": "CREATE TABLE t (x INTEGER);" });
  const store = new Probe(file, dir);
  // a recursive count long enough to be the slowest statement so far
  store.ask("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200000) SELECT count(*) FROM n");
  store.ask("SELECT 1");
  const stat = storeStats().find((one) => one.file === file)!;
  assert.equal(stat.name, "the probe");
  assert.ok(stat.calls >= 2);
  assert.match(stat.slowest, /^WITH RECURSIVE n\(x\)/);
  assert.ok(stat.walBytes > 0, "the layout's writes sit in the write-ahead log");
  store.close();
  assert.equal(
    storeStats().some((one) => one.file === file),
    false,
  );
});

test("a store closes even when another connection holds the write lock while it refreshes its statistics", () => {
  const { file, dir } = fresh({
    "V1__t.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT); CREATE INDEX t_k ON t (k);",
  });
  const store = new Probe(file, dir, 50);
  for (let i = 0; i < 500; i += 1) store.raw(`INSERT INTO t (k) VALUES ('k${i % 7}')`);
  store.ask("SELECT id FROM t WHERE k = 'k1'");
  const other = new DatabaseSync(file);
  other.exec("PRAGMA busy_timeout = 50; BEGIN IMMEDIATE");
  try {
    store.close();
  } finally {
    other.exec("ROLLBACK");
    other.close();
  }
  assert.equal(
    storeStats().some((one) => one.file === file),
    false,
  );
  assert.throws(() => store.ask("SELECT 1"), /not open/i, "the connection is shut");
});
