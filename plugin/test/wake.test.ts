import { hostOf, installRoom, MAIL_POLICY, PROJECT, shipSql } from "./support/room";
import { fakeServer } from "./support/server";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import contribute from "../index.server";
import type { MailError } from "../server/coordination/address";
import { MailEngine, type SeatRecord } from "../server/coordination/engine";
import { inbox } from "../server/coordination/reader";
import { MailStore } from "../server/coordination/store";
import type { LiveSeat } from "../server/host";
import type { RoomContext } from "../server/room/context";
import { refused, sendMail } from "../server/room/mail-tools";
import config from "../shared/mail.json";

shipSql();

const MINUTE = 60_000;
const START = Date.parse("2026-10-15T08:00:00Z");

/** A room of stand-in seats: `state` sets a seat's status (null: the daemon no longer has it, "lost": it cannot be read), `pass` moves the clock and runs the minute pass, `call` is a tool call answered as JSON or as the refusal. */
interface Rig {
  engine: MailEngine;
  room: RoomContext;
  sent: Map<string, string[]>;
  state: Map<string, string | null>;
  reads: { n: number };
  clock: { ms: number };
  dir: string;
  pass(minutes: number): Promise<void>;
  call(seat: string, args: Record<string, unknown>): Promise<any>;
}

let cases = 0;
const names = <T extends string>(...roles: T[]) =>
  Object.fromEntries(roles.map((role) => [role, `${role}-wake-${(cases += 1)}`])) as Record<T, string>;

const record = (agentId: string, role: string, parent: string | null, cwd: string): SeatRecord => ({
  agentId,
  parentAgentId: parent,
  role,
  provider: `claude-${role}`,
  title: `[${role}] ${agentId}`,
  cwd,
});

/** A project of its own with a mail store of its own, a clock the test moves, and seats that keep what they are sent. */
function rig(seats: [string, string, string | null][], shared?: { dir: string; clock: { ms: number } }): Rig {
  const dir = shared?.dir ?? mkdtempSync(join(PROJECT, "wake-"));
  const clock = shared?.clock ?? { ms: START };
  const sent = new Map<string, string[]>();
  const state = new Map<string, string | null>();
  const reads = { n: 0 };
  const handle = (id: string) => ({
    refresh: async () => {
      reads.n += 1;
      if (state.get(id) === "lost") throw new Error("timeout");
    },
    current: () =>
      state.get(id) === null ? null : { status: state.get(id) === "lost" ? "idle" : (state.get(id) ?? "idle") },
    send: async (text: string) => void sent.set(id, [...(sent.get(id) ?? []), text]),
  });
  const paseo = { agents: { ref: (id: string) => handle(id) } };
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {}, {
    rootOf: () => dir,
    now: () => new Date(clock.ms),
  });
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
    room,
    sent,
    state,
    reads,
    clock,
    dir,
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

const wakes = (r: Rig, seat: string) => r.sent.get(seat) ?? [];

test("a wake-up fires on the first pass after its time, as one WAKE mail that starts a turn though nothing else arrives", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  const set = await r.call(id.lead, { action: "wake", in_minutes: 20, note: "look at the CI run again" });
  assert.equal(typeof set.wake, "number");
  assert.equal(set.at, "2026-10-15T08:20:00.000Z");
  await r.pass(19);
  assert.deepEqual(wakes(r, id.lead), [], "not yet");
  await r.pass(1);
  assert.equal(wakes(r, id.lead).length, 1);
  assert.match(
    wakes(r, id.lead)[0],
    /^<mail id="\d+" from="room" subject="WAKE: look at the CI run again" needs="nothing" thread="m\d+" note="[^"]+">\nlook at the CI run again\n\nWake-up #\d+, set by you at 2026-10-15 08:00 UTC for 2026-10-15 08:20 UTC\.\n<\/mail>$/,
  );
  await r.pass(5);
  assert.equal(wakes(r, id.lead).length, 1, "fired once");
  assert.equal((await r.call(id.lead, { action: "wakes" })).wakes.length, 0);
  assert.equal(r.engine.takeWake(id.lead).length, 1, "the WAKE mail is what started the turn");
});

