import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Operations, OperationsRefused } from "../server/operations/index";
import { districtOf, incidentOf } from "../server/operations/lines";
import { OperationsStore } from "../server/operations/store";

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
    readings: { jev: () => ({ spentToday: 0.01 }), knowledge: () => ({ gateNoise: 2 }) },
    echo: (line) => echoed.push(line),
    now: () => now,
  });
  const at = (iso: string) => (now = new Date(iso));
  return { ops, policy, persisted, mailed, echoed, at };
}

const GROUNDS = {
  reason: "The forks cap ran out before noon three days in a row.",
  evidence: "jev reading: forks spent 0.25 of 0.25 by 11:40 UTC on each of the last three days.",
};

test("a log line is read for its district, and lines that report the same fault share one incident key", () => {
  assert.equal(districtOf("knowledge: the turn peer-a:t1 was not kept: SQLITE_BUSY"), "knowledge");
  assert.equal(districtOf("fork report: nothing_new (0.95)"), "jev");
  assert.equal(districtOf("the guard failed on a claude call: timeout"), "room");
  assert.equal(incidentOf("fork report: nothing_new (0.95)"), null);
  assert.equal(incidentOf("gc: deleted /tmp/a/b, a handoff older than 3 days"), null);
  assert.equal(
    incidentOf("knowledge: the turn 3f2504e0-4f89-11d3-9a0c-0305e82c3301:t1 was not kept: database is locked"),
    incidentOf("knowledge: the turn 9b2504e0-4f89-11d3-9a0c-0305e82c3302:t7 was not kept: database is locked"),
  );
  assert.equal(
    incidentOf("mail: delivery to 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed: refused"),
    incidentOf("mail: delivery to 9b2504e0-4f89-11d3-9a0c-0305e82c3302 failed: refused"),
  );
  assert.notEqual(
    incidentOf("mail: delivery to a failed: refused"),
    incidentOf("knowledge: the mail of /x/y was not read: refused"),
  );
});

test("incidents reach the operator in one mail at most every few minutes, again only when seen since and after an hour", async () => {
  const { ops, mailed, echoed, at } = operations();
  ops.log("knowledge: the turn 3f2504e0-4f89-11d3-9a0c-0305e82c3301:t1 was not kept: database is locked");
  ops.log("knowledge: the turn 9b2504e0-4f89-11d3-9a0c-0305e82c3302:t7 was not kept: database is locked");
  ops.log("fork report: nothing_new (0.95)");
  assert.equal(echoed.length, 3, "every line still reaches the app's log");
  await ops.tick();
  assert.equal(mailed.length, 1);
  assert.match(mailed[0].subject, /^INCIDENT: 1 in knowledge$/);
  assert.match(mailed[0].body, /was not kept: database is locked \(2x/);
  at("2026-10-15T00:20:00.000Z");
  ops.log("knowledge: the turn 1c2504e0-4f89-11d3-9a0c-0305e82c3303:t2 was not kept: database is locked");
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

test("a tune rests on a reading of its district in the same turn, stays in range, and can be reverted while nothing changed it since", () => {
  const { ops, policy, persisted } = operations();
  const tune = { do: "tune", path: "jev.dailyCapUsd.forks", value: 0.5, ...GROUNDS };
  assert.throws(() => ops.act("hq-1", tune), /read jev in this turn first/);
  ops.act("hq-1", { do: "jev" });
  assert.throws(() => ops.act("hq-1", { ...tune, value: 50 }), /from 0 to 10/);
  assert.throws(() => ops.act("hq-1", { ...tune, path: "safety.guard" }), /not one the room tunes on its own/);
  assert.throws(() => ops.act("hq-1", { ...tune, evidence: "đã đo rồi, ổn" }), /evidence: (say it|in English)/);
  const done = ops.act("hq-1", tune);
  assert.deepEqual((policy.jev as { dailyCapUsd: object }).dailyCapUsd, { forks: 0.5 });
  assert.deepEqual(persisted, [["jev.dailyCapUsd.forks", 0.5]]);
  assert.match(String(done.line), /jev\.dailyCapUsd\.forks: unset -> 0\.5/);
  ops.turnStarted("hq-1");
  assert.throws(() => ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS }), /read jev in this turn first/);
  ops.act("hq-1", { do: "log", district: "jev" });
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

test("the log keeps its days and its size; incidents not seen within the days go", () => {
  const dir = join(ROOM_HOME, "operations-expire");
  rmSync(dir, { recursive: true, force: true });
  let now = new Date("2026-10-01T00:00:00.000Z");
  const store = new OperationsStore(dir, 1000, () => now);
  store.record("mail", "mail: delivery to x failed", "mail|old");
  now = new Date("2026-10-10T00:00:00.000Z");
  for (let i = 0; i < 8; i += 1) store.record("gc", `gc: deleted ${i}`, null);
  assert.equal(store.expire(new Date("2026-10-05T00:00:00.000Z"), 5), 1 + 3 + 1);
  assert.deepEqual(
    store.lines({}, 10).map((one) => one.line),
    ["gc: deleted 7", "gc: deleted 6", "gc: deleted 5", "gc: deleted 4", "gc: deleted 3"],
  );
  assert.deepEqual(store.incidents("2000-01-01", 10), []);
  assert.deepEqual(store.lines({ district: "gc", words: "DELETED 7" }, 10).length, 1);
  store.close();
});
