import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import vocabulary from "../shared/work.json";
import { WorkError, WorkStore } from "../server/tasks/store";
import { work } from "../server/tasks/tools";

shipSql();

const POLICY = { minReasonChars: 20, forbidSelfClose: true };
const TIMING = { busyTimeoutMs: 5000, flushAfterMs: 60_000 };
let stores = 0;
/** A store of its own, with a clock that moves a second at every reading. */
function fresh(): { store: WorkStore; dir: string } {
  const dir = join(ROOM_HOME, `work-test-${(stores += 1)}`);
  let tick = Date.parse("2026-10-14T09:00:00Z");
  return { store: new WorkStore(dir, TIMING, () => new Date((tick += 1000))), dir };
}
const refuses = (code: string, work: () => unknown) =>
  assert.throws(work, (error: unknown) => error instanceof WorkError && error.code === code);

test("an issue is ready when nothing is in its way: open blockers, open children and what blocks its parent all hold it back", () => {
  const { store } = fresh();
  const schema = store.create({ title: "schema", priority: 1 }, "lead");
  const api = store.create({ title: "api", priority: 0, deps: [{ id: schema.id }] }, "lead");
  const epic = store.create({ title: "billing", issue_type: "epic", deps: [{ id: api.id }] }, "lead");
  const child = store.create({ title: "invoice line", parent: epic.id }, "lead");
  const note = store.create({ title: "typo in README", priority: 3, deps: [{ type: "related", id: api.id }] }, "lead");
  assert.match(schema.id, /^sw-[0-9a-z]{3}$/);
  assert.equal(child.id, `${epic.id}.1`);
  // the highest priority that is free comes first; a related issue holds nothing back
  assert.deepEqual(
    store.ready().map((issue) => issue.title),
    ["schema", "typo in README"],
  );
  assert.deepEqual(store.blockers(api.id), [schema.id]);
  assert.deepEqual(store.blockers(epic.id).sort(), [api.id, child.id].sort());
  assert.deepEqual(store.blockers(child.id), [api.id]);

  store.claim(schema.id, "peer-a");
  // an issue in progress still blocks, and is no longer on offer
  assert.deepEqual(
    store.ready().map((issue) => issue.title),
    ["typo in README"],
  );
  const closed = store.closeIssue(schema.id, "done in 4f2a91c, npm test 88/88", "lead", POLICY);
  assert.deepEqual(
    closed.unblocked.map((issue) => issue.title),
    ["api"],
  );
  assert.equal(store.ready({ limit: 1 })[0].id, api.id);
  assert.equal(store.get(note.id.slice(3)).id, note.id);
});

test("a claim is one seat's: another seat is refused, and so is a blocked, closed or deferred issue", () => {
  const { store } = fresh();
  const first = store.create({ title: "first" }, "lead");
  const second = store.create({ title: "second", deps: [{ id: first.id }] }, "lead");
  assert.deepEqual([store.claim(first.id, "peer-a").assignee, store.get(first.id).status], ["peer-a", "in_progress"]);
  assert.equal(store.claim(first.id, "peer-a").assignee, "peer-a");
  refuses("ALREADY_ASSIGNED", () => store.claim(first.id, "peer-b"));
  refuses("BLOCKED", () => store.claim(second.id, "peer-b"));
  store.update(second.id, { status: "deferred" }, "lead");
  refuses("VALIDATION_FAILED", () => store.claim(second.id, "peer-b"));
  refuses("ISSUE_NOT_FOUND", () => store.claim("sw-nope", "peer-b"));
});

test("an issue closes with a reason, by someone other than the seat that did it, and not over open children", () => {
  const { store } = fresh();
  const epic = store.create({ title: "store", issue_type: "epic" }, "lead");
  const child = store.create({ title: "partition", parent: epic.id }, "lead");
  store.claim(child.id, "peer-a");
  refuses("POLICY_VIOLATION", () => store.closeIssue(child.id, "done", "lead", POLICY));
  refuses("POLICY_VIOLATION", () => store.closeIssue(child.id, "done in 2ea3368, reviewed by two", "peer-a", POLICY));
  refuses("CLOSE_INCOMPLETE", () => store.closeIssue(epic.id, "every child is in, see 2ea3368", "lead", POLICY));
  refuses("VALIDATION_FAILED", () => store.update(child.id, { status: "closed" as never }, "lead"));
  store.closeIssue(child.id, "done in 2ea3368, reviewed by two", "lead", POLICY);
  const done = store.closeIssue(epic.id, "every child is in, see 2ea3368", "lead", POLICY).issue;
  assert.deepEqual(
    [done.status, done.closed_by, done.close_reason],
    ["closed", "lead", "every child is in, see 2ea3368"],
  );
  assert.equal(store.reopen(epic.id, "lead").status, "open");
});