test("a pending wake-up is not read with other mail, not taken by the inbox, and not counted as held mail", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  await r.call(id.lead, { action: "wake", in_minutes: 60, note: "read the trace" });
  assert.equal(r.engine.holding(id.lead), undefined);
  assert.equal(inbox(r.engine, id.lead, {}, r.clock.ms), "inbox empty");
  await r.engine.post({
    from: { agentId: "room", role: "system" },
    to: id.lead,
    priority: "action",
    subject: "INSTRUCTION: rebase now",
    body: "Rebase.",
    needs: "nothing",
  });
  assert.equal(wakes(r, id.lead).length, 1);
  assert.doesNotMatch(wakes(r, id.lead)[0], /WAKE/);
  assert.equal((await r.call(id.lead, { action: "wakes" })).wakes.length, 1);
});

test("a pass with no wake-up due reads no seat from the app", async () => {
  const id = names("lead", "peer");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ]);
  for (const seat of [id.lead, id.peer]) await r.call(seat, { action: "wake", in_minutes: 30, note: "later" });
  const before = r.reads.n;
  await r.pass(10);
  assert.equal(r.reads.n, before);
});

test("a wake-up set before a restart fires at the first pass after the room starts again, however long it was down", async () => {
  const id = names("lead");
  const first = rig([[id.lead, "lead", null]]);
  await first.call(id.lead, { action: "wake", at: "2026-10-15T09:00:00Z", note: "check the deploy" });
  first.engine.close();
  first.clock.ms += 3 * 24 * 60 * MINUTE;
  const next = rig([[id.lead, "lead", null]], first);
  assert.equal((await next.call(id.lead, { action: "wakes" })).wakes.length, 1, "kept in the store");
  await next.engine.sweep();
  assert.equal(wakes(next, id.lead).length, 1);
  assert.match(wakes(next, id.lead)[0], /subject="WAKE: check the deploy"/);
  assert.match(wakes(next, id.lead)[0], /for 2026-10-15 09:00 UTC/);
  next.engine.close();
});

test("a wake-up of a seat that is archived is dropped and delivered to nobody; one whose seat cannot be read waits for the next pass", async () => {
  const id = names("lead", "gone", "lost");
  const r = rig([
    [id.lead, "lead", null],
    [id.gone, "peer", id.lead],
    [id.lost, "peer", id.lead],
  ]);
  await r.call(id.gone, { action: "wake", in_minutes: 5, note: "nobody reads this" });
  await r.call(id.lost, { action: "wake", in_minutes: 5, note: "read me when the app answers" });
  r.state.set(id.gone, null);
  r.state.set(id.lost, "lost");
  await r.pass(6);
  assert.deepEqual(wakes(r, id.gone), []);
  assert.deepEqual(wakes(r, id.lost), []);
  assert.equal(r.engine.storeOf(id.gone)!.count(), 0, "no mail was made for the seat that is gone");
  assert.equal((await r.call(id.lost, { action: "wakes" })).wakes.length, 1, "kept for the next pass");
  r.state.delete(id.lost);
  await r.pass(1);
  assert.equal(wakes(r, id.lost).length, 1);
  const store = r.engine.storeOf(id.lost)!;
  assert.equal(
    store.wakeUpsOf(id.gone, 10).length + store.wakeUpsOf(id.lost, 10).length,
    0,
    "none is left in the store",
  );
});

test("a wake-up follows a seat to the seat that replaces it, whether the old seat was woken by it or set it", async () => {
  const id = names("lead", "old", "next");
  const r = rig([
    [id.lead, "lead", null],
    [id.old, "peer", id.lead],
    [id.next, "peer", id.lead],
  ]);
  await r.call(id.old, { action: "wake", in_minutes: 10, note: "own check" });
  await r.call(id.lead, { action: "wake", to: id.old, in_minutes: 10, note: "from the lead" });
  await r.call(id.old, { action: "wake", to: "owner", in_minutes: 10, note: "set by the old seat" });
  await r.engine.move(id.old, id.next);
  r.state.set(id.old, null);
  await r.pass(11);
  assert.deepEqual(wakes(r, id.old), []);
  assert.equal(wakes(r, id.next).length, 2);
  assert.match(wakes(r, id.next).join("\n"), /own check[\s\S]*from the lead|from the lead[\s\S]*own check/);
  assert.equal(wakes(r, id.lead).length, 1);
  assert.match(wakes(r, id.lead)[0], new RegExp(`set by peer ${id.next.slice(0, 8)}`));
});

