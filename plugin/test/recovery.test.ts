import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { classify, Recovery, resumeDue, type Resumes } from "../server/orchestration/recovery";
import { Rounds } from "../server/orchestration/rounds";

const POLICY = { delaysSeconds: [30, 60, 120], limitedMinutes: 10, limitedMaxHours: 6 };
const T0 = Date.parse("2026-10-14T09:00:00");
let files = 0;
const fresh = () => join(ROOM_HOME, `recovery-test-${(files += 1)}.json`);

test("a failure is read by what the service said: a quota with the time it lifts, an account problem, or anything else", () => {
  assert.deepEqual(classify("API Error: 529 Overloaded", T0), { kind: "service" });
  assert.deepEqual(classify("socket hang up", T0), { kind: "service" });
  assert.deepEqual(classify("Invalid API key · Please run /login", T0), { kind: "fatal" });
  assert.deepEqual(classify("Prompt is too long", T0), { kind: "fatal" });
  assert.deepEqual(classify("rate_limit_error: try again in 5 minutes", T0), {
    kind: "limited",
    liftsAt: T0 + 300_000,
  });
  assert.deepEqual(classify("HTTP status 429, retry-after: 20", T0), { kind: "limited", liftsAt: T0 + 20_000 });
  // a retry-after that holds a time, not seconds: the time when it is near, else nothing the room can read
  assert.equal(classify(`HTTP status 429, retry-after: ${(T0 + 600_000) / 1000}`, T0).liftsAt, T0 + 600_000);
  assert.equal(classify("HTTP status 429, retry-after: 99999999999", T0).liftsAt, undefined);
  assert.deepEqual(classify("You've hit your usage limit. Your limit will reset at 2:30pm", T0), {
    kind: "limited",
    liftsAt: Date.parse("2026-10-14T14:30:00"),
  });
  // a clock time already past is tomorrow's; a commit id that holds 429 is no quota
  assert.equal(classify("usage limit reached · resets 8am", T0).liftsAt, Date.parse("2026-10-15T08:00:00"));
  assert.equal(classify("merge of 4f429ab failed", T0).kind, "service");
});

test("a service error is tried again after each delay, then given up; a finished turn starts the count again", () => {
  const recovery = new Recovery(fresh(), POLICY);
  const fail = (at: number) => recovery.failed("p1", "529 Overloaded", at);
  assert.deepEqual(fail(T0), {
    retry: { agentId: "p1", at: T0 + 30_000, attempt: 1, of: 3, kind: "service", message: "529 Overloaded" },
  });
  assert.equal((fail(T0) as { retry: { at: number } }).retry.at, T0 + 60_000);
  assert.equal((fail(T0) as { retry: { at: number } }).retry.at, T0 + 120_000);
  assert.deepEqual(fail(T0), { gaveUpAfter: 3, kind: "service" });
  // given up: the next failure of that seat starts at the first delay
  assert.equal((fail(T0) as { retry: { attempt: number } }).retry.attempt, 1);
  recovery.forget("p1");
  assert.equal(recovery.pending("p1"), undefined);
  assert.deepEqual(recovery.failed("p1", "not logged in", T0), { gaveUpAfter: 0, kind: "fatal" });
});

test("a quota is waited out without using a try, for so many hours at most", () => {
  const recovery = new Recovery(fresh(), POLICY);
  const first = recovery.failed("p1", "usage limit reached, resets in 2 h", T0) as {
    retry: { at: number; attempt: number };
  };
  assert.deepEqual([first.retry.at, first.retry.attempt], [T0 + 2 * 3_600_000, 0]);
  // no time named: the room looks again after its own wait
  const again = recovery.failed("p1", "rate limit exceeded", T0 + 2 * 3_600_000) as { retry: { at: number } };
  assert.equal(again.retry.at, T0 + 2 * 3_600_000 + 600_000);
  // a lift later than the longest wait is cut to it, and past it the Owner is told
  const late = recovery.failed("p1", "usage limit reached, resets in 9 h", T0 + 3 * 3_600_000) as {
    retry: { at: number };
  };
  assert.equal(late.retry.at, T0 + 6 * 3_600_000);
  assert.deepEqual(recovery.failed("p1", "rate limit exceeded", T0 + 6 * 3_600_000), {
    gaveUpAfter: 0,
    kind: "limited",
  });
});