test("an edge that orders work may close no cycle; one that only relates two issues may", () => {
  const { store } = fresh();
  const [a, b, c] = ["a", "b", "c"].map((title) => store.create({ title }, "lead"));
  store.addDependency(b.id, a.id, "blocks", "lead");
  store.addDependency(c.id, b.id, "blocks", "lead");
  refuses("CYCLE_DETECTED", () => store.addDependency(a.id, c.id, "blocks", "lead"));
  refuses("CYCLE_DETECTED", () => store.addDependency(a.id, c.id, "parent-child", "lead"));
  refuses("CYCLE_DETECTED", () => store.addDependency(a.id, a.id, "related", "lead"));
  store.addDependency(a.id, c.id, "discovered-from", "lead");
  store.removeDependency(c.id, b.id, "lead");
  store.addDependency(a.id, c.id, "blocks", "lead");
  assert.deepEqual(store.blockers(a.id), [c.id]);
});

test("a seat that is gone holds nothing: its work is open again, or its successor's; notes, comments and the trail stay", () => {
  const { store, dir } = fresh();
  const one = store.create({ title: "one", write_scope: "src/store.js" }, "lead");
  const two = store.create({ title: "two" }, "lead");
  store.claim(one.id, "peer-a");
  store.claim(two.id, "peer-a");
  store.update(one.id, { append_notes: "half of the index is written", priority: 0 }, "peer-a");
  store.comment(one.id, "lead", "keep the v2 reader");
  assert.deepEqual(store.release("peer-a", "peer-a2", "room").sort(), [one.id, two.id].sort());
  assert.deepEqual([store.get(one.id).assignee, store.get(one.id).status], ["peer-a2", "in_progress"]);
  store.release("peer-a2", null, "room");
  assert.deepEqual([store.get(one.id).assignee, store.get(one.id).status], [null, "open"]);
  assert.match(store.get(one.id).notes, /^\[2026-10-14T09:\d\d:\d\d\.000Z peer-a\] half of the index is written$/);
  assert.deepEqual(
    store.comments(one.id).map((comment) => [comment.author, comment.text]),
    [["lead", "keep the v2 reader"]],
  );
  assert.deepEqual(
    store.events(one.id, 3).map((event) => event.event_type),
    ["assignee_changed", "assignee_changed", "commented"],
  );
  // the text copy follows a burst of writes, and a new store on the same folder finds everything
  store.flush();
  const lines = readFileSync(join(dir, "issues.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map((line) => [line.title, line.priority, line.write_scope]),
    [
      ["one", 0, "src/store.js"],
      ["two", 2, ""],
    ],
  );
  store.close();
  assert.equal(new WorkStore(dir, TIMING).count(), 2);
});

test("what an issue may hold is checked: a title, a priority from 0 to 4, a known type, only its own fields", () => {
  const { store } = fresh();
  refuses("VALIDATION_FAILED", () => store.create({ title: " " }, "lead"));
  refuses("VALIDATION_FAILED", () => store.create({ title: "x", priority: 7 }, "lead"));
  refuses("VALIDATION_FAILED", () => store.create({ title: "x", issue_type: "saga" as never }, "lead"));
  const issue = store.create({ title: "x", labels: ["store"] }, "lead");
  const patched = store.update(issue.id, { title: "y", labels: ["store", "r24"], "id = id; --": 1 } as never, "lead");
  assert.deepEqual([patched.title, patched.labels, patched.id], ["y", ["store", "r24"], issue.id]);
});

test("a write that read an older revision is refused; a write that names none goes through", () => {
  const { store } = fresh();
  const issue = store.create({ title: "index" }, "lead");
  assert.equal(issue.revision, 1);
  const first = store.update(issue.id, { description: "an offset index", if_revision: 1 }, "peer-a");
  assert.equal(first.revision, 2);
  refuses("UPDATE_PRECONDITION_FAILED", () =>
    store.update(issue.id, { description: "a hash index", if_revision: 1 }, "peer-b"),
  );
  assert.equal(store.get(issue.id).description, "an offset index");
  assert.equal(store.update(issue.id, { append_notes: "kept" }, "peer-b").revision, 3);
});

/** Runs the worker in a process of its own and resolves with the one line it prints. */
function inProcess(
  dir: string,
  job: string[],
  gate?: string,
): Promise<{ won?: string; made?: string[]; refused?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--require", join(__dirname, "register.cjs"), join(__dirname, "support", "work-worker.ts"), dir, ...job],
      { env: { ...process.env, ...(gate ? { WORK_GATE: gate } : {}) } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", () => (out.trim() ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(err))));
  });
}