test("a wake-up for another seat goes only where the workflow's routes let the caller mail, and says who set it", async () => {
  const id = names("lead", "peer", "other");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
    [id.other, "peer", id.lead],
  ]);
  const down = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 5, note: "report your progress" });
  assert.equal(typeof down.wake, "number");
  const sideways = await r.call(id.peer, { action: "wake", to: id.other, in_minutes: 5, note: "no" });
  assert.equal(sideways.code, "ROUTE_REFUSED");
  const up = await r.call(id.peer, { action: "wake", to: "owner", in_minutes: 5, note: "ask me about the build" });
  assert.equal(typeof up.wake, "number");
  const stranger = await r.call(id.other, { action: "wake", to: id.peer, in_minutes: 5, note: "no" });
  assert.equal(stranger.code, "ROUTE_REFUSED");
  await r.pass(6);
  assert.match(wakes(r, id.peer)[0], /report your progress/);
  assert.match(wakes(r, id.peer)[0], new RegExp(`set by owner at`));
  assert.match(wakes(r, id.lead)[0], new RegExp(`set by peer ${id.peer.slice(0, 8)}`));
});

test("wakes lists what is pending for the caller and what it set for others; unwake cancels one for the seat it wakes or the seat that set it, no one else", async () => {
  const id = names("lead", "peer", "other");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
    [id.other, "peer", id.lead],
  ]);
  const own = await r.call(id.peer, { action: "wake", in_minutes: 30, note: "mine" });
  const set = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 20, note: "from lead" });
  const elsewhere = await r.call(id.other, { action: "wake", in_minutes: 40, note: "not yours" });
  const seen = await r.call(id.peer, { action: "wakes" });
  assert.deepEqual(
    seen.wakes.map((w: { id: number }) => w.id),
    [set.wake, own.wake],
    "soonest first, and none of another seat's",
  );
  assert.equal(seen.wakes[0].by, "owner");
  assert.equal(seen.wakes[1].by, "you");
  assert.equal((await r.call(id.lead, { action: "wakes" })).wakes[0].seat, `peer ${id.peer}`);
  // a seat that neither set nor holds it is told no such wake-up, as for an id that never was
  assert.equal((await r.call(id.peer, { action: "unwake", id: elsewhere.wake })).code, "UNKNOWN_WAKE");
  assert.equal((await r.call(id.lead, { action: "unwake", id: elsewhere.wake })).code, "UNKNOWN_WAKE");
  assert.equal((await r.call(id.peer, { action: "unwake", id: 99_999 })).code, "UNKNOWN_WAKE");
  assert.equal((await r.call(id.peer, { action: "unwake", id: set.wake })).canceled, set.wake, "the seat it wakes");
  assert.equal((await r.call(id.lead, { action: "unwake", id: `#${set.wake}` })).code, "UNKNOWN_WAKE", "once");
  const second = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 20, note: "again" });
  assert.equal((await r.call(id.lead, { action: "unwake", id: second.wake })).canceled, second.wake, "the setter");
  const third = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 20, note: "once more" });
  assert.ok(third.wake > second.wake, "an id of a canceled wake-up is not given to the next");
  await r.call(id.lead, { action: "unwake", id: third.wake });
  await r.pass(50);
  assert.equal(wakes(r, id.peer).length, 1, "only the one that stayed");
  assert.match(wakes(r, id.peer)[0], /mine/);
});

