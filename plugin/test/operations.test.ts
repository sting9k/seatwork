import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Operations, OperationsRefused } from "../server/operations/index";
import { districtOf, incidentOf } from "../server/operations/lines";
import { OperationsStore } from "../server/operations/store";
import { Vitals } from "../server/operations/vitals";
import { storeStats, type StoreStat } from "../server/sqlite";

shipSql();
let homes = 0;

/** An operations district over its own folder, a policy object, a clock and a mailbox it can be read from. */
function operations(operators: string[] = ["hq-1"]) {
  const dir = join(ROOM_HOME, `operations-${(homes += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  let now = new Date("2026-10-15T00:00:00.000Z");
  const policy: Record<string, unknown> = {
    jev: { monthlyCapUsd: 10, forks: ["report"] },
    knowledge: { keepDays: 60 },
  };
  const spent = { today: 0.01 };
  const persisted: [string, unknown][] = [];
  const mailed: { to: string; subject: string; body: string }[] = [];
  const echoed: string[] = [];
  const ops = new Operations({
    dir,
    busyTimeoutMs: 1000,
    policy: () => policy,
    persist: (path, value) => persisted.push([path, value]),
    operators: () => operators,
    mail: async (to, subject, body) => mailed.push({ to, subject, body }),
    readings: { jev: () => ({ spentToday: spent.today }), knowledge: () => ({ gateNoise: 2 }) },
    echo: (line) => echoed.push(line),
    now: () => now,
  });
  const at = (iso: string) => (now = new Date(iso));
  return { ops, dir, policy, persisted, mailed, echoed, at, spent };
}

const GROUNDS = {
  reason: "The forks cap ran out before noon three days in a row.",
  evidence: "jev reading: forks spent 0.25 of 0.25 by 11:40 UTC on each of the last three days.",
};
const LOCKED = (n: number) =>
  `knowledge: the turn ${n}f2504e0-4f89-11d3-9a0c-0305e82c3301:t${n} was not kept: database is locked`;

/** The operator reads jev and its log in this turn, as a change needs. */
const readJev = (ops: Operations) => {
  ops.act("hq-1", { do: "jev" });
  ops.act("hq-1", { do: "log", district: "jev" });
};

test("a log line is read for its district, and lines that report the same fault share one incident key", () => {
  assert.equal(districtOf("knowledge: the turn peer-a:t1 was not kept: SQLITE_BUSY"), "knowledge");
  assert.equal(districtOf("fork report: nothing_new (0.95)"), "jev");
  assert.equal(districtOf("the guard failed on a claude call: timeout"), "room");
  assert.equal(districtOf("sqlite: the mail store was slow 2 times in the last minute"), "sqlite");
  assert.equal(incidentOf("fork report: nothing_new (0.95)"), null);
  assert.equal(incidentOf("gc: deleted /tmp/a/b, a handoff older than 3 days"), null);
  assert.equal(incidentOf(LOCKED(1)), incidentOf(LOCKED(2)));
  assert.equal(
    incidentOf("mail: delivery to 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed: refused"),
    incidentOf("mail: delivery to 9b2504e0-4f89-11d3-9a0c-0305e82c3302 failed: refused"),
  );
  assert.notEqual(
    incidentOf("mail: delivery to a failed: refused"),
    incidentOf("knowledge: the mail of /x/y was not read: refused"),
  );
});

const LATE = (title: string, seconds: number) =>
  `room: its own seat could not be kept: Error: Paseo did not answer the start of "${title}" within ${seconds} seconds`;
const ONE_FAULT: [string, string][] = [
  [LATE("[Peer] parser fixed", 60), LATE("[Lead] build mdlinks as the mission says", 90)],
  [LATE("[HQ] the room's operator", 60), LATE("[peer:review] mdlinks v1: CLI, checker, tests (sw-2qu)", 60)],
  [
    'mail: delivery to "3f2504e0-4f89-11d3-9a0c-0305e82c3301" failed: refused',
    'mail: delivery to "9b2504e0-4f89-11d3-9a0c-0305e82c3302" failed: refused',
  ],
  [
    "work: the leases of /p could not be read: ENOENT: no such file or directory, open '/p/.seatwork/leases.json'",
    "work: the leases of /q/r could not be read: ENOENT: no such file or directory, open '/q/r/.seatwork/leases.json'",
  ],
  [
    'knowledge: the turn at "2026-10-14T09:00:00.123Z" was not kept: database is locked',
    'knowledge: the turn at "2026-10-15T23:59:59Z" was not kept: database is locked',
  ],
  [
    "mail: no ask was chosen for #12 after '3' tries: refused",
    "mail: no ask was chosen for #345 after '17' tries: refused",
  ],
  [
    `the guard failed on a claude call: Unexpected token 'o', "not json at all" is not valid JSON`,
    `the guard failed on a claude call: Unexpected token 'h', "half a body here" is not valid JSON`,
  ],
  [
    'skills: the project "/a" has its own "test-audit", rename one: failed',
    'skills: the project "/b" has its own "seat-law", rename one: failed',
  ],
];
const TWO_FAULTS: [string, string][] = [
  ['the guard failed on a codex call: "refused"', 'the guard failed on a codex call: "timeout"'],
  ["gc: could not delete it: 'EACCES'", "gc: could not delete it: 'EBUSY'"],
  ["mail: the store failed: `SQLITE_BUSY`", "mail: the store failed: `SQLITE_CORRUPT`"],
  [
    "the guard's notice was not sent: Cannot read properties of undefined (reading 'map')",
    "the guard's hook was not read: Cannot read properties of undefined (reading 'map')",
  ],
  [
    "work: the leases could not be read: Cannot read properties of undefined (reading 'map')",
    "work: the leases could not be read: Cannot read properties of undefined (reading 'filter')",
  ],
];

test("a quoted fault word stays in the incident key, while quoted seat titles, ids, paths, times, numbers and texts are made alike", () => {
  for (const [a, b] of ONE_FAULT) {
    assert.notEqual(incidentOf(a), null, a);
    assert.equal(incidentOf(a), incidentOf(b), `${a} / ${b}`);
  }
  for (const [a, b] of TWO_FAULTS) {
    assert.notEqual(incidentOf(a), null, a);
    assert.notEqual(incidentOf(a), incidentOf(b), `${a} / ${b}`);
  }
});

test("incidents reach the operator in one mail at most every few minutes, again only when seen since and after an hour", async () => {
  const { ops, mailed, echoed, at } = operations();
  ops.log(LOCKED(1));
  ops.log(LOCKED(2));
  ops.log("fork report: nothing_new (0.95)");
  assert.equal(echoed.length, 3, "every line still reaches the app's log");
  await ops.tick();
  assert.equal(mailed.length, 1);
  assert.match(mailed[0].subject, /^INCIDENT: 1 in knowledge$/);
  assert.match(mailed[0].body, /#1 \[knowledge\] .*was not kept: database is locked \(2x, 2 in the last hour/);
  at("2026-10-15T00:20:00.000Z");
  ops.log(LOCKED(3));
  await ops.tick();
  assert.equal(mailed.length, 1, "seen again within the hour: not told again yet");
  at("2026-10-15T01:20:00.000Z");
  await ops.tick();
  assert.equal(mailed.length, 2);
  assert.match(mailed[1].body, /\(3x/);
  at("2026-10-15T03:00:00.000Z");
  await ops.tick();
  assert.equal(mailed.length, 2, "not seen since: told once is enough");
  ops.close();
});

test("an acknowledged incident is told again only when it comes twice as often; a snoozed one when its hours are up", async () => {
  const { ops, mailed, at } = operations();
  ops.log(LOCKED(1));
  await ops.tick();
  ops.act("hq-1", { do: "ack", id: 1, note: "Known: the backup job locks the store each night for a minute." });
  at("2026-10-15T01:30:00.000Z");
  ops.log(LOCKED(2));
  await ops.tick();
  assert.equal(mailed.length, 1, "as often as when it was acknowledged: not told");
  for (let i = 3; i < 6; i += 1) ops.log(LOCKED(i));
  at("2026-10-15T01:50:00.000Z");
  await ops.tick();
  assert.equal(mailed.length, 2, "four in the hour against one when acknowledged: told again");
  assert.match(mailed[1].body, /4 in the last hour[^\n]*, acknowledged: Known/, "it says what it was acknowledged for");
  assert.doesNotMatch(
    (ops.act("hq-1", { do: "incidents" }).incidents as string[])[0],
    /acknowledged/,
    "told again, it is open",
  );
  assert.throws(
    () => ops.act("hq-1", { do: "snooze", id: 1, hours: 100, note: "Waiting for the fix to ship." }),
    /at most 72/,
  );
  ops.act("hq-1", { do: "snooze", id: 1, hours: 2, note: "Waiting for the fix to ship tonight." });
  at("2026-10-15T03:00:00.000Z");
  ops.log(LOCKED(6));
  await ops.tick();
  assert.equal(mailed.length, 2, "snoozed: not told");
  at("2026-10-15T04:10:00.000Z");
  await ops.tick();
  assert.equal(mailed.length, 3, "its hours are up and it was seen meanwhile");
  ops.close();
});

test("a resolved incident seen again opens as back and is told at once", async () => {
  const { ops, mailed, at } = operations();
  ops.log(LOCKED(1));
  await ops.tick();
  assert.throws(() => ops.act("hq-1", { do: "resolve", id: 1, note: "ok" }), /note \(the cause\): say it/);
  ops.act("hq-1", { do: "resolve", id: 1, note: "The knowledge gate's busy timeout was raised to five seconds." });
  at("2026-10-15T00:20:00.000Z");
  ops.log(LOCKED(2));
  await ops.tick();
  assert.equal(mailed.length, 2);
  assert.match(mailed[1].body, /#1 .*, back after it was resolved/);
  assert.throws(() => ops.act("hq-1", { do: "ack", id: 99, note: "No such incident at all." }), /no incident #99/);
  ops.close();
});

test("with no operator nothing is mailed and nothing is lost; the digest comes once a day", async () => {
  const none = operations([]);
  none.ops.log("mail: delivery to x failed: refused");
  await none.ops.tick();
  assert.equal(none.mailed.length, 0);
  none.ops.close();
  const { ops, mailed, at } = operations();
  await ops.tick();
  at("2026-10-16T00:00:00.000Z");
  await ops.tick();
  assert.deepEqual(
    mailed.map((one) => one.subject),
    ["DIGEST: the room in the last day"],
  );
  assert.match(mailed[0].body, /jev: \{"spentToday":0.01\}/);
  ops.close();
});

test("a tune rests on a reading and the log of its district in the same turn, stays in range, and can be reverted while nothing changed it since", () => {
  const { ops, policy, persisted } = operations();
  const tune = { do: "tune", path: "jev.dailyCapUsd.forks", value: 0.5, ...GROUNDS };
  assert.throws(() => ops.act("hq-1", tune), /read jev in this turn first/);
  ops.act("hq-1", { do: "jev" });
  assert.throws(() => ops.act("hq-1", tune), /read the log of jev in this turn too/);
  ops.act("hq-1", { do: "log", district: "jev" });
  assert.throws(() => ops.act("hq-1", { ...tune, value: 50 }), /from 0 to 10/);
  assert.throws(() => ops.act("hq-1", { ...tune, path: "safety.guard" }), /not one the room tunes on its own/);
  assert.throws(() => ops.act("hq-1", { ...tune, evidence: "đã đo rồi, ổn" }), /evidence: (say it|in English)/);
  const done = ops.act("hq-1", tune);
  assert.deepEqual((policy.jev as { dailyCapUsd: object }).dailyCapUsd, { forks: 0.5 });
  assert.deepEqual(persisted, [["jev.dailyCapUsd.forks", 0.5]]);
  assert.match(String(done.line), /jev\.dailyCapUsd\.forks: unset -> 0\.5/);
  assert.equal(done.baseline, '{"spentToday":0.01}', "the district's reading is kept with the change");
  ops.turnStarted("hq-1");
  assert.throws(() => ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS }), /read jev in this turn first/);
  ops.act("hq-1", { do: "jev" });
  ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS });
  assert.equal((policy.jev as { dailyCapUsd: Record<string, unknown> }).dailyCapUsd.forks, undefined);
  assert.deepEqual(persisted.at(-1), ["jev.dailyCapUsd.forks", undefined]);
  assert.throws(() => ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS }), /changed again after #1/);
  assert.throws(
    () => ops.act("hq-1", { do: "tune", path: "jev.forks", value: ["report", "nope"], ...GROUNDS }),
    /among report/,
  );
  assert.throws(() => ops.act("hq-1", { do: "nothing" }), OperationsRefused);
  assert.match((ops.act("hq-1", { do: "policy" }).changes as string[])[0], /reverts #1/);
  ops.close();
});

test("the digest weighs each change still standing against its baseline; a key reverted twice needs evidence that answers why", async () => {
  const { ops, mailed, at, spent } = operations();
  readJev(ops);
  const tune = { do: "tune", path: "jev.monthlyCapUsd", ...GROUNDS };
  for (const value of [12, 14]) {
    const done = ops.act("hq-1", { ...tune, value });
    ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS });
  }
  assert.throws(() => ops.act("hq-1", { ...tune, value: 16 }), /reverted 2 times in 30 days: #\d+ .*revisit true/);
  ops.act("hq-1", { ...tune, value: 16, revisit: true });
  spent.today = 0.09;
  at("2026-10-16T00:00:00.000Z");
  await ops.tick();
  assert.match(
    mailed.at(-1)!.body,
    /jev\.monthlyCapUsd: 10 -> 16[^\n]*\n {2}then: \{"spentToday":0\.01\}\n {2}now: \{"spentToday":0\.09\}/,
  );
  ops.close();
});

test("a trace keeps its hypothesis and what it learned; after three undone changes it sends the operator to its Owner", () => {
  const { ops } = operations();
  ops.log(LOCKED(1));
  const opened = ops.act("hq-1", {
    do: "trace",
    incident: 1,
    hypothesis: "The gate writes while the mail reader holds the lock.",
  });
  ops.act("hq-1", {
    do: "trace",
    id: opened.id,
    kind: "evidence",
    text: "The log shows the lock at each minute's pass.",
  });
  ops.act("hq-1", {
    do: "trace",
    id: opened.id,
    kind: "hypothesis",
    text: "The minute's pass and the GC run at the same moment.",
  });
  readJev(ops);
  for (const value of [11, 12, 13]) {
    const done = ops.act("hq-1", {
      do: "tune",
      path: "jev.monthlyCapUsd",
      value,
      trace: opened.id,
      revisit: true,
      ...GROUNDS,
    });
    ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS });
  }
  const [trace] = ops.act("hq-1", { do: "traces" }).traces as Record<string, unknown>[];
  assert.equal(trace.hypothesis, "The minute's pass and the GC run at the same moment.");
  assert.deepEqual(trace.notes, [
    "evidence: The log shows the lock at each minute's pass.",
    "hypothesis: The minute's pass and the GC run at the same moment.",
  ]);
  assert.equal(trace.undone, 3);
  assert.match(String(trace.next), /Write your Owner the trace/);
  assert.throws(
    () =>
      ops.act("hq-1", { do: "tune", path: "jev.monthlyCapUsd", value: 9, trace: opened.id, revisit: true, ...GROUNDS }),
    /write your Owner the trace instead/,
  );
  ops.act("hq-1", { do: "close", id: opened.id, conclusion: "The fault is in the code; the trace went to the Owner." });
  assert.deepEqual(ops.act("hq-1", { do: "traces" }).traces, []);
  assert.throws(
    () => ops.act("hq-1", { do: "close", id: opened.id, conclusion: "Closing it a second time." }),
    /is closed/,
  );
  ops.close();
});

test("an open trace nobody touched for the log's days is closed by the room with its reason, then goes like a closed one; a noted or tuned trace stays", () => {
  const { ops, dir, at } = operations();
  const open = (hypothesis: string) => ops.act("hq-1", { do: "trace", hypothesis }).id as number;
  at("2026-10-15T00:00:00.000Z");
  const idle = open("Nobody looked at this hypothesis after it was written.");
  const noted = open("A hypothesis that gets a note two days in.");
  const tuned = open("A hypothesis that a change is made for two days in.");
  at("2026-10-17T00:00:00.000Z");
  ops.act("hq-1", { do: "trace", id: noted, kind: "evidence", text: "The log shows the lock at each minute's pass." });
  readJev(ops);
  ops.act("hq-1", { do: "tune", path: "jev.monthlyCapUsd", value: 11, trace: tuned, ...GROUNDS });

  at("2026-10-18T01:00:00.000Z");
  ops.expire();
  const openIds = () => (ops.act("hq-1", { do: "traces" }).traces as { id: number }[]).map((one) => one.id);
  assert.deepEqual(openIds(), [noted, tuned]);
  assert.throws(() => ops.act("hq-1", { do: "close", id: idle, conclusion: "Closing it a second time." }), /is closed/);
  const file = new DatabaseSync(join(dir, "operations.db"), { readOnly: true });
  const left = file.prepare("SELECT conclusion FROM traces WHERE id = ?").get(idle) as { conclusion: string };
  file.close();
  assert.match(left.conclusion, /Left open for 3 days with no note and no change/);

  // a month on, the room's closed trace is gone as any closed one; the two touched ones have gone idle in their turn
  at("2026-11-18T00:00:00.000Z");
  ops.expire();
  assert.deepEqual(openIds(), []);
  assert.throws(
    () => ops.act("hq-1", { do: "trace", id: idle, kind: "evidence", text: "Looking at it after it went." }),
    new RegExp(`no trace #${idle} is open`),
  );
  ops.close();
});