test("eight processes claim one issue at once: one wins, seven are told who holds it", async () => {
  const { store, dir } = fresh();
  const issue = store.create({ title: "the one" }, "lead");
  store.close();
  // the eight start their claim together, once every one has its store open
  const gate = join(dir, "..", `${basename(dir)}-gate`);
  const running = Array.from({ length: 8 }, (_, i) => inProcess(dir, ["claim", issue.id, `peer-${i}`], gate));
  const ready = () => readdirSync(dirname(gate)).filter((name) => name.startsWith(`${basename(gate)}.`)).length;
  while (ready() < 8) await new Promise((resolve) => setTimeout(resolve, 10));
  writeFileSync(gate, "");
  const results = await Promise.all(running);
  const winners = results.filter((result) => result.won);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.refused === "ALREADY_ASSIGNED").length, 7, JSON.stringify(results));
  const after = new WorkStore(dir, TIMING);
  assert.deepEqual([after.get(issue.id).assignee, after.get(issue.id).status], [winners[0].won, "in_progress"]);
});

test("six processes write a new store at once: every issue is there once, and the text copy is whole", async () => {
  const dir = join(ROOM_HOME, `work-test-${(stores += 1)}`);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => inProcess(dir, ["create", "40", `seat-${i}`])));
  const made = results.flatMap((result) => result.made ?? []);
  assert.equal(made.length, 240, JSON.stringify(results.map((result) => result.refused)));
  assert.equal(new Set(made).size, 240);
  const store = new WorkStore(dir, TIMING);
  assert.equal(store.count(), 240);
  store.flush();
  const lines = readFileSync(join(dir, "issues.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 240);
  assert.doesNotThrow(() => lines.forEach((line) => JSON.parse(line)));
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("a store whose database is lost or damaged comes back from its text copy, and the damaged file is kept aside", () => {
  const { store, dir } = fresh();
  const one = store.create({ title: "one", priority: 1 }, "lead");
  const two = store.create({ title: "two", deps: [{ id: one.id }] }, "lead");
  store.claim(one.id, "peer-a");
  store.comment(one.id, "lead", "keep the v2 reader");
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `work.db${suffix}`), { force: true });
  const back = new WorkStore(dir, TIMING);
  assert.deepEqual([back.count(), back.get(one.id).assignee, back.blockers(two.id)], [2, "peer-a", [one.id]]);
  assert.deepEqual(
    back.comments(one.id).map((comment) => comment.text),
    ["keep the v2 reader"],
  );
  assert.equal(back.events(one.id, 1)[0].event_type, "restored");
  back.close();

  writeFileSync(
    join(dir, "work.db"),
    "this is not a database, and it is long enough to be read as one page of something else",
  );
  const again = new WorkStore(dir, TIMING);
  assert.equal(again.count(), 2);
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("work.db.damaged-")).length, 1);
});

test("every query the store runs is served by an index, but the whole-store ones named here with their reason", () => {
  const { store } = fresh();
  const a = store.create({ title: "a" }, "lead");
  const b = store.create({ title: "b", parent: a.id }, "lead");
  const c = store.create({ title: "c" }, "lead");
  store.addDependency(c.id, b.id, "blocks", "lead");
  store.claim(b.id, "p1");
  store.comment(b.id, "p1", "half way");
  store.ready({ parent: a.id });
  store.list({ assignee: "p1", status: "in_progress", limit: 1 });
  store.list({ status: "open" });
  store.get(b.id.slice(0, 6));
  store.blockers(c.id);
  store.comments(b.id);
  store.events(b.id, 10);
  store.openWork();
  store.release("p1", null, "room");
  store.removeDependency(c.id, b.id, "lead");
  store.closeIssue(c.id, "done in abc1234, tests green", "lead", POLICY);
  // a pass over every issue is the store's whole: its count and its text copy
  const whole = ["SELECT COUNT(*) AS n FROM issues", "SELECT * FROM issues ORDER BY"];
  const scans = store
    .plans()
    .filter(({ plan }) => /\bSCAN (issues|dependencies|comments|events)\b(?! USING)/.test(plan))
    .filter(({ sql }) => !whole.some((known) => sql.startsWith(known)));
  assert.deepEqual(scans, []);
});