test("a wake-up is refused unless its time is an ISO time with a zone or minutes, between a minute and the horizon, with a note within its cap", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  const code = async (args: Record<string, unknown>) =>
    (await r.call(id.lead, { action: "wake", note: "n", ...args })).code;
  assert.equal(await code({}), "INVALID_ARGUMENT", "neither");
  assert.equal(await code({ in_minutes: 5, at: "2026-10-15T09:00:00Z" }), "INVALID_ARGUMENT", "both");
  assert.equal(await code({ at: "2026-10-16T09:00:00" }), "INVALID_ARGUMENT", "no zone");
  assert.equal(await code({ at: "tomorrow morning" }), "INVALID_ARGUMENT");
  assert.equal(await code({ at: "2026-13-45T09:00:00Z" }), "INVALID_ARGUMENT");
  assert.equal(await code({ in_minutes: "soon" }), "INVALID_ARGUMENT");
  assert.equal(await code({ in_minutes: 0.5 }), "INVALID_ARGUMENT", "under a minute");
  assert.equal(await code({ at: "2026-10-15T08:00:30Z" }), "INVALID_ARGUMENT", "under a minute");
  assert.equal(await code({ in_minutes: config.wake.maxDays * 1440 + 1 }), "INVALID_ARGUMENT", "past the horizon");
  assert.equal(await code({ note: "", in_minutes: 5 }), "INVALID_ARGUMENT", "no note");
  assert.equal(await code({ note: "x".repeat(config.wake.noteChars + 1), in_minutes: 5 }), "INVALID_ARGUMENT");
  const tooSoon = await r.call(id.lead, { action: "wake", in_minutes: 0, note: "n" });
  assert.deepEqual(Object.keys(tooSoon.fix).sort(), ["earliest", "latest", "now"], "the window is said");
  // the edges stand
  assert.equal((await r.call(id.lead, { action: "wake", in_minutes: 1, note: "n" })).at, "2026-10-15T08:01:00.000Z");
  const zoned = await r.call(id.lead, { action: "wake", at: "2026-10-15T16:00:00+07:00", note: "n" });
  assert.equal(zoned.at, "2026-10-15T09:00:00.000Z", "the answer is in UTC");
  assert.equal(
    (
      await r.call(id.lead, {
        action: "wake",
        in_minutes: config.wake.maxDays * 1440,
        note: "x".repeat(config.wake.noteChars),
      })
    ).wake > 0,
    true,
  );
  assert.equal(await r.call(id.lead, { action: "bogus" }).then((e) => e.code), "INVALID_ARGUMENT");
});

test("at most a set number of wake-ups wait for one seat, and a canceled or fired one frees its place", async () => {
  const id = names("lead", "peer");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ]);
  const made: number[] = [];
  for (let i = 0; i < config.wake.perSeat; i += 1)
    made.push((await r.call(id.peer, { action: "wake", in_minutes: 10 + i, note: `n${i}` })).wake);
  assert.equal((await r.call(id.peer, { action: "wake", in_minutes: 5, note: "one too many" })).code, "WAKE_LIMIT");
  assert.equal(
    (await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 5, note: "and for it" })).code,
    "WAKE_LIMIT",
  );
  assert.equal((await r.call(id.lead, { action: "wake", in_minutes: 5, note: "another seat's own" })).wake > 0, true);
  await r.call(id.peer, { action: "unwake", id: made[0] });
  assert.equal((await r.call(id.peer, { action: "wake", in_minutes: 5, note: "fits" })).wake > 0, true);
  await r.pass(5);
  assert.equal((await r.call(id.peer, { action: "wake", in_minutes: 5, note: "fits again" })).wake > 0, true);
});

test("wakes lists a bounded number of wake-ups, soonest first, and says when more wait", async () => {
  const id = names("lead");
  const peers = Array.from({ length: 8 }, (_, i) => `${id.lead}-p${i}`);
  const r = rig([
    [id.lead, "lead", null],
    ...peers.map((peer): [string, string, string | null] => [peer, "peer", id.lead]),
  ]);
  for (const [i, peer] of peers.entries())
    for (let k = 0; k < config.wake.perSeat; k += 1)
      await r.call(id.lead, { action: "wake", to: peer, in_minutes: 10 + i * 10 + k, note: `n${i}-${k}` });
  const listed = await r.call(id.lead, { action: "wakes" });
  assert.equal(listed.wakes.length, 50);
  assert.equal(listed.more, true);
  const times = listed.wakes.map((w: { at: string }) => w.at);
  assert.deepEqual(times, [...times].sort());
});

test("a wake-up for a seat that is gone is refused when set", async () => {
  const id = names("lead", "peer");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ]);
  r.state.set(id.peer, null);
  assert.equal(
    (await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 5, note: "n" })).code,
    "RECIPIENT_GONE",
  );
});