test("a failure the room's own words miss is taken as the kind the model was sure of", () => {
  const recovery = new Recovery(fresh(), POLICY);
  const words = "Error: overloaded_error: the account's weekly allowance is spent";
  assert.equal((recovery.failed("p1", words, T0) as { retry: { kind: string } }).retry.kind, "service");
  const read = recovery.failed("p2", words, T0, "limited") as { retry: { kind: string; at: number; attempt: number } };
  assert.deepEqual([read.retry.kind, read.retry.at, read.retry.attempt], ["limited", T0 + 600_000, 0]);
  assert.deepEqual(recovery.failed("p3", words, T0, "fatal"), { gaveUpAfter: 0, kind: "fatal" });
});

test("a retry that has come due starts the seat again once, and only a seat still at rest; the list survives a restart", async () => {
  const file = fresh();
  new Recovery(file, POLICY).failed("p1", "529 Overloaded", T0);
  new Recovery(file, POLICY).failed("p2", "529 Overloaded", T0);
  const recovery = new Recovery(file, POLICY);
  recovery.failed("p3", "529 Overloaded", T0);
  const sent: { to: string; body: string }[] = [];
  const state: Record<string, "idle" | "running" | "unknown"> = { p1: "idle", p2: "running", p3: "unknown" };
  const mail: Resumes = {
    recipientStatus: async (id) => state[id],
    post: async (posted) => void sent.push({ to: posted.to, body: posted.body }),
  };
  await resumeDue(recovery, mail, T0 + 10_000);
  assert.equal(sent.length, 0);
  await resumeDue(recovery, mail, T0 + 30_000);
  assert.deepEqual(
    sent.map((one) => one.to),
    ["p1"],
  );
  assert.match(
    sent[0].body,
    /error of the model service, not on your work \("529 Overloaded"\).* This is try 1 of 3\.$/,
  );
  // the seat someone else started is left alone; the one the daemon could not show is asked about again
  assert.equal(recovery.pending("p2"), undefined);
  assert.equal(recovery.pending("p3")?.at, T0 + 90_000);
  await resumeDue(recovery, mail, T0 + 30_000);
  assert.equal(sent.length, 1);
});

test("a room home an earlier version wrote names no recovery: every failure goes to the Owner", () => {
  assert.deepEqual(new Recovery(fresh(), undefined).failed("p1", "529 Overloaded", T0), {
    gaveUpAfter: 0,
    kind: "service",
  });
});

test("a retry whose post fails is tried again later; the ones after it are not lost", async () => {
  const file = join(ROOM_HOME, "recovery-batch.json");
  const recovery = new Recovery(file, POLICY);
  for (const seat of ["p1", "p2"]) recovery.failed(seat, "socket hang up", 0);
  const sent: string[] = [];
  const mail: Resumes = {
    recipientStatus: async () => "idle",
    post: async (input) => {
      if (input.to === "p1") throw new Error("store busy");
      sent.push(input.to);
    },
  };
  await resumeDue(recovery, mail, 60_000);
  assert.deepEqual(sent, ["p2"]);
  assert.ok(recovery.pending("p1"), "p1 waits for its next try");
});

test("the rounds ledger is kept on disk: a plugin that starts again knows the count", () => {
  const file = join(ROOM_HOME, "rounds-ledger.json");
  const rounds = new Rounds(file);
  rounds.handedIn("sw-k3f");
  rounds.answered("sw-k3f", "REJECT");
  assert.equal(new Rounds(file).rejected("sw-k3f"), 1);
});

