import { deferred, hostOf, MAIL_POLICY, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { MailError } from "../server/coordination/address";
import { MailEngine, type SeatRecord } from "../server/coordination/engine";
import type { LiveSeat } from "../server/host";
import type { RoomContext } from "../server/room/context";
import { sendMail } from "../server/room/mail-tools";
import mailConfig from "../shared/mail.json";

shipSql();

/** A seat at rest that takes the mail it is sent. */
const idle = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async () => {} };

let cases = 0;
/** Seat ids no other test of this file uses: every engine here shares the room home's store. */
function names<T extends string>(...roles: T[]): Record<T, string> {
  cases += 1;
  return Object.fromEntries(roles.map((role) => [role, `${role}-tools-${cases}`])) as Record<T, string>;
}

const seat = (agentId: string, role: string, parent: string | null, title = `[${role}] ${agentId}`): SeatRecord => ({
  agentId,
  parentAgentId: parent,
  role,
  provider: `claude-${role}`,
  title,
});

/** A room with a mail engine over these agents; its host lists `open` (or fails) and counts the lists it gives. */
function roomOf(handles: Record<string, object>, open: string[] | Error) {
  const missing = { refresh: async () => null, current: () => null };
  const paseo = { agents: { ref: (id: string) => handles[id] ?? missing } };
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {}, {});
  const asked = { live: 0 };
  const room = {
    engine,
    host: {
      live: async () => {
        asked.live += 1;
        if (open instanceof Error) throw open;
        return new Map(open.map((id) => [id, { id, status: "idle", waiting: false } as LiveSeat]));
      },
    },
    mailedUp: new Map(),
    lastSignal: new Map(),
    rounds: { rejected: () => 0, answered: () => 0 },
    works: { existing: () => null },
    taskKeys: { of: (seat: string) => seat },
    forks: { take: async () => "something" },
  } as unknown as RoomContext;
  return { room, engine, asked };
}

/** A supervisor, its lead and the lead's peers, the seats all registered. */
function tree(engine: MailEngine, id: Record<string, string>, peers: [string, string?][]) {
  engine.rememberSeat(seat(id.boss, "supervisor", null));
  engine.rememberSeat(seat(id.lead, "lead", id.boss));
  for (const [peer, title] of peers) engine.rememberSeat(seat(peer, "peer", id.lead, title));
}

const note = { subject: "INSTRUCTION: start", body: "Go.", needs: "nothing" };
const refusedWith = (run: Promise<string>) =>
  run.then(
    () => assert.fail("the mail was sent"),
    (error: MailError) => error,
  );
const label = (agentId: string, role: string, title: string) => `${agentId} (${role} ${agentId.slice(0, 8)}: ${title})`;

test("a mail by a whole id, to the owner, as an answer, or without `to` from a seat with none under it needs no list of open seats", async () => {
  const id = names("lead", "peer", "boss");
  const { room, engine, asked } = roomOf({ [id.lead]: idle, [id.peer]: idle, [id.boss]: idle }, [
    id.boss,
    id.lead,
    id.peer,
  ]);
  tree(engine, id, [[id.peer]]);

  const sent = JSON.parse(await sendMail(room, id.lead, { ...note, to: id.peer, cc: [id.boss] }));
  assert.equal(sent.state, "delivered");
  await sendMail(room, id.peer, { subject: "ACK: started", body: "Started.", to: "owner" });
  await sendMail(room, id.peer, { subject: "ACK: again", body: "Still on it.", reply_to: sent.sent });
  await sendMail(room, id.peer, { subject: "ACK: and again", body: "Nearly there." });
  assert.equal(asked.live, 0);
});

test("a mail that gives no body is refused before anything is sent; only the wake-up actions go without one", async () => {
  const id = names("lead", "peer", "boss");
  const { room, engine, asked } = roomOf({ [id.lead]: idle, [id.peer]: idle, [id.boss]: idle }, [id.lead, id.peer]);
  tree(engine, id, [[id.peer]]);
  const bodiless = await refusedWith(sendMail(room, id.lead, { subject: "INSTRUCTION: start", to: id.peer }));
  assert.equal(bodiless.code, "INVALID_ARGUMENT");
  assert.match(bodiless.message, /`body`/);
  assert.equal(asked.live, 0);
  assert.ok(JSON.parse(await sendMail(room, id.lead, { action: "wakes" })).wakes);
});