test("a pass that stopped after the WAKE mail went out does not send it again, though the mail would read differently by then", async () => {
  const id = names("lead", "peer");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ]);
  await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 5, note: "once" });
  const store = r.engine.storeOf(id.peer)!;
  const close = store.closeWakeUp.bind(store);
  let failures = 1;
  store.closeWakeUp = (...args) => {
    if (failures-- > 0) throw new Error("the store is busy");
    return close(...args);
  };
  await r.pass(6);
  assert.equal(wakes(r, id.peer).length, 1);
  r.engine.label = () => "someone else";
  // past the window in which the same text counts as a repeat: only the wake-up's own key tells it
  await r.pass(10);
  assert.equal(wakes(r, id.peer).length, 1, "the mail made by the pass that failed stands, and is not made again");
  assert.equal(store.wakeUpsOf(id.peer, 5).length, 0, "and the wake-up is over");
});

test("a pass fires at most the set number of wake-ups of a store, the oldest first, and the rest go in the next", async () => {
  const id = names("lead");
  const seats: [string, string, string | null][] = [[id.lead, "lead", null]];
  const peers = Array.from({ length: config.wake.perPass + 10 }, (_, i) => `${id.lead}-p${i}`);
  for (const peer of peers) seats.push([peer, "peer", id.lead]);
  const r = rig(seats);
  for (const peer of peers) await r.call(peer, { action: "wake", in_minutes: 5, note: "go" });
  await r.pass(6);
  assert.equal(peers.filter((peer) => wakes(r, peer).length > 0).length, config.wake.perPass, "a pass is bounded");
  await r.pass(1);
  assert.equal(peers.filter((peer) => wakes(r, peer).length === 1).length, peers.length);
});

test("one wake-up that cannot go out does not stop the others of the pass", async () => {
  const id = names("lead", "a", "b");
  const r = rig([
    [id.lead, "lead", null],
    [id.a, "peer", id.lead],
    [id.b, "peer", id.lead],
  ]);
  await r.call(id.a, { action: "wake", in_minutes: 5, note: "first" });
  await r.call(id.b, { action: "wake", in_minutes: 5, note: "second" });
  const post = r.engine.post.bind(r.engine);
  r.engine.post = async (input) => {
    if (input.to === id.a) throw new Error("the store is busy");
    return post(input);
  };
  await r.pass(6);
  assert.equal(wakes(r, id.b).length, 1);
  r.engine.post = post;
  await r.pass(1);
  assert.equal(wakes(r, id.a).length, 1, "the one that failed is tried again");
});

test("a seat above every project keeps its wake-ups in the room home's store and is woken from there", async () => {
  const id = names("hq");
  const r = rig([]);
  r.engine.rememberSeat({ agentId: id.hq, parentAgentId: null, role: "hq", provider: "claude-hq", title: "[hq]" });
  const set = await r.call(id.hq, { action: "wake", in_minutes: 30, note: "read the sweep time again" });
  assert.equal(typeof set.wake, "number");
  assert.equal(r.engine.storeOf(id.hq)!.wakeUpsOf(id.hq, 5).length, 1);
  await r.pass(31);
  assert.equal(wakes(r, id.hq).length, 1);
  assert.match(wakes(r, id.hq)[0], /subject="WAKE: read the sweep time again"/);
});