test("a retry that cannot be carried out waits twice as long each time, up to a ceiling, and is logged each time", async () => {
  const recovery = new Recovery(fresh(), POLICY);
  recovery.failed("p1", "socket hang up", T0);
  const mail: Resumes = {
    recipientStatus: async () => "idle",
    post: async () => {
      throw new Error("store busy");
    },
  };
  const lines: string[] = [];
  let now = T0 + 30_000;
  const waits: number[] = [];
  for (let miss = 0; miss < 8; miss += 1) {
    await resumeDue(recovery, mail, now, (line) => lines.push(line));
    const at = recovery.pending("p1")!.at;
    waits.push((at - now) / 1000);
    now = at;
  }
  assert.deepEqual(waits, [60, 120, 240, 480, 960, 1800, 1800, 1800]);
  assert.equal(lines.length, 8);
  assert.match(lines[0], /p1.*store busy/);
});

test("a seat the daemon cannot place is asked about again at growing intervals", async () => {
  const recovery = new Recovery(fresh(), POLICY);
  recovery.failed("p1", "socket hang up", T0);
  const mail: Resumes = { recipientStatus: async () => "unknown", post: async () => {} };
  let now = T0 + 30_000;
  const waits: number[] = [];
  for (let miss = 0; miss < 3; miss += 1) {
    await resumeDue(recovery, mail, now);
    const at = recovery.pending("p1")!.at;
    waits.push((at - now) / 1000);
    now = at;
  }
  assert.deepEqual(waits, [60, 120, 240]);
});

test("the rounds of a task nobody finished age out with the other records; a task touched since stays", () => {
  const file = join(ROOM_HOME, "rounds-expire.json");
  mock.timers.enable({ apis: ["Date"], now: T0 });
  try {
    const rounds = new Rounds(file);
    rounds.handedIn("old-task");
    mock.timers.tick(4 * 86_400_000);
    rounds.handedIn("recent-task");
    mock.timers.tick(86_400_000);
    assert.equal(rounds.expire(new Date(Date.now() - 3 * 86_400_000)), 1);
    assert.equal(rounds.rejected("old-task"), 0);
    assert.equal(new Rounds(file).expire(new Date(Date.now() - 3 * 86_400_000)), 0, "the file was rewritten");
    // a rejection counts as touching the task
    rounds.answered("recent-task", "REJECT");
    mock.timers.tick(2 * 86_400_000);
    assert.equal(rounds.expire(new Date(Date.now() - 3 * 86_400_000)), 0);
    assert.equal(rounds.rejected("recent-task"), 1);
    // rounds an older version kept have no date: they start their keep when the file is read
    writeFileSync(join(ROOM_HOME, "rounds-legacy.json"), JSON.stringify({ "sw-old": { pending: true, rejected: 2 } }));
    const legacy = new Rounds(join(ROOM_HOME, "rounds-legacy.json"));
    assert.equal(legacy.expire(new Date(Date.now() - 1000)), 0);
    mock.timers.tick(4 * 86_400_000);
    assert.equal(new Rounds(join(ROOM_HOME, "rounds-legacy.json")).expire(new Date(Date.now() - 3 * 86_400_000)), 1);
  } finally {
    mock.timers.reset();
  }
});

test("an ACCEPT ends the rounds of the task and of the seat that held it, whichever key they were counted under", () => {
  const rounds = new Rounds(join(ROOM_HOME, "rounds-accept.json"));
  // the seat handed in before it claimed its issue, then again as the holder of the issue
  rounds.handedIn("seat-1");
  rounds.handedIn("sw-k3f");
  rounds.answered("sw-k3f", "ACCEPT", "seat-1");
  assert.equal(new Rounds(join(ROOM_HOME, "rounds-accept.json")).expire(new Date(Date.now() + 1000)), 0);
});
