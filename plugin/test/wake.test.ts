import { hostOf, installRoom, MAIL_POLICY, PROJECT, shipSql } from "./support/room";
import { withPlugin } from "./support/plugin";
import { roomSeats } from "./support/seats";
import { fastestInTurns } from "./support/timing";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { MailError } from "../server/coordination/address";
import { MailEngine, type NewMail } from "../server/coordination/engine";
import { inbox } from "../server/coordination/reader";
import { MailStore } from "../server/coordination/store";
import type { RoomContext } from "../server/room/context";
import { refused, sendMail } from "../server/room/mail-tools";
import config from "../shared/mail.json";
import { mailRoom, namesOf, openList, seatRecord } from "./support/mail";

shipSql();

const MINUTE = 60_000;
const START = Date.parse("2026-10-15T08:00:00Z");
const ROOM = { agentId: "room", role: "system" };

/** A room of stand-in seats: `state` sets a seat's status (null: the daemon no longer has it, "lost": it cannot be read), `pass` moves the clock and runs the minute pass, `call` is a tool call answered as JSON or as the refusal. */
interface Rig {
  engine: MailEngine;
  room: RoomContext;
  sent: Map<string, string[]>;
  state: Map<string, string | null>;
  reads: { n: number };
  clock: { ms: number };
  dir: string;
  at(minutes: number): string;
  pass(minutes: number): Promise<void>;
  call(seat: string, args: Record<string, unknown>): Promise<any>;
}

const names = <T extends string>(...roles: T[]) => namesOf("wake", ...roles);