test("a seat that set wake-ups in two projects names the seat it wakes when an id is held in both", async () => {
  const id = names("hq", "one", "two");
  const first = rig([[id.one, "supervisor", id.hq]]);
  const second = rig([[id.two, "supervisor", id.hq]]);
  // one seat above both, known to each engine: it sets a wake-up in each project's store
  for (const [r, who] of [
    [first, id.one],
    [second, id.two],
  ] as const) {
    r.engine.rememberSeat({ agentId: id.hq, parentAgentId: null, role: "hq", provider: "claude-hq", title: "[hq]" });
    assert.equal(
      typeof (await r.call(id.hq, { action: "wake", to: who, in_minutes: 5, note: `for ${who}` })).wake,
      "number",
    );
  }
  const both = new MailEngine(
    hostOf({
      agents: { ref: () => ({ refresh: async () => {}, current: () => ({ status: "idle" }), send: async () => {} }) },
    }),
    MAIL_POLICY,
    () => {},
    { rootOf: (cwd) => cwd, now: () => new Date(START) },
  );
  both.rememberSeat({ agentId: id.hq, parentAgentId: null, role: "hq", provider: "claude-hq", title: "[hq]" });
  both.rememberSeat(record(id.one, "supervisor", id.hq, first.dir));
  both.rememberSeat(record(id.two, "supervisor", id.hq, second.dir));
  const room = { engine: both, host: { live: async () => new Map() } } as unknown as RoomContext;
  const ask = async (args: Record<string, unknown>) => {
    try {
      return JSON.parse(await sendMail(room, id.hq, args));
    } catch (error) {
      return (JSON.parse(refused(room, id.hq, error).message) as { error: MailError }).error;
    }
  };
  const listed = (await ask({ action: "wakes" })).wakes as { id: number; seat: string }[];
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, listed[1].id, "each store counts its own ids");
  const clash = await ask({ action: "unwake", id: listed[0].id });
  assert.equal(clash.code, "INVALID_ARGUMENT");
  assert.deepEqual([...clash.fix.to].sort(), [id.one, id.two].sort());
  assert.equal((await ask({ action: "unwake", id: listed[0].id, to: id.two })).canceled, listed[0].id);
  assert.equal(((await ask({ action: "wakes" })).wakes as unknown[]).length, 1, "the other project's stays");
  both.close();
  first.engine.close();
  second.engine.close();
});

test("what wake-ups leave behind is cleared with the mail: no row of a fired, canceled or dropped one, and its events go with the prune", async () => {
  const id = names("lead", "peer");
  const r = rig([
    [id.lead, "lead", null],
    [id.peer, "peer", id.lead],
  ]);
  const store = r.engine.storeOf(id.lead)!;
  const raw = new DatabaseSync(join(store.folder, "mail.db"));
  const count = (sql: string) => Number((raw.prepare(sql).get() as { n: number }).n);
  await r.call(id.lead, { action: "wake", in_minutes: 5, note: "fires" });
  const canceled = await r.call(id.lead, { action: "wake", in_minutes: 6, note: "canceled" });
  await r.call(id.lead, { action: "unwake", id: canceled.wake });
  await r.call(id.peer, { action: "wake", in_minutes: 5, note: "dropped" });
  r.state.set(id.peer, null);
  await r.pass(10);
  assert.equal(count("SELECT count(*) AS n FROM wakeups"), 0);
  assert.equal(count("SELECT count(*) AS n FROM events WHERE kind LIKE 'wakeup-%'"), 6, "three set, one of each end");
  r.clock.ms += 10 * 24 * 60 * MINUTE;
  r.engine.prune(new Date(r.clock.ms).toISOString());
  assert.equal(count("SELECT count(*) AS n FROM events WHERE kind LIKE 'wakeup-%'"), 0);
  assert.equal(store.count(), 0, "the WAKE mail goes like any finished mail");
  raw.close();
});