test("reading the open traces costs the same statements however many are open, and shows each its newest twelve notes", () => {
  const calls = (dir: string) => storeStats().find((one) => one.file === join(dir, "operations.db"))!.calls;
  const measure = (traces: number) => {
    const { ops, dir } = operations();
    for (let i = 0; i < traces; i += 1) {
      const id = ops.act("hq-1", { do: "trace", hypothesis: `Hypothesis number ${i} of the same incident.` }).id;
      for (let note = 1; note <= 14; note += 1)
        ops.act("hq-1", { do: "trace", id, kind: "evidence", text: `Evidence ${note} of trace number ${i}.` });
    }
    const before = calls(dir);
    const listed = ops.act("hq-1", { do: "traces" }).traces as { notes: string[] }[];
    const used = calls(dir) - before;
    ops.close();
    return { listed, used };
  };
  const few = measure(2);
  const many = measure(30);
  assert.deepEqual([few.listed.length, many.listed.length], [2, 30]);
  assert.equal(many.used, few.used);
  for (const [i, one] of many.listed.entries()) {
    assert.equal(one.notes.length, 12);
    assert.deepEqual(
      [one.notes[0], one.notes.at(-1)],
      [`evidence: Evidence 3 of trace number ${i}.`, `evidence: Evidence 14 of trace number ${i}.`],
    );
  }
});