test("the receipt says whether the mail was delivered or is held until the recipient can take it", async () => {
  const id = names("lead", "busy", "boss");
  const running = { ...idle, current: () => ({ status: "running" }) };
  const { room, engine } = roomOf({ [id.lead]: idle, [id.busy]: running }, [id.busy]);
  tree(engine, id, [[id.busy]]);
  const sent = JSON.parse(await sendMail(room, id.lead, { ...note, to: id.busy }));
  assert.equal(sent.state, "held until the recipient can take it");
  assert.equal(engine.holding(id.busy)?.mails, 1);
});

test("the open seats are asked for once when a title, the team or an empty `to` must be resolved", async () => {
  const id = names("lead", "peer", "old", "boss");
  const { room, engine, asked } = roomOf({ [id.boss]: idle, [id.lead]: idle, [id.peer]: idle, [id.old]: idle }, [
    id.boss,
    id.lead,
    id.peer,
  ]);
  // an archived seat and its successor carry one title: only the open one answers to it
  tree(engine, id, [
    [id.old, "[Peer] indexer"],
    [id.peer, "[Peer] indexer"],
  ]);

  const titled = JSON.parse(await sendMail(room, id.lead, { ...note, to: "indexer" }));
  assert.equal(engine.storeOf(id.peer, false)!.deliveries(titled.sent)[0].seat, id.peer);
  assert.equal(asked.live, 1);

  const team = JSON.parse(await sendMail(room, id.lead, { subject: "FYI: main moved", body: "Rebase.", to: "team" }));
  assert.deepEqual(
    engine
      .storeOf(id.peer, false)!
      .deliveries(team.sent)
      .map((d) => d.seat),
    [id.peer],
  );
  assert.equal(asked.live, 2);

  // a lead with seats under it must name one
  const empty = await refusedWith(sendMail(room, id.lead, { ...note }));
  assert.equal(empty.code, "NO_RECIPIENT");
  assert.deepEqual(empty.fix, {
    to: [`owner (supervisor ${id.boss.slice(0, 8)}: ${id.boss})`, label(id.peer, "peer", "indexer")],
  });
  assert.equal(asked.live, 3);
});

test("a refusal that lists the seats one may write to asks the app for the open ones, once", async () => {
  const id = names("lead", "peer", "other", "gone", "boss");
  const { room, engine, asked } = roomOf({ [id.boss]: idle, [id.lead]: idle, [id.peer]: idle, [id.other]: idle }, [
    id.boss,
    id.lead,
    id.peer,
    id.other,
  ]);
  tree(engine, id, [
    [id.peer, "[Peer] indexer"],
    [id.gone, "[Peer] parser"],
  ]);
  engine.rememberSeat(seat(id.other, "lead", id.boss));
  const reachable = {
    to: [`owner (supervisor ${id.boss.slice(0, 8)}: ${id.boss})`, label(id.peer, "peer", "indexer")],
  };

  // a route the workflow closes
  const route = await refusedWith(sendMail(room, id.lead, { ...note, to: id.other }));
  assert.equal(route.code, "ROUTE_REFUSED");
  assert.match(route.message, /route lead>lead is off/);
  assert.deepEqual(route.fix, reachable);
  assert.equal(asked.live, 1);

  // a seat the daemon no longer has
  const gone = await refusedWith(sendMail(room, id.lead, { ...note, to: id.gone }));
  assert.equal(gone.code, "RECIPIENT_GONE");
  assert.deepEqual(gone.fix, reachable);
  assert.equal(asked.live, 2);

  // a word that names no seat
  const unknown = await refusedWith(sendMail(room, id.lead, { ...note, to: "nobody-by-that-name" }));
  assert.equal(unknown.code, "UNKNOWN_RECIPIENT");
  assert.deepEqual(unknown.fix, reachable);
  assert.equal(asked.live, 3);
});

