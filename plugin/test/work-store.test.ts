import { ROOM_HOME, shipSql } from "./support/room";
import { fastestInTurns } from "./support/timing";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import vocabulary from "../shared/work.json";
import { Sqlite, keptOutOfGit } from "../server/sqlite";
import { WorkError, WorkStore } from "../server/tasks/store";
import { WorkStores } from "../server/tasks/stores";
import { work } from "../server/tasks/tools";

shipSql();

const POLICY = { minReasonChars: 20, forbidSelfClose: true };
const TIMING = { busyTimeoutMs: 5000 };
let stores = 0;
const stores_ = (name: string) => `${name}-${(stores += 1)}`;
/** A store of its own, with a clock that moves a second at every reading. */
function fresh(): { store: WorkStore; dir: string } {
  const dir = join(ROOM_HOME, `work-test-${(stores += 1)}`);
  let tick = Date.parse("2026-10-14T09:00:00Z");
  return { store: new WorkStore(dir, TIMING, () => new Date((tick += 1000))), dir };
}
const refuses = (code: string, work: () => unknown) =>
  assert.throws(work, (error: unknown) => error instanceof WorkError && error.code === code);

test("an issue is ready when nothing is in its way: open blockers, open children and a blocked parent all hold it back", () => {
  const { store } = fresh();
  const schema = store.create({ title: "schema", priority: 1 }, "lead");
  const api = store.create({ title: "api", priority: 0, deps: [{ id: schema.id }] }, "lead");
  const epic = store.create({ title: "billing", issue_type: "epic", deps: [{ id: api.id }] }, "lead");
  const child = store.create({ title: "invoice line", parent: epic.id }, "lead");
  const note = store.create({ title: "typo in README", priority: 3, deps: [{ type: "related", id: api.id }] }, "lead");
  assert.match(schema.id, /^sw-[0-9a-z]{3}$/);
  assert.equal(child.id, `${epic.id}.1`);
  assert.deepEqual(
    store.ready().map((issue) => issue.title),
    ["schema", "typo in README"],
  );
  assert.deepEqual(store.blockers(api.id), [schema.id]);
  assert.deepEqual(store.blockers(epic.id), [api.id, `${child.id}:child-open`].sort());
  assert.deepEqual(store.blockers(child.id), [`${epic.id}:parent-blocked`]);

  store.claim(schema.id, "peer-a");
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
    store.comments(one.id).comments.map((comment) => [comment.author, comment.text]),
    [["lead", "keep the v2 reader"]],
  );
  assert.deepEqual(
    store.events(one.id, 3).map((event) => event.event_type),
    ["assignee_changed", "assignee_changed", "commented"],
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

test("six processes write a new store at once: every issue is there once", async () => {
  const dir = join(ROOM_HOME, `work-test-${(stores += 1)}`);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => inProcess(dir, ["create", "40", `seat-${i}`])));
  const made = results.flatMap((result) => result.made ?? []);
  assert.equal(made.length, 240, JSON.stringify(results.map((result) => result.refused)));
  assert.equal(new Set(made).size, 240);
  const store = new WorkStore(dir, TIMING);
  assert.equal(store.count(), 240);
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
  store.list({ limit: 5 });
  store.titles("open", 5);
  store.get(b.id.slice(0, 6));
  store.blockers(c.id);
  store.comments(b.id, 5, 1);
  store.events(b.id, 10);
  store.openWork();
  store.release("p1", null, "room");
  store.removeDependency(c.id, b.id, "lead");
  store.closeIssue(c.id, "done in abc1234, tests green", "lead", POLICY);
  store.expire(new Date("2099-01-01T00:00:00Z"));
  // a pass over every issue is the store's whole: its count and its text copy
  const whole = ["SELECT COUNT(*) AS n FROM issues", "SELECT * FROM issues ORDER BY"];
  const scans = store
    .plans()
    .filter(({ plan }) => /\bSCAN (issues|dependencies|comments|events)\b(?! USING)/.test(plan))
    .filter(({ sql }) => !whole.some((known) => sql.startsWith(known)));
  assert.deepEqual(scans, []);
  // the graph reads start from the open issues: a pass over every edge of a kind would grow with closed work
  assert.deepEqual(
    store.plans().filter(({ plan }) => /dependencies_by_type \(type=\?\)/.test(plan)),
    [],
  );
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
  assert.ok(existsSync(join(repo, ".seatwork", ".work", "work.db")));
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

test("as in br, a blocked parent and an open child hold an issue back from ready, never from being started; an open child keeps its parent open", () => {
  const { store } = fresh();
  const gate = store.create({ title: "gate" }, "lead");
  const epic = store.create({ title: "epic", issue_type: "epic", deps: [{ id: gate.id }] }, "lead");
  const child = store.create({ title: "child", parent: epic.id }, "lead");
  const whole = store.create({ title: "whole" }, "lead");
  const part = store.create({ title: "part", parent: whole.id }, "lead");
  assert.deepEqual(
    store.ready().map((issue) => issue.title),
    ["gate", "part"],
  );
  // the child of a blocked parent may be what frees it: it is started, and closed while the parent waits
  assert.equal(store.claim(child.id, "peer-a").status, "in_progress");
  store.closeIssue(child.id, "done in 4f2a91c, npm test green", "lead", POLICY);
  assert.equal(store.claim(whole.id, "peer-b").status, "in_progress");
  refuses("CLOSE_INCOMPLETE", () => store.closeIssue(whole.id, "done in 5b3c02d, npm test green", "lead", POLICY));
  store.closeIssue(part.id, "done in 6c4d13e, npm test green", "lead", POLICY);
  assert.equal(store.closeIssue(whole.id, "done in 5b3c02d, npm test green", "lead", POLICY).issue.status, "closed");
  refuses("BLOCKED", () => store.claim(epic.id, "peer-c"));
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

test("a seat that launches no one closes nothing, and a tool call's numbers and times are checked", () => {
  const { store } = fresh();
  const rules = { busyTimeoutMs: 5000, staleClaimMinutes: 120, close: POLICY };
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
  const store = new WorkStore(dir, { busyTimeoutMs: 50 });
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

test("deleting an issue looks no child table over: every foreign key column leads an index", () => {
  const { store, dir } = fresh();
  store.close();
  const db = new DatabaseSync(join(dir, "work.db"), { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  const unindexed: string[] = [];
  for (const { name } of tables) {
    const keys = db.prepare(`PRAGMA foreign_key_list(${name})`).all() as { from: string }[];
    const leads = (db.prepare(`PRAGMA index_list(${name})`).all() as { name: string }[]).map(
      (index) => (db.prepare(`PRAGMA index_info(${index.name})`).all() as { seqno: number; name: string }[])[0].name,
    );
    for (const key of keys) if (!leads.includes(key.from)) unindexed.push(`${name}.${key.from}`);
  }
  db.close();
  assert.deepEqual(unindexed, []);
});

/** A small deterministic random generator. */
function dice(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("what stands in one issue's way is what the whole graph says of it, in any mix of parents, blockers, closed and reopened", () => {
  const roll = dice(7);
  const kinds = new Set<string>();
  for (let round = 0; round < 6; round += 1) {
    const { store } = fresh();
    const made: { id: string; title: string }[] = [];
    for (let i = 0; i < 40; i += 1) {
      const earlier = () => made[Math.floor(roll() * i)]?.id;
      const input = {
        title: `issue ${i}`,
        issue_type: roll() < 0.3 ? ("epic" as const) : ("task" as const),
        parent: roll() < 0.5 ? earlier() : undefined,
        deps: roll() < 0.6 && i > 0 ? [{ id: earlier() }] : [],
      };
      try {
        made.push(store.create(input, "lead"));
      } catch (error) {
        // an edge that would close a ring is refused; the issue stands alone
        if (!(error instanceof WorkError)) throw error;
        made.push(store.create({ title: input.title }, "lead"));
      }
    }
    const closed = made.filter(() => roll() < 0.35);
    for (const issue of closed) store.closeIssue(issue.id, "closed to try a graph, see 4f2a91c", "lead", POLICY, true);
    for (const issue of closed) if (roll() < 0.2) store.reopen(issue.id, "lead");
    const whole = store.openWork().blocked;
    for (const issue of made) {
      assert.deepEqual(store.blockers(issue.id), whole.get(issue.id) ?? [], issue.title);
      for (const ref of whole.get(issue.id) ?? []) kinds.add(ref.replace(/^[^:]*/, ""));
    }
  }
  assert.deepEqual([...kinds].sort(), ["", ":child-open", ":parent-blocked"], "every kind of blocker was tried");
});

test("what stands in an issue's way is read from its own corner of the graph: ten times the issues cost about the same", async () => {
  const stand = (count: number) => {
    const { store } = fresh();
    const made = store.createMany(
      Array.from({ length: count }, (_, i) => ({
        key: `k${i}`,
        title: `issue ${i}`,
        deps: i % 3 === 0 ? [] : [{ id: `k${i - 1}` }],
      })),
      "lead",
    );
    return () => {
      for (let i = 0; i < 30; i += 1) store.blockers(made[2].id);
    };
  };
  const [fastSmall, fastLarge] = await fastestInTurns(stand(300), stand(3000), 5);
  assert.ok(
    fastLarge < Math.max(fastSmall, 1) * 4,
    `300 issues: ${fastSmall.toFixed(1)} ms, 3000 issues: ${fastLarge.toFixed(1)} ms`,
  );
});

test("an issue holds at most the characters the vocabulary allows, in every text field, its labels, its notes and a comment", () => {
  const { store } = fresh();
  const most = vocabulary.textChars;
  const issue = store.create({ title: "index", description: "d".repeat(most) }, "lead");
  refuses("VALIDATION_FAILED", () => store.create({ title: "x", design: "d".repeat(most + 1) }, "lead"));
  refuses("VALIDATION_FAILED", () => store.create({ title: "x", write_scope: "d".repeat(most + 1) }, "lead"));
  refuses("VALIDATION_FAILED", () => store.update(issue.id, { acceptance_criteria: "d".repeat(most + 1) }, "lead"));
  refuses("VALIDATION_FAILED", () => store.comment(issue.id, "lead", "c".repeat(most + 1)));
  refuses("VALIDATION_FAILED", () =>
    store.update(issue.id, { labels: Array.from({ length: most }, () => "l") }, "lead"),
  );
  store.comment(issue.id, "lead", "c".repeat(most));
  store.update(issue.id, { append_notes: "n".repeat(most - 200) }, "lead");
  refuses("VALIDATION_FAILED", () => store.update(issue.id, { append_notes: "n".repeat(300) }, "lead"));
  assert.ok(store.get(issue.id).notes.length <= most);
});

test("closed issues past their keep leave the store, with their comments; open work and closed work in a live tree stay", () => {
  const { store } = fresh();
  const close = (id: string) => store.closeIssue(id, "done in 4f2a91c, tests green", "lead", POLICY, true);
  const old = store.create({ title: "old" }, "lead");
  store.comment(old.id, "lead", "keep the v2 reader");
  const gate = store.create({ title: "gate" }, "lead");
  const waits = store.create({ title: "waits", deps: [{ id: gate.id }] }, "lead");
  const live = store.create({ title: "live epic", issue_type: "epic" }, "lead");
  const doneChild = store.create({ title: "done child", parent: live.id }, "lead");
  store.create({ title: "open child", parent: live.id }, "lead");
  const done = store.create({ title: "done epic", issue_type: "epic" }, "lead");
  const doneKid = store.create({ title: "done kid", parent: done.id }, "lead");
  const held = store.create({ title: "closed parent", issue_type: "epic" }, "lead");
  store.create({ title: "open kid", parent: held.id }, "lead");
  for (const issue of [old, gate, doneChild, doneKid, done, held]) close(issue.id);

  assert.equal(store.expire(new Date("2026-10-14T09:00:00Z")), 0, "nothing is past a keep that began before it all");
  assert.equal(store.expire(new Date("2026-10-15T00:00:00Z")), 4, "old, gate, and the finished tree of done");
  const left = store.all().map((issue) => issue.title);
  assert.deepEqual(
    left.sort(),
    ["closed parent", "done child", "live epic", "open child", "open kid", "waits"].sort(),
    "a closed child of a live parent keeps its number, a closed parent keeps its open child",
  );
  assert.deepEqual(store.blockers(waits.id), [], "what the gate held back is free");
  assert.deepEqual(
    store.ready().map((issue) => issue.title),
    ["waits", "open child", "open kid"],
  );
  assert.equal(store.create({ title: "next child", parent: live.id }, "lead").id, `${live.id}.3`);
});

test("the stores of the projects a room names expire their closed issues; a project with no store is left as it is", () => {
  const rules = { busyTimeoutMs: 5000, staleClaimMinutes: 120, close: POLICY };
  const stores = new WorkStores(rules, () => {});
  const [one, two, none] = ["one", "two", "none"].map((name) => join(ROOM_HOME, `expire-${stores_(name)}`));
  for (const root of [one, two]) {
    const { store } = stores.of(root);
    const made = store.create({ title: "finished" }, "lead");
    store.create({ title: "going on" }, "lead");
    store.closeIssue(made.id, "done in 4f2a91c, tests green", "lead", POLICY);
  }
  mkdirSync(none, { recursive: true });
  assert.equal(stores.expire(new Date("2099-01-01T00:00:00Z"), [one, two, none]), 2);
  assert.equal(stores.of(one).store.count(), 1);
  assert.equal(existsSync(join(none, ".seatwork")), false);
  stores.close();
});

test("a list counts the issues that match only when its page is full", () => {
  const { store } = fresh();
  for (const title of ["a", "b", "c"]) store.create({ title }, "lead");
  const counted: string[] = [];
  const row = (store as unknown as { row: (sql: string, ...params: unknown[]) => unknown }).row.bind(store);
  (store as unknown as { row: unknown }).row = (sql: string, ...params: unknown[]) => (
    sql.includes("COUNT(*)") && counted.push(sql),
    row(sql, ...params)
  );
  assert.deepEqual(
    [store.list({ limit: 50 }), store.list()].map(({ issues, total }) => [issues.length, total]),
    [
      [3, 3],
      [3, 3],
    ],
  );
  assert.deepEqual(counted, [], "a page with room to spare is the whole answer");
  assert.deepEqual(
    [store.list({ limit: 2 })].map(({ issues, total }) => [issues.length, total]),
    [[2, 3]],
  );
  assert.deepEqual(
    [store.list({ limit: 3 })].map(({ issues, total }) => [issues.length, total]),
    [[3, 3]],
  );
  assert.equal(counted.length, 2);
});

test("a list of the issues with no filter, or of one status, is read in index order, not sorted", () => {
  const { store } = fresh();
  for (const title of ["a", "b", "c"]) store.create({ title, priority: title === "b" ? 0 : 2 }, "lead");
  assert.deepEqual(
    store.list({ limit: 2 }).issues.map((issue) => issue.title),
    ["b", "a"],
  );
  store.list({ status: "open", limit: 2 });
  const sorted = store
    .plans()
    .filter(({ sql }) => sql.startsWith("SELECT * FROM issues") && sql.includes("ORDER BY priority"))
    .filter(({ plan }) => plan.includes("USE TEMP B-TREE FOR ORDER BY"));
  assert.deepEqual(sorted, []);
});

test("a call to show returns the newest few comments with a count of the rest, and comments pages back through them", () => {
  const { store } = fresh();
  const rules = { busyTimeoutMs: 5000, staleClaimMinutes: 120, close: POLICY };
  const lead = { id: "lead", owner: true };
  const issue = store.create({ title: "schema" }, "lead");
  type Shown = { comments: { text: string }[]; older_comments?: number };
  const shown = () => work(store, rules, lead, { do: "show", id: issue.id }) as Shown;
  for (let i = 1; i <= 3; i += 1) store.comment(issue.id, "p1", `comment ${i}`);
  assert.deepEqual(
    shown().comments.map((one) => one.text),
    ["comment 1", "comment 2", "comment 3"],
  );
  assert.equal(shown().older_comments, undefined);

  for (let i = 4; i <= 12; i += 1) store.comment(issue.id, "p1", `comment ${i}`);
  const few = vocabulary.commentsShown;
  assert.equal(few, 5);
  assert.deepEqual(
    shown().comments.map((one) => one.text),
    ["comment 8", "comment 9", "comment 10", "comment 11", "comment 12"],
  );
  assert.equal(shown().older_comments, 7);

  const page = (args: object) =>
    work(store, rules, lead, { do: "comments", id: issue.id, ...args }) as {
      total: number;
      skip: number;
      comments: { text: string }[];
    };
  const older = page({ skip: 5, limit: 4 });
  assert.deepEqual(
    older.comments.map((one) => one.text),
    ["comment 4", "comment 5", "comment 6", "comment 7"],
  );
  assert.deepEqual([older.total, older.skip], [12, 5]);
  assert.equal(page({ skip: 9, limit: 4 }).comments.length, 3, "the last page holds what is left");
  assert.equal(page({}).comments.length, 12, "all of them when they are fewer than the most a call returns");

  for (let i = 13; i <= vocabulary.commentsMost + 20; i += 1) store.comment(issue.id, "p1", `comment ${i}`);
  assert.equal(page({}).comments.length, vocabulary.commentsMost);
  assert.equal(page({ limit: 100000 }).comments.length, vocabulary.commentsMost);
  assert.equal(page({}).comments.at(-1)?.text, `comment ${vocabulary.commentsMost + 20}`, "the newest come first");
});

test("a work store made before the order index is brought to it when it opens, with its issues as they were", () => {
  const dir = join(ROOM_HOME, `work-test-${stores_("layout")}`);
  const earlier = join(ROOM_HOME, `work-layout-${stores_("old")}`);
  mkdirSync(earlier, { recursive: true });
  const shipped = join(ROOM_HOME, "room", "sql", "work");
  for (const name of readdirSync(shipped).filter((script) => !/^V[34]__/.test(script)))
    copyFileSync(join(shipped, name), join(earlier, name));
  new Sqlite(join(keptOutOfGit(dir), "work.db"), {
    busyTimeoutMs: TIMING.busyTimeoutMs,
    scripts: earlier,
    name: "the earlier work store",
    fail: (_code, message) => new Error(message),
  }).close();
  // the store of today writes the lease column: the issues of the older layout are written under it
  const raw = new DatabaseSync(join(dir, "work.db"));
  const insert = raw.prepare(
    "INSERT INTO issues (id, title, status, priority, issue_type, created_at, created_by, updated_at) VALUES (?, ?, 'open', ?, 'task', ?, 'lead', ?)",
  );
  for (const title of ["a", "b", "c"])
    insert.run(`sw-${title}`, title, title === "b" ? 0 : 2, "2026-10-14T09:00:00.000Z", "2026-10-14T09:00:00.000Z");
  raw.close();

  const back = new WorkStore(dir, TIMING);
  assert.deepEqual(
    back.list({ limit: 3 }).issues.map((issue) => issue.title),
    ["b", "a", "c"],
  );
  assert.match(
    back
      .plans()
      .filter(({ sql }) => sql.includes("INDEXED BY issues_by_order"))
      .map(({ plan }) => plan)
      .join(" | "),
    /SCAN issues USING INDEX issues_by_order/,
  );
  back.close();
});
