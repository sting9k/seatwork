import { hostOf, MAIL_POLICY, PROJECT, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { MailError } from "../server/coordination/address";
import { MailEngine, type NewMail, type SeatRecord } from "../server/coordination/engine";
import { inbox } from "../server/coordination/reader";
import type { LiveSeat } from "../server/host";
import type { RoomContext } from "../server/room/context";
import { refused, sendMail } from "../server/room/mail-tools";
import config from "../shared/mail.json";

shipSql();

const MINUTE = 60_000;
const START = Date.parse("2026-10-15T08:00:00Z");
const ROOM = { agentId: "room", role: "system" };

interface Rig {
  engine: MailEngine;
  sent: Map<string, string[]>;
  state: Map<string, string | null>;
  clock: { ms: number };
  dir: string;
  at(minutes: number): string;
  pass(minutes: number): Promise<void>;
  call(seat: string, args: Record<string, unknown>): Promise<any>;
}

let cases = 0;
const names = <T extends string>(...roles: T[]) =>
  Object.fromEntries(roles.map((role) => [role, `${role}-hole-${(cases += 1)}`])) as Record<T, string>;

const record = (agentId: string, role: string, parent: string | null, cwd: string): SeatRecord => ({
  agentId,
  parentAgentId: parent,
  role,
  provider: `claude-${role}`,
  title: `[${role}] ${agentId}`,
  cwd,
});

/** A project of its own with a mail store, a clock the test moves, and seats that keep what they are sent; `steer` lets a running seat take mail mid-turn. */
function rig(
  seats: [string, string, string | null][],
  shared?: { dir: string; clock: { ms: number } },
  steer = false,
): Rig {
  const dir = shared?.dir ?? mkdtempSync(join(PROJECT, "hole-"));
  const clock = shared?.clock ?? { ms: START };
  const sent = new Map<string, string[]>();
  const state = new Map<string, string | null>();
  const handle = (id: string) => ({
    refresh: async () => {},
    current: () => (state.get(id) === null ? null : { status: state.get(id) ?? "idle" }),
    send: async (text: string) => void sent.set(id, [...(sent.get(id) ?? []), text]),
  });
  const engine = new MailEngine(
    hostOf({ agents: { ref: (id: string) => handle(id) } }),
    steer ? { ...MAIL_POLICY, midTurn: { ...MAIL_POLICY.midTurn, claude: "steer" } } : MAIL_POLICY,
    () => {},
    { rootOf: () => dir, now: () => new Date(clock.ms) },
  );
  for (const [id, role, parent] of seats) engine.rememberSeat(record(id, role, parent, dir));
  const room = {
    engine,
    host: {
      live: async () =>
        new Map(seats.map(([id]) => [id, { id, status: "idle", waiting: false } as LiveSeat])) as Map<string, LiveSeat>,
    },
    mailedUp: new Map(),
    lastSignal: new Map(),
    rounds: { rejected: () => 0, answered: () => 0 },
    works: { existing: () => null },
    taskKeys: { of: (seat: string) => seat },
    forks: { take: async () => "something" },
  } as unknown as RoomContext;
  return {
    engine,
    sent,
    state,
    clock,
    dir,
    at: (minutes) => new Date(clock.ms + minutes * MINUTE).toISOString(),
    async pass(minutes) {
      clock.ms += minutes * MINUTE;
      await engine.sweep();
    },
    async call(seat, args) {
      try {
        return JSON.parse(await sendMail(room, seat, args));
      } catch (error) {
        return (JSON.parse(refused(room, seat, error).message) as { error: MailError }).error;
      }
    },
  };
}

const got = (r: Rig, seat: string) => r.sent.get(seat) ?? [];

const mail = (to: string, subject: string, more: Partial<NewMail> = {}): NewMail => ({
  from: ROOM,
  to,
  priority: "action",
  subject,
  body: `body of ${subject}`,
  needs: "nothing",
  ...more,
});

/** The mail store of a rig's project goes the way a lost disk takes it: its file and its logs. */
function loseDatabase(r: Rig): void {
  r.engine.close();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(r.dir, ".seatwork", ".mail", `mail.db${suffix}`), { force: true });
}