/** A project of its own with a mail store of its own, a clock the test moves, and seats that keep what they are sent; `steer` lets a running seat take mail mid-turn. */
function rig(
  seats: [string, string, string | null][],
  shared?: { dir: string; clock: { ms: number } },
  steer = false,
): Rig {
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
  const policy = steer
    ? { ...MAIL_POLICY, midTurn: { ...MAIL_POLICY.midTurn, claude: "steer" as const } }
    : MAIL_POLICY;
  const engine = new MailEngine(hostOf(paseo), policy, () => {}, { rootOf: () => dir, now: () => new Date(clock.ms) });
  for (const [id, role, parent] of seats) engine.rememberSeat(seatRecord(id, role, parent, { cwd: dir }));
  const room = mailRoom(engine, { host: { live: openList(seats.map(([id]) => id)) } });
  return {
    engine,
    room,
    sent,
    state,
    reads,
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

test("a wake-up fires on the first pass after its time, as one WAKE mail that starts a turn though nothing else arrives", async () => {
  const id = names("lead");
  const r = rig([[id.lead, "lead", null]]);
  const set = await r.call(id.lead, { action: "wake", in_minutes: 20, note: "look at the CI run again" });
  assert.equal(typeof set.wake, "number");
  assert.equal(set.at, "2026-10-15T08:20:00.000Z");
  await r.pass(19);
  assert.deepEqual(got(r, id.lead), [], "not yet");
  await r.pass(1);
  assert.equal(got(r, id.lead).length, 1);
  assert.match(
    got(r, id.lead)[0],
    /^<mail id="\d+" from="room" subject="WAKE: look at the CI run again" needs="nothing" thread="m\d+">\nlook at the CI run again\n<\/mail>$/,
  );
  await r.pass(5);
  assert.equal(got(r, id.lead).length, 1, "fired once");
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
  assert.equal(got(r, id.lead).length, 1);
  assert.doesNotMatch(got(r, id.lead)[0], /WAKE/);
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
  assert.equal(got(next, id.lead).length, 1);
  assert.match(got(next, id.lead)[0], /subject="WAKE: check the deploy"/);
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
  assert.deepEqual(got(r, id.gone), []);
  assert.deepEqual(got(r, id.lost), []);
  assert.equal(r.engine.storeOf(id.gone)!.count(), 0, "no mail was made for the seat that is gone");
  assert.equal((await r.call(id.lost, { action: "wakes" })).wakes.length, 1, "kept for the next pass");
  r.state.delete(id.lost);
  await r.pass(1);
  assert.equal(got(r, id.lost).length, 1);
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
  assert.deepEqual(got(r, id.old), []);
  assert.equal(got(r, id.next).length, 2);
  assert.match(got(r, id.next).join("\n"), /own check[\s\S]*from the lead|from the lead[\s\S]*own check/);
  assert.equal(got(r, id.lead).length, 1);
  assert.match(got(r, id.lead)[0], new RegExp(`Set by peer ${id.next.slice(0, 8)}`));
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
  assert.match(got(r, id.peer)[0], /report your progress/);
  assert.match(got(r, id.peer)[0], /\n\nSet by owner\.\n/);
  assert.match(got(r, id.lead)[0], new RegExp(`Set by peer ${id.peer.slice(0, 8)}`));
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
  assert.deepEqual(await r.call(id.peer, { action: "unwake", id: 99_999 }).then(({ code, next }) => ({ code, next })), {
    code: "UNKNOWN_WAKE",
    next: { tool: "seatwork_mail", args: { action: "wakes" } },
  });
  assert.equal((await r.call(id.peer, { action: "unwake", id: set.wake })).canceled, set.wake, "the seat it wakes");
  assert.equal((await r.call(id.lead, { action: "unwake", id: `#${set.wake}` })).code, "UNKNOWN_WAKE", "once");
  const second = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 20, note: "again" });
  assert.equal((await r.call(id.lead, { action: "unwake", id: second.wake })).canceled, second.wake, "the setter");
  const third = await r.call(id.lead, { action: "wake", to: id.peer, in_minutes: 20, note: "once more" });
  assert.ok(third.wake > second.wake, "an id of a canceled wake-up is not given to the next");
  await r.call(id.lead, { action: "unwake", id: third.wake });
  await r.pass(50);
  assert.equal(got(r, id.peer).length, 1, "only the one that stayed");
  assert.match(got(r, id.peer)[0], /mine/);
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
  // the shortest and the farthest time, and a note at its cap, are accepted
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
  assert.equal((await r.call(id.lead, { action: "wake", in_minutes: 5, note: "another seat's own" })).wake > 0, true);
  await r.call(id.peer, { action: "unwake", id: made[0] });
  assert.equal((await r.call(id.peer, { action: "wake", in_minutes: 5, note: "fits" })).wake > 0, true);
  await r.pass(5);
  assert.equal((await r.call(id.peer, { action: "wake", in_minutes: 5, note: "fits again" })).wake > 0, true);
});