test("the statements of wake-ups use their indexes, and a pass over a large store reads what is due, not what is pending", () => {
  const dir = mkdtempSync(join(PROJECT, "wake-store-"));
  let tick = START;
  const store = new MailStore(dir, 2000, () => new Date((tick += 1000)));
  const raw = new DatabaseSync(join(store.folder, "mail.db"));
  const insert = raw.prepare("INSERT INTO wakeups (seat, by, at, due, note) VALUES (?, ?, ?, ?, 'n')");
  let rows = 0;
  const fill = (more: number) => {
    raw.exec("BEGIN");
    for (let i = 0; i < more; i += 1, rows += 1)
      insert.run(
        `seat-${rows % 2000}`,
        `seat-${(rows + 1) % 2000}`,
        new Date(START).toISOString(),
        new Date(START + (rows + 5) * MINUTE).toISOString(),
      );
    raw.exec("COMMIT");
  };
  fill(1000);
  const now = new Date(START + 60 * MINUTE).toISOString();
  store.dueWakeUps(now, config.wake.perPass);
  store.wakeUpsOf("seat-7", 20);
  store.wakeUp(5);
  store.closeWakeUp(5, "canceled");
  store.readdress("seat-8", "seat-9");
  const scans = store
    .plans()
    .filter(({ sql }) => sql.includes("wakeups"))
    .filter(({ plan }) => /\bSCAN (wakeups|w)\b(?! USING)/.test(plan));
  assert.deepEqual(scans, []);
  const fastest = (run: () => unknown, times = 9) => {
    run();
    let best = Infinity;
    for (let i = 0; i < times; i += 1) {
      const start = process.hrtime.bigint();
      run();
      best = Math.min(best, Number(process.hrtime.bigint() - start));
    }
    return best;
  };
  const small = fastest(() => store.dueWakeUps(now, config.wake.perPass));
  fill(9000);
  assert.equal(store.dueWakeUps(now, config.wake.perPass).length, config.wake.perPass);
  const large = fastest(() => store.dueWakeUps(now, config.wake.perPass));
  assert.ok(large < small * 4, `ten times the pending wake-ups took ${(large / small).toFixed(1)} times as long`);
  raw.close();
  store.close();
});

test("through the room: a seat sets a wake-up with the tool, and the room's own minute pass wakes it when the time comes", async (t) => {
  installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "claude-lens"]);
  const paseoSide = fakeServer();
  const log = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  const dispose = contribute(paseoSide.server);
  const agents: Record<string, object> = {};
  const context = {
    paseo: {
      agents: {
        ref: (id: string) => agents[id],
        list: async () => ({
          entries: Object.entries(agents).map(([id, handle]) => ({
            agent: { id, updatedAt: new Date().toISOString(), ...(handle as { current(): object }).current() },
          })),
        }),
      },
    },
  };
  const seat = async (id: string, provider: string, parent: string | null, title: string) => {
    const made = (await paseoSide.call("before agent.create", {
      request: { config: { provider, cwd: PROJECT, title }, env: {} },
    })) as { env: Record<string, string>; config: { mcpServers: { seatwork: { url: string } } } };
    await paseoSide.call("before agent.session_open", {
      request: { env: made.env, reason: "create", agentId: id, provider },
    });
    const inbox: string[] = [];
    agents[id] = {
      refresh: async () => {},
      current: () => ({ status: "idle" }),
      send: async (text: string) => void inbox.push(text),
    };
    const agent = { id, parentAgentId: parent, provider, cwd: PROJECT, title, workspaceId: null };
    await paseoSide.call("on agent.created", { agent }, context);
    const rpc = async (method: string, params: object) => {
      const response = await fetch(made.config.mcpServers.seatwork.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return ((await response.json()) as { result: any }).result;
    };
    const call = async (args: Record<string, unknown>) => {
      const result = await rpc("tools/call", { name: "seatwork_mail", arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    return { inbox, call, rpc };
  };
  try {
    const lead = await seat("lead-wake-room", "claude-lead", null, "[Lead] wake");
    const peer = await seat("peer-wake-room", "claude-peer", "lead-wake-room", "[Peer] wake");
    const shown = (await peer.rpc("tools/list", {})).tools.find(
      (tool: { name: string }) => tool.name === "seatwork_mail",
    );
    for (const name of ["action", "at", "in_minutes", "note", "id"])
      assert.ok(name in shown.inputSchema.properties, name);
    const set = await peer.call({ action: "wake", in_minutes: 2, note: "look at the CI run" });
    assert.equal(set.at, new Date(START + 2 * MINUTE).toISOString());
    const settle = async () => {
      for (let i = 0; i < 50; i += 1) await new Promise((done) => setImmediate(done));
    };
    t.mock.timers.tick(MINUTE);
    await settle();
    assert.deepEqual(peer.inbox, [], "not yet");
    t.mock.timers.tick(MINUTE);
    await settle();
    assert.equal(peer.inbox.length, 1);
    assert.match(peer.inbox[0], /subject="WAKE: look at the CI run"/);
    assert.deepEqual(lead.inbox, []);
    assert.deepEqual((await peer.call({ action: "wakes" })).wakes, []);
  } finally {
    await dispose();
    Object.assign(console, log);
  }
});