test("the log keeps its days and its size; incidents not seen within the days and old closed traces go", () => {
  const dir = join(ROOM_HOME, "operations-expire");
  rmSync(dir, { recursive: true, force: true });
  let now = new Date("2026-10-01T00:00:00.000Z");
  const store = new OperationsStore(dir, 1000, () => now);
  store.record("mail", "mail: delivery to x failed", "mail|old");
  const trace = store.openTrace("hq-1", null, "An old hypothesis that was settled.");
  store.closeTrace(trace.id, "Settled long ago.");
  now = new Date("2026-10-10T00:00:00.000Z");
  for (let i = 0; i < 8; i += 1) store.record("gc", `gc: deleted ${i}`, null);
  assert.equal(
    store.expire(new Date("2026-10-05T00:00:00.000Z"), 5, new Date("2026-10-05T00:00:00.000Z")),
    1 + 3 + 1 + 1,
  );
  assert.deepEqual(
    store.lines({}, 10).map((one) => one.line),
    ["gc: deleted 7", "gc: deleted 6", "gc: deleted 5", "gc: deleted 4", "gc: deleted 3"],
  );
  assert.deepEqual(store.incidents("2000-01-01", 10), []);
  assert.equal(store.trace(trace.id), null);
  assert.deepEqual(store.lines({ district: "gc", words: "DELETED 7" }, 10).length, 1);
  store.close();
});