test("the store's checks take every word of shared/work.json", () => {
  const { store } = fresh();
  for (const type of vocabulary.issueTypes) store.create({ title: type, issue_type: type as never }, "lead");
  const [one, two] = store.all();
  for (const type of Object.keys(vocabulary.dependencyTypes)) {
    store.addDependency(one.id, two.id, type as never, "lead");
    store.removeDependency(one.id, two.id, "lead", type as never);
  }
  for (const status of vocabulary.statuses)
    if (status !== "closed") store.update(one.id, { status } as never, "lead", true);
});

test("a plan is written in one go: all of it or none, with issues naming each other by key", () => {
  const { store } = fresh();
  const made = store.createMany(
    [
      { key: "epic", title: "billing", issue_type: "epic" },
      { key: "api", title: "api", parent: "epic", deps: [{ id: "schema" }] },
      { key: "schema", title: "schema", parent: "epic" },
    ],
    "lead",
  );
  assert.deepEqual(
    made.map((issue) => issue.id),
    [made[0].id, `${made[0].id}.1`, `${made[0].id}.2`],
  );
  assert.deepEqual(store.blockers(made[1].id), [made[2].id]);
  // a cycle in the batch refuses the whole batch
  refuses("CYCLE_DETECTED", () =>
    store.createMany(
      [
        { key: "a", title: "a", deps: [{ id: "b" }] },
        { key: "b", title: "b", deps: [{ id: "a" }] },
      ],
      "lead",
    ),
  );
  assert.equal(store.count(), 3);
});

test("nothing of the store shows in the project's git: its folder keeps itself out", () => {
  const repo = join(ROOM_HOME, "repo-with-store");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const store = new WorkStore(join(repo, ".seatwork", ".work"), TIMING);
  store.create({ title: "schema" }, "lead");
  store.close();
  assert.ok(existsSync(join(repo, ".seatwork", ".work", "issues.jsonl")));
  assert.equal(
    execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }),
    "",
  );
});

test("a parent waits for its children and a child for what holds its parents: an edge that would close such a ring is refused", () => {
  const { store } = fresh();
  const parent = store.create({ title: "billing" }, "lead");
  const child = store.create({ title: "invoice line", parent: parent.id }, "lead");
  refuses("CYCLE_DETECTED", () => store.addDependency(child.id, parent.id, "blocks", "lead"));
  const other = store.create({ title: "tax table" }, "lead");
  store.addDependency(child.id, other.id, "blocks", "lead");
  refuses("CYCLE_DETECTED", () => store.addDependency(other.id, parent.id, "blocks", "lead"));
  const sibling = store.create({ title: "credit line", parent: parent.id }, "lead");
  store.addDependency(sibling.id, child.id, "blocks", "lead");
  refuses("CYCLE_DETECTED", () =>
    store.create({ title: "late", parent: parent.id, deps: [{ id: parent.id }] }, "lead"),
  );
});

test("what claim refuses, update refuses too, unless an Owner does it; a closed issue is reopened before it changes", () => {
  const { store } = fresh();
  const first = store.create({ title: "schema" }, "lead");
  const second = store.create({ title: "api", deps: [{ id: first.id }] }, "lead");
  store.claim(first.id, "peer-a");
  refuses("VALIDATION_FAILED", () => store.update(first.id, { assignee: "peer-b" }, "peer-b"));
  refuses("ALREADY_ASSIGNED", () => store.update(first.id, { assignee: null }, "peer-b"));
  refuses("BLOCKED", () => store.update(second.id, { status: "in_progress" }, "peer-b"));
  assert.equal(store.update(first.id, { assignee: "peer-c" }, "lead", true).assignee, "peer-c");
  assert.equal(store.update(first.id, { assignee: null }, "peer-c").assignee, null);
  store.closeIssue(first.id, "schema landed in 4f2a91c, tests green", "lead", POLICY);
  refuses("VALIDATION_FAILED", () => store.update(first.id, { status: "open" }, "lead", true));
});

test("an id is found by its whole text or by what follows the prefix, a parent before its children; an empty id names nothing", () => {
  const { store } = fresh();
  const parent = store.create({ title: "billing" }, "lead");
  store.create({ title: "invoice line", parent: parent.id }, "lead");
  assert.equal(store.get(parent.id.slice(3)).id, parent.id);
  for (const empty of ["", "sw-", " "]) refuses("VALIDATION_FAILED", () => store.get(empty));
  const ids = Array.from({ length: 12 }, () => store.create({ title: "line", parent: parent.id }, "lead").id);
  assert.equal(ids.at(-1), `${parent.id}.13`);
});