test("a wake call a model repeats is the wake-up already waiting; a different note, setter, seat or time is another", async () => {
  const id = names("lead", "peer");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ]);
  const ask = { action: "wake", in_minutes: 20, note: "look at the CI run" };
  const first = await r.call(id.peer, ask);
  r.clock.ms += 30_000;
  const again = await r.call(id.peer, ask);
  assert.equal(again.wake, first.wake, "the retry gets the wake-up it already made");
  assert.equal(again.replayed, true);
  assert.equal(again.at, first.at, "and the time it already has");
  assert.equal((await r.call(id.peer, { action: "wakes" })).wakes.length, 1);

  const other = await r.call(id.peer, { ...ask, note: "look at the deploy" });
  assert.notEqual(other.wake, first.wake, "another note");
  const byLead = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 20, note: "look at the CI run" });
  assert.notEqual(byLead.wake, first.wake, "another setter");
  const later = await r.call(id.peer, { ...ask, in_minutes: 20 + config.wake.sameWithinMinutes + 1 });
  assert.notEqual(later.wake, first.wake, "a time apart");
  const own = await r.call(id.lead, { action: "wake", in_minutes: 20, note: "look at the CI run" });
  assert.notEqual(own.wake, first.wake, "another seat");

  const day = { action: "wake", at: "2026-10-16T09:00:00Z", note: "check the deploy" };
  const a = await r.call(id.peer, day);
  assert.equal((await r.call(id.peer, day)).wake, a.wake, "an absolute time asked twice is the same time");
  await r.pass(26 * 60);
  assert.equal(got(r, id.peer).filter((text) => /check the deploy/.test(text)).length, 1, "it fired once");
});

test("a repeat uses up no share: a seat at its limit is answered with the wake-up it already has", async () => {
  const id = names("peer");
  const r = rig([[id.peer, "peer", null]]);
  const own = (i: number) => ({ action: "wake", in_minutes: 10 + i * 10, note: `n${i}` });
  for (let i = 0; i < config.wake.perSeat; i += 1) await r.call(id.peer, own(i));
  assert.equal((await r.call(id.peer, own(config.wake.perSeat))).code, "WAKE_LIMIT");
  assert.equal((await r.call(id.peer, own(0))).replayed, true);
});

test("each setter has its own share of a seat's wake-ups: a Lead that fills its share leaves the Peer room to wake itself", async () => {
  const id = names("sup", "lead", "peer");
  const r = rig([
    [id.sup, "supervisor", null],
    [id.lead, "lead", id.sup],
    [id.peer, "peer", id.lead],
  ]);
  const set = async (setter: string, to: string | undefined, tag: string, i: number) =>
    r.call(setter, { action: "wake", ...(to ? { to } : {}), in_minutes: 10 + i * 5, note: `${tag}${i}` });
  for (let i = 0; i < config.wake.perSetter; i += 1)
    assert.equal((await set(id.lead, id.peer, "lead", i)).code, undefined, `the Lead's ${i + 1}th`);
  const full = await set(id.lead, id.peer, "lead", config.wake.perSetter);
  assert.equal(full.code, "WAKE_LIMIT", "the Lead's share is full");
  assert.match(full.message, new RegExp(`${config.wake.perSetter} wake-ups`));

  for (let i = 0; i < config.wake.perSeat; i += 1)
    assert.equal((await set(id.peer, undefined, "own", i)).code, undefined, `the Peer's own ${i + 1}th`);
  assert.equal((await set(id.peer, undefined, "own", config.wake.perSeat)).code, "WAKE_LIMIT", "its own share is full");

  // the other seats together fill one share, not more
  for (let i = 0; i < config.wake.perSeat - config.wake.perSetter; i += 1)
    assert.equal((await set(id.sup, id.peer, "sup", i)).code, undefined, `the Supervisor's ${i + 1}th`);
  assert.equal((await set(id.sup, id.peer, "sup", 40)).code, "WAKE_LIMIT");
  assert.equal(
    (await r.call(id.peer, { action: "wakes" })).wakes.length,
    config.wake.perSeat * 2,
    "the Peer sees its own and the others'",
  );
});