test("every statement of the log, the incidents, the tunes and the traces reads by an index, but the two named here with their reason", () => {
  const dir = join(ROOM_HOME, "operations-plans");
  rmSync(dir, { recursive: true, force: true });
  const store = new OperationsStore(dir, 1000);
  store.record("mail", "mail: delivery to x failed", "mail|x");
  store.record("gc", "gc: deleted 1", null);
  store.lines({ district: "mail", since: "2026-10-01", words: "failed" }, 5);
  store.lines({ since: "2026-10-01" }, 5);
  store.incident(1);
  store.incidents("2026-10-01", 10);
  store.untold("2026-10-16T09:00:00.000Z", 10);
  store.told([1]);
  store.setState(1, "acknowledged", "seen");
  store.unasked(5);
  store.setKinds([[1, "code"]]);
  const trace = store.openTrace("hq-1", 1, "The store is locked by a long write.");
  store.addNote(trace.id, "evidence", "the lock lasts five seconds");
  const tune = store.addTune({
    seat: "hq-1",
    path: "room.work.busyTimeoutMs",
    before: "5000",
    after: "8000",
    reason: "locked writes",
    evidence: "five-second locks",
    baseline: "{}",
    trace: trace.id,
    reverts: null,
  });
  store.tune(tune.id);
  store.tunes(10);
  store.standing("2026-10-01");
  store.revertsOf("room.work.busyTimeoutMs", "2026-10-01");
  store.trace(trace.id);
  store.openTraces();
  store.closeIdleTraces(new Date("2026-10-01T00:00:00.000Z"), "left open and untouched");
  store.closeTrace(trace.id, "the timeout was raised");
  store.expire(new Date("2026-10-01T00:00:00.000Z"), 5, new Date("2026-10-01T00:00:00.000Z"));
  // newest first to their limit: the log of all districts, and the tunes
  const whole = [
    "SELECT at, district, line FROM log WHERE at >=",
    "SELECT id, at, seat, path, before, after, reason, evidence, baseline, trace, reverts FROM tunes ORDER BY id DESC",
  ];
  const scans = store
    .plans()
    .map(({ sql, plan }) => ({ sql: sql.replace(/\s+/g, " ").trim(), plan }))
    .filter(({ plan }) => /\bSCAN (log|incidents|i|tunes|t|traces|trace_notes)\b(?! USING)/.test(plan))
    .filter(({ sql }) => !whole.some((known) => sql.startsWith(known)));
  assert.deepEqual(scans, []);
  store.close();
});

