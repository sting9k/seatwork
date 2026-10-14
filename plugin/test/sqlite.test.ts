import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Sqlite, readScripts, type SqliteFailure } from "../server/sqlite";

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
  constructor(file: string, scripts: string) {
    super(file, {
      busyTimeoutMs: 2000,
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

test("a file from before the history was kept counts what its version says as applied; a newer layout is refused", () => {
  const { file, dir } = fresh({ "V1__layout.sql": "CREATE TABLE things (id INTEGER PRIMARY KEY);" });
  const first = new Probe(file, dir);
  first.raw("DROP TABLE schema_history");
  first.close();
  writeFileSync(join(dir, "V2__add_notes.sql"), "CREATE TABLE notes (id INTEGER PRIMARY KEY);");
  const store = new Probe(file, dir);
  assert.deepEqual(
    store.history().map((row) => row.version),
    [1, 2],
  );
  store.raw("PRAGMA user_version = 99");
  store.close();
  refuses("SCHEMA_TOO_NEW", () => new Probe(file, dir), /at layout 99 and this plugin writes 2/);
});

test("the scripts that ship are well formed: one per version, named for what they do", () => {
  for (const store of ["work", "mail"]) {
    const scripts = readScripts(join(__dirname, "..", "room", "sql", store));
    assert.ok(scripts.length > 0, store);
    assert.deepEqual(
      scripts.map((script) => script.version),
      scripts.map((_, index) => index + 1),
      `${store}: versions run from 1 with no gap`,
    );
  }
});