test("a store rebuilt from its mail files keeps its pending wake-ups, and an id used before is not given again", async () => {
  for (const loss of ["gone", "damaged"] as const) {
    const id = names("lead");
    const first = rig([[id.lead, "lead", null]]);
    const kept = await first.call(id.lead, { action: "wake", in_minutes: 60, note: "check the deploy" });
    const dropped = await first.call(id.lead, { action: "wake", in_minutes: 30, note: "canceled before the loss" });
    await first.call(id.lead, { action: "unwake", id: dropped.wake });
    if (loss === "gone") loseDatabase(first);
    else {
      first.engine.close();
      writeFileSync(join(first.dir, ".seatwork", ".mail", "mail.db"), "this is no database");
      for (const suffix of ["-wal", "-shm"])
        rmSync(join(first.dir, ".seatwork", ".mail", `mail.db${suffix}`), { force: true });
    }
    const next = rig([[id.lead, "lead", null]], first);
    const listed = (await next.call(id.lead, { action: "wakes" })).wakes;
    assert.deepEqual(
      listed.map((wake: { id: number; at: string; note: string }) => [wake.id, wake.at, wake.note]),
      [[kept.wake, kept.at, "check the deploy"]],
      loss,
    );
    const fresh = await next.call(id.lead, { action: "wake", in_minutes: 90, note: "after the loss" });
    assert.ok(fresh.wake > dropped.wake, `${loss}: an id that was given before is not given again`);
    await next.pass(61);
    assert.match(got(next, id.lead).join("\n"), /check the deploy/, "and it fires when its time comes");
    next.engine.close();
  }
});

test("the copy of the wake-ups follows a seat to its successor, and a copy that cannot be read is passed over", async () => {
  const id = names("lead", "old", "next");
  const seats: [string, string, string | null][] = [
    [id.lead, "lead", null],
    [id.old, "peer", id.lead],
    [id.next, "peer", id.lead],
  ];
  const first = rig(seats);
  await first.call(id.old, { action: "wake", in_minutes: 30, note: "own check" });
  await first.engine.move(id.old, id.next);
  loseDatabase(first);
  const next = rig(seats, first);
  const listed = (await next.call(id.next, { action: "wakes" })).wakes;
  assert.deepEqual(
    listed.map((wake: { note: string; seat: string }) => [wake.note, wake.seat]),
    [["own check", "you"]],
    "the wake-up is the successor's",
  );
  next.engine.close();

  writeFileSync(join(first.dir, ".seatwork", ".mail", "wakeups.json"), "{ not json");
  loseDatabase(next);
  const after = rig(seats, first);
  assert.deepEqual((await after.call(id.next, { action: "wakes" })).wakes, []);
  after.engine.close();
});

test("a pass that fires several wake-ups writes their copy once, and the copy holds what still waits", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  for (const note of ["one", "two", "three", "four"]) await r.call(id.lead, { action: "wake", in_minutes: 1, note });
  await r.call(id.lead, { action: "wake", in_minutes: 90, note: "later" });
  const store = r.engine.storeOf(id.lead)!;
  const copy = store.copyWakeUps.bind(store);
  let copies = 0;
  store.copyWakeUps = () => {
    copies += 1;
    copy();
  };
  await r.pass(2);
  assert.equal(copies, 1, "one copy for the pass");
  const kept = JSON.parse(readFileSync(join(r.dir, ".seatwork", ".mail", "wakeups.json"), "utf8")) as {
    wakeups: { note: string }[];
  };
  assert.deepEqual(
    kept.wakeups.map((wake) => wake.note),
    ["later"],
  );
  r.engine.close();
});