test("a district whose store cannot open lets go of the vitals it was given", () => {
  const blocker = join(ROOM_HOME, "operations-blocker");
  writeFileSync(blocker, "");
  const vitals = new Vitals();
  const close = vitals.close.bind(vitals);
  let closed = 0;
  vitals.close = () => {
    closed += 1;
    close();
  };
  assert.throws(
    () =>
      new Operations({
        dir: join(blocker, "store"),
        busyTimeoutMs: 1000,
        policy: () => ({}),
        persist() {},
        operators: () => [],
        mail: async () => {},
        readings: {},
        echo() {},
        vitals,
      }),
    /ENOTDIR/,
  );
  assert.equal(closed, 1);
  close();
});

test("a measure whose low point keeps rising is told once a window; one that rises and falls back is not", () => {
  const MB = 1024 * 1024;
  let minute = 0;
  // the heap climbs and drops back as it is collected: one low point rises with it, the other stays
  const heap = () => (minute % 5 === 0 ? 200 : 260) + 2 * minute;
  const rss = () => (minute % 5 === 0 ? 400 : 550);
  const vitals = new Vitals(
    () => [],
    () => ({ "mail waiting": 3 }),
    () => ({ heapUsed: heap() * MB, rss: rss() * MB }),
  );
  const told: string[] = [];
  for (minute = 0; minute < 120; minute += 1) told.push(...vitals.minute().map((line) => `${minute} ${line}`));
  assert.deepEqual(told, [
    "59 room: room heap MB did not come down in the last 60 minutes: its low point rose from 200 to 290",
    "119 room: room heap MB did not come down in the last 60 minutes: its low point rose from 320 to 410",
  ]);
  assert.ok(
    told.every((line) => incidentOf(line.replace(/^\d+ /, "")) !== null),
    "each is trouble the operator hears of",
  );
  const trend = vitals.reading().trend as {
    name: string;
    now: number;
    change10: number | null;
    change60: number | null;
  }[];
  assert.deepEqual(
    trend.find((one) => one.name === "room heap MB"),
    { name: "room heap MB", now: 498, change10: 20, change60: 120, minutes: 120 },
  );
  assert.deepEqual(trend.find((one) => one.name === "mail waiting")?.change60, 0);
  vitals.close();
});