test("undepend takes away the edge it names, and a parent link only when named; ready under a parent follows the links", () => {
  const { store } = fresh();
  const epic = store.create({ title: "billing", issue_type: "epic" }, "lead");
  const loose = store.create({ title: "tax table" }, "lead");
  store.addDependency(loose.id, epic.id, "parent-child", "lead");
  store.addDependency(loose.id, epic.id, "related", "lead");
  assert.deepEqual(
    store.ready({ parent: epic.id }).map((issue) => issue.id),
    [loose.id],
  );
  store.removeDependency(loose.id, epic.id, "lead");
  assert.deepEqual(
    store.dependencies().map((dep) => dep.type),
    ["parent-child"],
  );
  store.removeDependency(loose.id, epic.id, "lead", "parent-child");
  assert.deepEqual(store.dependencies(), []);
});

test("a deferred issue waits out its time: it is not ready, cannot be claimed, and stays deferred when its seat goes", () => {
  const { store } = fresh();
  const later = store.create({ title: "release notes" }, "lead");
  store.update(later.id, { defer_until: "2099-01-01T00:00:00.000Z" }, "lead");
  assert.deepEqual(store.ready(), []);
  refuses("BLOCKED", () => store.claim(later.id, "peer-a"));
  const parked = store.create({ title: "parked" }, "lead");
  store.claim(parked.id, "peer-a");
  store.update(parked.id, { status: "deferred" }, "peer-a");
  store.release("peer-a", null, "room");
  assert.equal(store.get(parked.id).status, "deferred");
});

test(
  "a file the store cannot open is left where it is; only a damaged one is set aside",
  { skip: process.getuid?.() === 0 },
  () => {
    const { store, dir } = fresh();
    store.create({ title: "schema" }, "lead");
    store.close();
    const file = join(dir, "work.db");
    chmodSync(file, 0o000);
    try {
      assert.throws(() => new WorkStore(dir, TIMING));
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.includes("damaged")),
        [],
      );
    } finally {
      chmodSync(file, 0o644);
    }
    assert.equal(new WorkStore(dir, TIMING).count(), 1);
  },
);

test("a text copy with a line that is not an issue gives back the rest", () => {
  const { store, dir } = fresh();
  const kept = store.create({ title: "schema" }, "lead");
  store.close();
  const copy = join(dir, "issues.jsonl");
  writeFileSync(copy, `${readFileSync(copy, "utf8")}null\n{"id":"sw-bad","title":"x","status":"done"}\n`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(dir, `work.db${suffix}`), { force: true });
  const back = new WorkStore(dir, TIMING);
  assert.deepEqual(
    back.all().map((issue) => issue.id),
    [kept.id],
  );
});

test("a seat that launches no one closes nothing, and a tool call's numbers and times are checked", () => {
  const { store } = fresh();
  const rules = { busyTimeoutMs: 5000, flushAfterMs: 60_000, staleClaimMinutes: 120, close: POLICY };
  const peer = { id: "peer-a", owner: false };
  const lead = { id: "lead", owner: true };
  const made = work(store, rules, lead, { do: "create", title: "schema", priority: "0" }) as {
    id: string;
    priority: number;
  };
  assert.equal(made.priority, 0);
  refuses("VALIDATION_FAILED", () => work(store, rules, lead, { do: "create", title: "x", priority: "high" }));
  refuses("VALIDATION_FAILED", () => work(store, rules, lead, { do: "create", issues: [null] }));
  refuses("VALIDATION_FAILED", () => work(store, rules, lead, { do: "create", title: "x", deps: [null] }));
  refuses("VALIDATION_FAILED", () => work(store, rules, lead, { do: "update", id: made.id, defer_until: "next week" }));
  refuses("POLICY_VIOLATION", () =>
    work(store, rules, peer, { do: "close", id: made.id, reason: "schema landed in 4f2a91c, tests green" }),
  );
});

test("a write that finds another process writing is refused as one to try again, and goes through once that write ends", () => {
  const { store: made, dir } = fresh();
  made.close();
  const store = new WorkStore(dir, { busyTimeoutMs: 50, flushAfterMs: 60_000 });
  const other = new DatabaseSync(join(dir, "work.db"));
  other.exec("BEGIN IMMEDIATE");
  assert.throws(
    () => store.create({ title: "waits" }, "lead"),
    (error: unknown) => error instanceof WorkError && error.code === "DATABASE_LOCKED" && error.retryable,
  );
  other.exec("COMMIT");
  other.close();
  assert.equal(store.create({ title: "waits" }, "lead").title, "waits");
  store.close();
});