test("a store that was not lost is never filled from the copy of its wake-ups", async () => {
  const id = names("lead");
  const first = rig([[id.lead, "lead", null]]);
  const set = await first.call(id.lead, { action: "wake", in_minutes: 60, note: "pending" });
  await first.call(id.lead, { action: "unwake", id: set.wake });
  first.engine.close();
  const copy = join(first.dir, ".seatwork", ".mail", "wakeups.json");
  writeFileSync(
    copy,
    JSON.stringify({
      after: 9,
      wakeups: [
        { id: 9, seat: id.lead, by: id.lead, at: new Date(START).toISOString(), due: first.at(60), note: "stale" },
      ],
    }),
  );
  const next = rig([[id.lead, "lead", null]], first);
  assert.deepEqual((await next.call(id.lead, { action: "wakes" })).wakes, []);
  next.engine.close();
});

test("a store rebuilt from its mail files still holds a report for its round until its time or its round comes", async () => {
  const id = names("lead", "peer");
  const seats: [string, string, string | null][] = [
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ];
  const first = rig(seats);
  const until = first.at(10);
  await first.engine.post(mail(id.lead, "REVIEW: one", { round: "r1", heldUntil: until }));
  await first.engine.post(mail(id.lead, "REVIEW: two", { round: "r1", heldUntil: until }));
  assert.deepEqual(got(first, id.lead), []);
  loseDatabase(first);

  const next = rig(seats, first);
  await next.pass(1);
  assert.deepEqual(got(next, id.lead), [], "still held after the rebuild");
  assert.deepEqual(
    next.engine
      .storeOf(id.lead)!
      .queued(id.lead)
      .map((one) => [one.round, one.heldUntil]),
    [
      ["r1", until],
      ["r1", until],
    ],
  );
  await next.pass(10);
  assert.equal(got(next, id.lead).length, 1, "one mail for the round");
  assert.match(got(next, id.lead)[0], /REVIEW: one[\s\S]*REVIEW: two/);
  next.engine.close();
});

test("held mail goes out only when its time has come: not with other mail, not by the inbox, not counted, not into a running turn", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  await r.engine.post(mail(id.lead, "REVIEW: one", { round: "r1", heldUntil: r.at(10) }));
  assert.deepEqual(
    r.engine.holding(id.lead),
    { mails: 0, oldestAt: null, later: 1, dueAt: r.at(10) },
    "held mail is not mail waiting for the seat; it is counted apart, with its time",
  );
  assert.equal(inbox(r.engine, id.lead, {}, r.clock.ms), "inbox empty", "the inbox does not hand it out");
  assert.equal(r.engine.backlog(), 1, "but it is in the room's backlog");
  assert.deepEqual(r.engine.takeHeld(id.lead, true), []);

  await r.engine.post(mail(id.lead, "INSTRUCTION: rebase"));
  assert.equal(got(r, id.lead).length, 1);
  assert.match(got(r, id.lead)[0], /INSTRUCTION: rebase/);
  assert.doesNotMatch(got(r, id.lead)[0], /REVIEW: one/, "it does not ride along with mail that starts a turn");
  assert.equal(r.engine.storeOf(id.lead)!.queued(id.lead).length, 1, "it still waits");

  r.clock.ms += 11 * MINUTE;
  assert.deepEqual(
    [r.engine.holding(id.lead)?.mails, r.engine.holding(id.lead)?.later],
    [1, 0],
    "counted once its time has come",
  );
  assert.match(inbox(r.engine, id.lead, {}, r.clock.ms), /REVIEW: one/, "and handed out");
});

test("a running seat that takes mail mid-turn is not handed held mail before its time", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]], undefined, true);
  r.state.set(id.lead, "running");
  await r.engine.post(mail(id.lead, "REVIEW: one", { round: "r1", heldUntil: r.at(10) }));
  assert.deepEqual(got(r, id.lead), []);
  await r.engine.post(mail(id.lead, "INSTRUCTION: use the v2 format"));
  assert.equal(got(r, id.lead).length, 1);
  assert.doesNotMatch(got(r, id.lead)[0], /REVIEW: one/);
  await r.pass(11);
  assert.match(got(r, id.lead)[1], /REVIEW: one/, "steered once its time has come");
});