test("the vital signs say a store's new slow statements, a large write-ahead log, and an event loop held up", async () => {
  const stats: StoreStat[] = [
    {
      name: "the mail store",
      file: "/m.db",
      calls: 10,
      slow: 0,
      slowestMs: 40,
      slowest: "SELECT 1",
      walBytes: 0,
      fileBytes: 0,
    },
  ];
  const vitals = new Vitals(() => stats);
  assert.deepEqual(
    vitals.minute().filter((line) => line.startsWith("sqlite")),
    [],
  );
  stats[0] = { ...stats[0], slow: 2, slowestMs: 812, slowest: "DELETE FROM messages", walBytes: 80 * 1024 * 1024 };
  const lines = vitals.minute().filter((line) => line.startsWith("sqlite"));
  assert.match(lines[0], /^sqlite: the mail store was slow 2 times in the last minute, its slowest so far 812 ms/);
  assert.match(lines[1], /write-ahead log of 80 MB not checkpointed/);
  assert.ok(
    lines.every((line) => incidentOf(line) !== null),
    "each is trouble the operator hears of",
  );
  const until = Date.now() + 300;
  while (Date.now() < until);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(vitals.minute().some((line) => /event loop was slow, held up to \d+ ms/.test(line)));
  assert.equal((vitals.reading().stores as unknown[]).length, 1);
  vitals.close();
});