test("when the app lists no seats, or cannot, every seat of the room counts as open", async () => {
  const id = names("lead", "peer", "boss");
  for (const open of [[], new Error("the daemon is busy")]) {
    const { room, engine } = roomOf({ [id.lead]: idle, [id.peer]: idle }, open);
    tree(engine, id, [[id.peer, "[Peer] indexer"]]);
    const sent = JSON.parse(await sendMail(room, id.lead, { ...note, to: "indexer" }));
    assert.equal(sent.state, "delivered");
  }
});

test("the recipients' statuses are read together, not one after another", async () => {
  const id = names("lead", "a", "b", "c", "boss");
  const gate = deferred();
  const started: string[] = [];
  const slow = (agent: string) => ({
    ...idle,
    refresh: async () => {
      started.push(agent);
      if (started.length <= 3) await gate.promise;
    },
  });
  const { room, engine } = roomOf({ [id.lead]: idle, [id.a]: slow(id.a), [id.b]: slow(id.b), [id.c]: slow(id.c) }, [
    id.a,
    id.b,
    id.c,
  ]);
  tree(engine, id, [[id.a], [id.b], [id.c]]);
  const sending = sendMail(room, id.lead, { ...note, to: [id.a, id.b], cc: [id.c] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), [id.a, id.b, id.c].sort(), "every status was asked for before any answered");
  gate.resolve();
  await sending;
});

test("a stop order asks the app which seats under the stopped one are running, once", async () => {
  const id = names("lead", "peer", "deep", "boss");
  const heard: string[] = [];
  const { room, engine, asked } = roomOf(
    {
      [id.lead]: idle,
      [id.peer]: idle,
      [id.deep]: { ...idle, send: async (text: string) => void heard.push(text) },
    },
    [id.peer, id.deep],
  );
  tree(engine, id, [[id.peer]]);
  engine.rememberSeat(seat(id.deep, "peer", id.peer));
  const stopped = JSON.parse(
    await sendMail(room, id.lead, { subject: "STOP: wrong branch", body: "Stop.", to: id.peer }),
  );
  assert.equal(stopped.to.length, 1);
  assert.equal(asked.live, 1);
});

test("a mail names at most the number of entries shared/mail.json allows in `to`, `cc` and `files`", async () => {
  const id = names("lead", "peer", "boss");
  const { room, engine } = roomOf({ [id.lead]: idle, [id.peer]: idle }, [id.peer]);
  tree(engine, id, [[id.peer]]);
  const most = (mailConfig as { namedMost?: number }).namedMost;
  assert.equal(typeof most, "number");
  for (const field of ["to", "cc", "files"] as const) {
    const args = { ...note, to: id.peer, [field]: Array((most as number) + 1).fill(id.peer) };
    const refused = await refusedWith(sendMail(room, id.lead, args));
    assert.equal(refused.code, "INVALID_ARGUMENT");
    assert.match(refused.message, new RegExp(`\`${field}\` names ${(most as number) + 1} entries; ${most} at most`));
  }
});

test("a mail posted again for the same id puts its entry in its thread's file once", async () => {
  const id = names("lead", "peer", "boss");
  const { engine } = roomOf({ [id.lead]: idle, [id.peer]: idle }, [id.peer]);
  tree(engine, id, [[id.peer]]);
  const kept = engine.keepReport({
    from: { agentId: id.peer, role: "peer" },
    to: id.lead,
    priority: "action",
    subject: "DONE: indexer",
    body: "Finished the indexer.",
    needs: "reply",
  });
  const report = engine.takeReport(id.peer)!;
  await engine.postReport(report);
  await engine.postReport(report);

  const thread = join(engine.folderOf(id.lead), "threads", `${kept.thread}.md`);
  assert.ok(existsSync(thread), "the thread has a file");
  const text = readFileSync(thread, "utf8");
  assert.equal(text.split(`## #${kept.id} ·`).length - 1, 1, text);
});