test("a review round still reaches its Owner together: with its last report, or when its first hold runs out", async () => {
  const id = names("lead", "other");
  const r = rig([
    [id.lead, "lead", null],
    [id.other, "lead", null],
  ]);
  await r.engine.post(mail(id.lead, "REVIEW: one", { round: "r1", heldUntil: r.at(30) }));
  await r.engine.post(mail(id.lead, "REVIEW: two", { round: "r1", heldUntil: r.at(30) }));
  await r.engine.post(mail(id.other, "REVIEW: elsewhere", { round: "r9", heldUntil: r.at(30) }));
  assert.deepEqual(got(r, id.lead), []);
  await r.engine.post(mail(id.lead, "REVIEW: three", { round: "r1" }));
  assert.equal(got(r, id.lead).length, 1, "the last report brings the round");
  assert.match(got(r, id.lead)[0], /REVIEW: one[\s\S]*REVIEW: two[\s\S]*REVIEW: three/);
  assert.deepEqual(got(r, id.other), [], "another seat's round is not released with it");

  // a round whose reports were held at different times goes whole when the first of them is due
  await r.engine.post(mail(id.lead, "REVIEW: late one", { round: "r2", heldUntil: r.at(5) }));
  r.clock.ms += 2 * MINUTE;
  await r.engine.post(mail(id.lead, "REVIEW: late two", { round: "r2", heldUntil: r.at(7) }));
  await r.pass(4);
  assert.equal(got(r, id.lead).length, 2);
  assert.match(got(r, id.lead)[1], /REVIEW: late one[\s\S]*REVIEW: late two/);
  assert.deepEqual(got(r, id.other), [], "a round of another seat waits for its own time");
});

test("the inbox hands out a round whole once its first hold has run out, and nothing of it before", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  await r.engine.post(mail(id.lead, "REVIEW: one", { round: "r1", heldUntil: r.at(5) }));
  r.clock.ms += 2 * MINUTE;
  await r.engine.post(mail(id.lead, "REVIEW: two", { round: "r1", heldUntil: r.at(7) }));
  assert.equal(inbox(r.engine, id.lead, {}, r.clock.ms), "inbox empty");
  r.clock.ms += 4 * MINUTE;
  const read = inbox(r.engine, id.lead, {}, r.clock.ms);
  assert.match(read, /REVIEW: one[\s\S]*REVIEW: two/);
  assert.equal(inbox(r.engine, id.lead, {}, r.clock.ms), "inbox empty", "read once");
});

test("a pass starts at most the set number of turns from one store, gone seats cost none, and two passes at once do not double it", async () => {
  const id = names("lead");
  const peers = Array.from({ length: config.wake.turnsPerPass * 2 + 1 }, (_, i) => `${id.lead}-p${i}`);
  const away = [`${id.lead}-a`, `${id.lead}-b`];
  const r = rig([
    [id.lead, "lead", null],
    ...[...away, ...peers].map((p): [string, string, string | null] => [p, "peer", id.lead]),
  ]);
  for (const seat of [...away, ...peers]) await r.call(seat, { action: "wake", in_minutes: 5, note: "go" });
  for (const seat of away) r.state.set(seat, null);
  const woken = () => peers.filter((peer) => got(r, peer).length > 0).length;

  r.clock.ms += 6 * MINUTE;
  await Promise.all([r.engine.sweep(), r.engine.sweep()]);
  assert.equal(woken(), config.wake.turnsPerPass, "one pass, however many are due");
  assert.equal(
    r.engine.storeOf(id.lead)!.wakeUpsOf(away[0], 5).length,
    0,
    "the gone seats' wake-ups were dropped on the way",
  );
  await r.pass(1);
  assert.equal(woken(), config.wake.turnsPerPass * 2, "the rest follow in the next passes");
  await r.pass(1);
  assert.equal(woken(), peers.length);
  for (const peer of peers) assert.equal(got(r, peer).length, 1, "each woken once");
});