test("wakes lists a bounded number of wake-ups, soonest first, and says when more wait", async () => {
  const id = names("lead");
  const peers = Array.from({ length: 16 }, (_, i) => `${id.lead}-p${i}`);
  const r = rig([
    [id.lead, "lead", null],
    ...peers.map((peer): [string, string, string | null] => [peer, "peer", id.lead]),
  ]);
  for (const [i, peer] of peers.entries())
    for (let k = 0; k < config.wake.perSetter; k += 1)
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

test("a pass that stopped after the WAKE mail went out does not send it again, however long after", async () => {
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
  assert.equal(got(r, id.peer).length, 1);
  // past the window in which the same text counts as a repeat: only the wake-up's own key tells it
  await r.pass(10);
  assert.equal(got(r, id.peer).length, 1, "the mail made by the pass that failed stands, and is not made again");
  assert.equal(store.wakeUpsOf(id.peer, 5).length, 0, "and the wake-up is over");
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
  assert.equal(got(r, id.b).length, 1);
  r.engine.post = post;
  await r.pass(1);
  assert.equal(got(r, id.a).length, 1, "the one that failed is tried again");
});

test("a seat above every project keeps its wake-ups in the room home's store and is woken from there", async () => {
  const id = names("hq");
  const r = rig([]);
  r.engine.rememberSeat({ agentId: id.hq, parentAgentId: null, role: "hq", provider: "claude-hq", title: "[hq]" });
  const set = await r.call(id.hq, { action: "wake", in_minutes: 30, note: "read the sweep time again" });
  assert.equal(typeof set.wake, "number");
  assert.equal(r.engine.storeOf(id.hq)!.wakeUpsOf(id.hq, 5).length, 1);
  await r.pass(31);
  assert.equal(got(r, id.hq).length, 1);
  assert.match(got(r, id.hq)[0], /subject="WAKE: read the sweep time again"/);
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
  both.rememberSeat(seatRecord(id.one, "supervisor", id.hq, { cwd: first.dir }));
  both.rememberSeat(seatRecord(id.two, "supervisor", id.hq, { cwd: second.dir }));
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

test("the statements of wake-ups use their indexes, and a pass over a large store reads what is due, not what is pending", async () => {
  /** A store of `rows` pending wake-ups, one due each minute from five minutes after START. */
  const filled = (rows: number) => {
    let tick = START;
    const store = new MailStore(mkdtempSync(join(PROJECT, "wake-store-")), 2000, () => new Date((tick += 1000)));
    const raw = new DatabaseSync(join(store.folder, "mail.db"));
    const insert = raw.prepare("INSERT INTO wakeups (seat, by, at, due, note) VALUES (?, ?, ?, ?, 'n')");
    raw.exec("BEGIN");
    for (let row = 0; row < rows; row += 1)
      insert.run(
        `seat-${row % 2000}`,
        `seat-${(row + 1) % 2000}`,
        new Date(START).toISOString(),
        new Date(START + (row + 5) * MINUTE).toISOString(),
      );
    raw.exec("COMMIT");
    raw.close();
    return store;
  };
  const [few, many] = [filled(1000), filled(10_000)];
  const now = new Date(START + 60 * MINUTE).toISOString();
  few.dueWakeUps(now, config.wake.perPass);
  few.wakeUpsOf("seat-7", 20);
  few.wakeUp(5);
  few.closeWakeUp(5, "canceled");
  few.readdress("seat-8", "seat-9");
  few.addWakeUp(
    { seat: "seat-7", by: "seat-8", at: now, due: new Date(START + 99 * MINUTE).toISOString(), note: "n" },
    { own: 8, others: 8, setter: 4, sameWithinMs: 2 * MINUTE },
  );
  // the copy beside the database reads every pending wake-up, which the shares keep to a few hundred
  const scans = few
    .plans()
    .filter(({ sql }) => sql.includes("wakeups") && !sql.endsWith("FROM wakeups ORDER BY id"))
    .filter(({ plan }) => /\bSCAN (wakeups|w)\b(?! USING)/.test(plan));
  assert.deepEqual(scans, []);
  assert.equal(many.dueWakeUps(now, config.wake.perPass).length, config.wake.perPass);
  const [small, large] = await fastestInTurns(
    () => few.dueWakeUps(now, config.wake.perPass),
    () => many.dueWakeUps(now, config.wake.perPass),
    9,
  );
  assert.ok(large < small * 4, `ten times the pending wake-ups took ${(large / small).toFixed(1)} times as long`);
  few.close();
  many.close();
});

test("through the room: a seat sets a wake-up with the tool, and the room's own minute pass wakes it when the time comes", async (t) => {
  installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer"]);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  await withPlugin(async ({ call }) => {
    const { seat } = roomSeats(call);
    const lead = await seat("lead-wake-room", "claude-lead", null, "[Lead] wake");
    const peer = await seat("peer-wake-room", "claude-peer", "lead-wake-room", "[Peer] wake");
    const mail = async (args: Record<string, unknown>) => JSON.parse(await peer.mail(args));
    const set = await mail({ action: "wake", in_minutes: 2, note: "look at the CI run" });
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
    assert.deepEqual((await mail({ action: "wakes" })).wakes, []);
  });
});
