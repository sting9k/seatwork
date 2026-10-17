import { MAIL_POLICY, ROOM_HOME, shipSql } from "./support/room";
import { fastestInTurns } from "./support/timing";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vocabulary from "../shared/work.json";
import { MailEngine } from "../server/coordination/engine";
import type { LiveSeat } from "../server/host";
import { PaseoHost } from "../server/paseo/host";
import { sweepLeases, type RoomContext } from "../server/room/context";
import { alerts } from "../server/tasks/graph";
import { WorkStore, type Seating } from "../server/tasks/store";
import { WorkStores } from "../server/tasks/stores";
import { work, WORK_DIR } from "../server/tasks/tools";

shipSql();

const LEASE = vocabulary.leaseMinutes;
const DOWN_HOURS = vocabulary.leaseDownHours;
const MOST = vocabulary.leaseMostPerPass;
const POLICY = { minReasonChars: 20, forbidSelfClose: true };
const TIMING = { busyTimeoutMs: 5000 };
const RULES = { ...TIMING, staleClaimMinutes: 120, close: POLICY };
const START = Date.parse("2026-10-14T09:00:00Z");
const FAR = "2099-01-01T00:00:00.000Z";
const LONG_AGO = "2000-01-01T00:00:00.000Z";
const isSeat = (id: string) => /^(peer|lead)-/.test(id);
let made = 0;

/** A store whose clock stands still until `pass` moves it; the seats of the room are the ids `isSeat` knows. */
function leased(timing = TIMING) {
  const dir = join(ROOM_HOME, `lease-${(made += 1)}`);
  const clock = { at: START };
  const open = () => new WorkStore(dir, timing, () => new Date(clock.at), isSeat);
  const store = open();
  const at = (minutes: number) => new Date(clock.at + minutes * 60_000).toISOString();
  return { store, dir, clock, open, at, pass: (minutes: number) => void (clock.at += minutes * 60_000) };
}

const seating = (alive: string[] = [], unsure: string[] = []): Seating => ({ alive, unsure });
const lease = (store: WorkStore, id: string) => store.get(id).lease_until;

test("a seat's claim starts a lease, and the holder's own updates push it on; another seat's or an Owner's do not", () => {
  const { store, at, pass } = leased();
  const task = store.create({ title: "schema" }, "lead-1");
  assert.equal(task.lease_until, null);
  store.claim(task.id, "peer-a");
  assert.equal(lease(store, task.id), at(LEASE));

  pass(10);
  store.update(task.id, { append_notes: "an Owner's note" }, "lead-1", true);
  store.update(task.id, { priority: 1 }, "peer-b");
  assert.equal(lease(store, task.id), at(LEASE - 10), "no one but the holder pushes it");
  store.update(task.id, { append_notes: "tests run" }, "peer-a");
  assert.equal(lease(store, task.id), at(LEASE));

  const shown = work(store, RULES, { id: "lead-1", owner: true }, { do: "show", id: task.id }) as {
    lease_until: string;
  };
  assert.equal(shown.lease_until, at(LEASE), "a call to show says when the claim lapses");
});

test("handing an issue over starts the lease of a seat of the room, and ends it for nobody, a person or a closed issue", () => {
  const { store, at, pass } = leased();
  const task = store.create({ title: "schema" }, "lead-1");
  store.claim(task.id, "peer-a");
  pass(5);
  store.update(task.id, { assignee: "peer-b" }, "lead-1", true);
  assert.equal(lease(store, task.id), at(LEASE), "an Owner gives it to another seat: its lease starts");
  store.update(task.id, { assignee: "alice" }, "lead-1", true);
  assert.equal(lease(store, task.id), null, "a person's name holds no lease");
  store.update(task.id, { assignee: "peer-a" }, "lead-1", true);
  store.update(task.id, { assignee: null }, "peer-a");
  assert.equal(lease(store, task.id), null, "let go: no holder, no lease");

  store.claim(task.id, "peer-a");
  store.closeIssue(task.id, "schema landed in 4f2a91c, tests green", "lead-1", POLICY);
  assert.equal(lease(store, task.id), null, "a closed issue is held by no one");
  store.update(task.id, { title: "schema, done" }, "peer-a");
  assert.equal(lease(store, task.id), null, "an edit of a closed issue by its old holder starts nothing");
  store.reopen(task.id, "lead-1");
  assert.equal(lease(store, task.id), at(LEASE), "reopened, its old holder holds it again");
});

test("a claim by someone who is no seat of the room has no lease and is never given back", () => {
  const { store, pass } = leased();
  const task = store.create({ title: "schema" }, "lead-1");
  store.claim(task.id, "alice");
  assert.equal(lease(store, task.id), null);
  pass(LEASE * 10);
  assert.equal(store.leaseDue(), false);
  assert.deepEqual(store.expireLeases([], MOST), []);
  assert.equal(store.get(task.id).assignee, "alice");
});

test("a rotation hands the lease to the successor, and an archive ends it", () => {
  const { store, at, pass } = leased();
  const [one, two] = ["one", "two"].map((title) => store.create({ title }, "lead-1").id);
  store.claim(one, "peer-a");
  store.claim(two, "peer-b");
  pass(7);
  store.release("peer-a", "peer-c", "room");
  store.release("peer-b", null, "room");
  assert.equal(lease(store, one), at(LEASE), "the successor's lease starts at the hand-over");
  assert.equal(lease(store, two), null);
  assert.equal(store.get(two).status, "open");
});

test("renewal pushes the leases of the seats shown alive, in one statement, and touches nothing else of the issue", () => {
  const { store, at, pass } = leased();
  const ids = ["a", "b", "c"].map((title) => store.create({ title }, "lead-1").id);
  store.claim(ids[0], "peer-a");
  store.claim(ids[1], "peer-a");
  store.claim(ids[2], "peer-b");
  const before = ids.map((id) => store.get(id));
  const trail = ids.map((id) => store.events(id).length);

  assert.equal(store.leaseDue(), false);
  assert.equal(store.renewLeases(["peer-a", "peer-b"]), 0, "a lease with most of its time left is not rewritten");
  pass(LEASE / 2 + 1);
  assert.equal(store.leaseDue(), true);
  assert.equal(store.renewLeases(["peer-a"]), 2);
  assert.deepEqual(
    ids.map((id) => lease(store, id)),
    [at(LEASE), at(LEASE), at(LEASE / 2 - 1)],
  );
  ids.forEach((id, index) => {
    const now = store.get(id);
    assert.equal(now.revision, before[index].revision);
    assert.equal(
      now.updated_at,
      before[index].updated_at,
      "a renewal is no progress: the stale-claim alert still counts",
    );
    assert.equal(store.events(id).length, trail[index]);
  });
  assert.equal(store.renewLeases([]), 0);
});

test("a renewal is one statement however many issues it pushes", () => {
  const { store, pass } = leased(TIMING);
  const peers = Array.from({ length: 40 }, (_, i) => `peer-${i}`);
  for (const peer of peers) store.claim(store.create({ title: peer }, "lead-1").id, peer);
  pass(LEASE);
  const calls = () => store.stat().calls;
  const statements = (seats: string[]) => {
    const before = calls();
    store.renewLeases(seats);
    return calls() - before;
  };
  assert.equal(statements(peers), statements(["nobody"]), "forty rows, as many statements as none");
});

test("an issue whose lease has passed with its seat missing from the list is open again, unassigned, with a comment", () => {
  const { store, pass } = leased();
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((title) => store.create({ title }, "lead-1").id);
  store.claim(a, "peer-gone");
  store.claim(b, "peer-here");
  store.update(c, { assignee: "peer-gone" }, "lead-1", true);
  store.update(d, { assignee: "peer-gone", status: "deferred" }, "lead-1", true);
  store.claim(e, "peer-gone");
  store.closeIssue(e, "schema landed in 4f2a91c, tests green", "lead-1", POLICY);

  pass(LEASE - 1);
  assert.deepEqual(store.expireLeases(["peer-here"], MOST), [], "a lease still running is not given back");
  pass(2);
  const lapsed = store.expireLeases(["peer-here"], MOST);
  assert.deepEqual(
    lapsed.map(({ id, title, holder }) => [id, title, holder]).sort(),
    [
      [a, "a", "peer-gone"],
      [c, "c", "peer-gone"],
      [d, "d", "peer-gone"],
    ].sort(),
  );
  for (const id of [a, c, d]) {
    const now = store.get(id);
    assert.equal(now.assignee, null);
    assert.equal(now.lease_until, null);
    assert.equal(now.status, id === d ? "deferred" : "open");
    const said = store.comments(id).comments;
    assert.equal(said.length, 1);
    assert.equal(said[0].author, "room");
    assert.match(said[0].text, /peer-gone is gone.*back on the board.*claim it/i);
    assert.deepEqual(
      { ...store.events(id).find((one) => one.event_type === "assignee_changed") },
      {
        event_type: "assignee_changed",
        actor: "room",
        old_value: "peer-gone",
        new_value: null,
        created_at: now.updated_at,
      },
    );
  }
  assert.equal(store.get(b).assignee, "peer-here", "its seat is listed: whatever state it is in, the issue stays");
  assert.equal(store.get(e).status, "closed");
  assert.deepEqual(store.expireLeases(["peer-here"], MOST), [], "nothing is given back twice");
  assert.deepEqual(
    store.ready().map((issue) => issue.id),
    [a, c].sort(),
    "the open ones are on the board again",
  );
});

test("at most the set number go back in a pass, the longest lapsed first, and the rest go in the next", () => {
  const { store, pass } = leased();
  const ids = Array.from({ length: 5 }, (_, i) => {
    const id = store.create({ title: `t${i}` }, "lead-1").id;
    store.claim(id, "peer-gone");
    pass(1);
    return id;
  });
  pass(LEASE);
  const order = [2, 2, 1, 0].map((most) => store.expireLeases([], most).map((one) => one.id));
  assert.deepEqual(order, [ids.slice(0, 2), ids.slice(2, 4), ids.slice(4), []]);
  assert.ok(MOST >= 1);
});

test("the stale-claim alert still fires for a seat that is alive and idle: a renewal is not progress", () => {
  const { store, clock, pass } = leased();
  const id = store.create({ title: "schema" }, "lead-1").id;
  store.claim(id, "peer-a");
  for (let hour = 0; hour < 3; hour += 1) {
    pass(60);
    store.renewLeases(["peer-a"]);
  }
  assert.ok(Date.parse(lease(store, id)!) > clock.at, "the lease is running");
  assert.deepEqual(
    alerts(store.openWork(), new Date(clock.at), RULES.staleClaimMinutes).map((one) => one.type),
    ["stale_claim"],
  );
});

test("a pass reads the leases that are due by their index, so a store of 10,000 issues costs a store of 500", async () => {
  const build = (rows: number) => {
    const { store, dir, clock, open } = leased();
    store.close();
    const db = new DatabaseSync(join(dir, "work.db"));
    db.exec("BEGIN");
    const insert = db.prepare(
      "INSERT INTO issues (id, title, status, priority, issue_type, assignee, created_at, created_by, updated_at, closed_at, lease_until) VALUES (?, 'x', ?, 2, 'task', ?, ?, 'lead', ?, ?, ?)",
    );
    const at = new Date(clock.at).toISOString();
    for (let i = 0; i < rows; i += 1) {
      const held = i % 25 === 0;
      const lapsed = held && i < 75;
      insert.run(
        `sw-${i}`,
        held ? "in_progress" : "closed",
        held ? `peer-${i}` : null,
        at,
        at,
        held ? null : at,
        held ? (lapsed ? LONG_AGO : FAR) : null,
      );
    }
    db.exec("COMMIT");
    db.close();
    return open();
  };
  const pass = (store: WorkStore, listed: string[]) => () => {
    for (let again = 0; again < 100; again += 1) {
      store.leaseDue();
      store.renewLeases(listed);
      store.expireLeases(listed, MOST);
    }
  };
  const [small, large] = [500, 10_000].map(build);
  const listed = (rows: number) => Array.from({ length: rows / 25 }, (_, i) => `peer-${i * 25}`).slice(3);
  // peer-0, peer-25 and peer-50 are missing from the list, as three seats that are gone
  for (const [store, rows] of [
    [small, 500],
    [large, 10_000],
  ] as const) {
    const given = store.expireLeases([...listed(rows), "peer-75"], MOST);
    assert.deepEqual(
      given.map((one) => one.holder),
      ["peer-0", "peer-25", "peer-50"],
    );
  }
  const [fast, slow] = await fastestInTurns(pass(small, listed(500)), pass(large, listed(10_000)));
  assert.ok(slow < fast * 4, `500 issues took ${fast.toFixed(2)} ms, 10,000 took ${slow.toFixed(2)} ms`);
  const passes = large.plans().filter(({ sql }) => sql.includes("lease_until <"));
  assert.equal(passes.length, 3, "the read of what is due, the renewal and the expiry");
  for (const { sql, plan } of passes)
    assert.match(plan, /SEARCH issues USING (COVERING )?INDEX issues_by_lease \(lease_until<\?\)/, sql);
  assert.doesNotMatch(passes.map(({ plan }) => plan).join(" | "), /TEMP B-TREE|SCAN issues/);
  small.close();
  large.close();
});

/** The room's stores on a clock that stands still until `lapse` moves it past a lease. */
function storesOn(policy = RULES, log: (line: string) => void = () => {}, leased = isSeat) {
  const clock = { at: START };
  const stores = new WorkStores(policy, log, leased, () => new Date(clock.at));
  return { stores, clock, lapse: () => void (clock.at += (LEASE + 1) * 60_000) };
}

test("the room's stores read the list of seats only when a lease is due, and act on it only when it could be read", async () => {
  const { stores, lapse } = storesOn();
  const [one, two, none] = ["one", "two", "none"].map((name) => join(ROOM_HOME, `leases-${(made += 1)}-${name}`));
  const [a, b] = [one, two].map((root) => {
    const { store } = stores.of(root);
    const id = store.create({ title: "schema" }, "lead-1").id;
    store.claim(id, "peer-gone");
    return id;
  });
  mkdirSync(none, { recursive: true });
  let read = 0;
  const reading = (seen: Seating | null) => async () => ((read += 1), seen);

  assert.deepEqual(await stores.leases([one, two, none], reading(seating())), []);
  assert.equal(read, 0, "nothing is due: the app is not asked");
  lapse();
  assert.deepEqual(await stores.leases([one, two, none], reading(null)), []);
  assert.equal(read, 1);
  assert.equal(stores.of(one).store.get(a).assignee, "peer-gone", "a list that could not be read leaves every lease");
  assert.equal(existsSync(join(none, ".seatwork")), false, "a project with no store gets none");

  const done = await stores.leases([one, two, none], reading(seating(["peer-other"])));
  assert.equal(read, 2, "one reading serves every store");
  assert.deepEqual(
    done.map(({ root, lapsed }) => [root, lapsed.map((one) => one.id)]),
    [
      [one, [a]],
      [two, [b]],
    ],
  );
  stores.close();
});

test("a store that cannot be written does not stop the others, and two passes do not overlap", async () => {
  const logs: string[] = [];
  const { stores, lapse } = storesOn({ ...RULES, busyTimeoutMs: 50 }, (line) => logs.push(line));
  const [one, two] = ["one", "two"].map((name) => join(ROOM_HOME, `leases-${(made += 1)}-${name}`));
  const ids = [one, two].map((root) => {
    const id = stores.of(root).store.create({ title: "schema" }, "lead-1").id;
    stores.of(root).store.claim(id, "peer-gone");
    return id;
  });
  lapse();
  const other = new DatabaseSync(join(one, WORK_DIR, "work.db"));
  other.exec("BEGIN IMMEDIATE");

  let release!: (seen: Seating) => void;
  const waiting = new Promise<Seating>((done) => (release = done));
  const first = stores.leases([one, two], () => waiting);
  assert.deepEqual(await stores.leases([one, two], async () => seating()), [], "a pass is under way");
  release(seating());
  const done = await first;
  other.exec("COMMIT");
  other.close();

  assert.deepEqual(
    done.map((one) => one.lapsed.map((issue) => issue.id)),
    [[ids[1]]],
  );
  assert.match(logs.join("\n"), /leases of .*leases-\d+-one could not be swept/);
  assert.equal(stores.of(one).store.get(ids[0]).assignee, "peer-gone", "the locked store is tried again next minute");
  assert.deepEqual(
    (await stores.leases([one, two], async () => seating())).map((one) => one.root),
    [one],
  );
  stores.close();
});

/** A room of a Supervisor, two Leads and Peers over one project, with a host whose list of seats is `open`, or `host`. */
function roomOf(open: () => Map<string, Partial<LiveSeat>>, host?: PaseoHost) {
  const root = join(ROOM_HOME, `lease-room-${(made += 1)}`);
  mkdirSync(root, { recursive: true });
  const sent: { to: string; text: string }[] = [];
  const logs: string[] = [];
  const engine = new MailEngine(
    {
      state: async (id) => {
        try {
          return open().has(id) ? "idle" : "gone";
        } catch {
          return "unknown";
        }
      },
      send: async (to, text) => void sent.push({ to, text }),
      reparent: async () => {},
    },
    MAIL_POLICY,
    (line) => logs.push(line),
    { rootOf: () => root },
  );
  const seat = (agentId: string, role: string, parent: string | null, title: string) =>
    engine.rememberSeat({ agentId, parentAgentId: parent, role, provider: `claude-${role}`, title, cwd: root });
  seat("sup-1", "supervisor", null, "[Supervisor] all");
  seat("lead-1", "lead", "sup-1", "[Lead] store");
  seat("lead-2", "lead", "sup-1", "[Lead] api");
  seat("peer-a", "peer", "lead-1", "[Peer] schema");
  seat("peer-b", "peer", "lead-1", "[Peer] views");
  seat("peer-c", "peer", "lead-2", "[Peer] routes");
  seat("peer-d", "peer", "lead-2", "[Peer] auth");
  for (const peer of ["peer-e", "peer-f", "peer-g"]) seat(peer, "peer", "lead-1", peer);
  const {
    stores: works,
    clock,
    lapse,
  } = storesOn(
    RULES,
    (line) => logs.push(line),
    (id) => engine.seat(id) !== undefined,
  );
  const room = {
    engine,
    works,
    log: (line: string) => logs.push(line),
    host: host ?? {
      live: async () =>
        new Map([...open()].map(([id, seat]) => [id, { id, status: "idle", state: "idle", ...seat } as LiveSeat])),
    },
  } as unknown as RoomContext;
  const hold = (seatId: string, title: string) => {
    const { store } = works.of(root);
    const id = store.create({ title }, "lead-1").id;
    store.claim(id, seatId);
    lapse();
    return id;
  };
  return { room, root, works, sent, logs, hold, engine, clock };
}

test("the minute's pass gives back the issues of a seat the app no longer lists, and its Owner gets one mail with what to do", async () => {
  const listed = new Map<string, Partial<LiveSeat>>([
    ["sup-1", {}],
    ["lead-1", {}],
    ["lead-2", {}],
    ["peer-b", { status: "running" }],
    ["peer-d", { status: "closed" }],
  ]);
  const { room, root, works, sent, hold, clock } = roomOf(() => listed);
  const first = hold("peer-a", "schema");
  const second = hold("peer-a", "migrations");
  const here = hold("peer-b", "views");
  const third = hold("peer-c", "routes");
  const closed = hold("peer-d", "auth");

  await sweepLeases(room);
  const { store } = works.of(root);
  for (const id of [first, second, third]) {
    assert.equal(store.get(id).assignee, null);
    assert.equal(store.get(id).status, "open");
  }
  for (const id of [here, closed]) {
    assert.equal(store.get(id).status, "in_progress", "a seat at work or at rest keeps its issue");
    assert.ok(Date.parse(store.get(id).lease_until!) > clock.at, "and its lease is pushed forward");
  }
  assert.deepEqual(sent.map((mail) => mail.to).sort(), ["lead-1", "lead-2"], "one mail to each seat's Owner");
  const lead = sent.find((mail) => mail.to === "lead-1")!.text;
  assert.match(lead, /subject="LEASE: 2 claimed issues went back to the board/);
  for (const what of [first, "schema", second, "migrations", "[Peer] schema"]) assert.ok(lead.includes(what), what);
  assert.doesNotMatch(lead, /views|routes/);
  assert.match(lead, /brief a new seat|claim it/i);
  assert.match(
    sent.find((mail) => mail.to === "lead-2")!.text,
    /subject="LEASE: 1 claimed issue went back to the board/,
  );

  await sweepLeases(room);
  assert.equal(sent.length, 2, "nothing more went back, so no more mail");
  works.close();
});

test("a seat whose state the app cannot tell, or a list it cannot give, leaves every lease as it is", async () => {
  let listed: Map<string, Partial<LiveSeat>> | Error = new Map([
    ["peer-b", { status: "initializing", state: "unknown" }],
  ]);
  const { room, root, works, sent, logs, hold } = roomOf(() => {
    if (listed instanceof Error) throw listed;
    return listed;
  });
  const { store } = works.of(root);
  const waiting = hold("peer-b", "views");
  const gone = hold("peer-a", "schema");
  const lapsed = lease(store, waiting);

  await sweepLeases(room);
  assert.equal(store.get(waiting).assignee, "peer-b", "listed but still starting: neither renewed nor given back");
  assert.equal(lease(store, waiting), lapsed);
  assert.equal(store.get(gone).assignee, null, "while the seat that is not listed is given back");
  sent.length = 0;

  const kept = hold("peer-a", "migrations");
  const keptUntil = lease(store, kept);
  listed = new Error("Paseo has handed the room no client yet");
  await sweepLeases(room);
  assert.equal(store.get(kept).assignee, "peer-a");
  assert.equal(lease(store, kept), keptUntil);
  assert.deepEqual(sent, []);
  assert.match(logs.join("\n"), /seats could not be listed.*no client yet/);
  works.close();
});

test("a list with no seat in it is taken for an app still loading: no lease changes", async () => {
  const { room, root, works, logs, hold } = roomOf(() => new Map());
  const id = hold("peer-a", "schema");
  await sweepLeases(room);
  assert.equal(works.of(root).store.get(id).assignee, "peer-a");
  assert.match(logs.join("\n"), /no lease changes: the app lists no seat at all/);
  works.close();
});

test("an Owner that is gone cannot be told, and the issues still go back", async () => {
  const { room, root, works, sent, logs, hold } = roomOf(() => new Map([["sup-1", {}]]));
  const id = hold("peer-a", "schema");
  await sweepLeases(room);
  assert.equal(works.of(root).store.get(id).assignee, null);
  assert.deepEqual(sent, []);
  assert.match(logs.join("\n"), /went back to the board/);
  works.close();
});

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

test("a seat the app shows closed or failed for longer than the set time, or still opening after a lease, gives its claims back; one at rest, or only lately down, keeps them", async () => {
  const listed = new Map<string, Partial<LiveSeat>>([
    ["lead-1", { status: "idle" }],
    ["peer-a", { status: "closed", updatedAt: hoursAgo(DOWN_HOURS + 1) }],
    ["peer-b", { status: "error", updatedAt: hoursAgo(DOWN_HOURS + 1) }],
    ["peer-c", { status: "closed", updatedAt: hoursAgo(DOWN_HOURS - 1) }],
    ["peer-d", { status: "idle", updatedAt: hoursAgo(DOWN_HOURS * 5) }],
    ["peer-e", { status: "closed", updatedAt: "" }],
    ["peer-f", { status: "initializing", state: "unknown", updatedAt: hoursAgo((LEASE + 5) / 60) }],
    ["peer-g", { status: "initializing", state: "unknown", updatedAt: hoursAgo(2 / 60) }],
  ]);
  const { room, root, works, sent, hold, clock } = roomOf(() => listed);
  const closed = hold("peer-a", "schema");
  const failed = hold("peer-b", "views");
  const lately = hold("peer-c", "routes");
  const resting = hold("peer-d", "auth");
  const undated = hold("peer-e", "docs");
  const stuck = hold("peer-f", "search");
  const opening = hold("peer-g", "export");

  await sweepLeases(room);
  const { store } = works.of(root);
  for (const id of [closed, failed, stuck]) {
    assert.equal(store.get(id).assignee, null, "back on the board");
    assert.equal(store.get(id).status, "open");
    assert.match(
      store.comments(id).comments[0].text,
      /(peer-a|peer-b|peer-f) is gone or has stopped.*back on the board/,
    );
  }
  assert.equal(store.get(opening).assignee, "peer-g", "a seat lately opening keeps its claim");
  for (const id of [lately, resting, undated]) {
    assert.equal(store.get(id).status, "in_progress", "kept");
    assert.ok(Date.parse(lease(store, id)!) > clock.at, "and its lease is pushed on");
  }
  assert.equal(sent.length, 1, "its Owner is told once");
  assert.match(sent[0].text, /subject="LEASE: 3 claimed issues went back to the board"/);
  assert.match(sent[0].text, /gone or has stopped/);
  works.close();
});

test("a seat's state is the adapter's own reading of its status: the pass uses it, not a list of status words of its own", async () => {
  // a status the room does not know, read as at rest by the adapter, and a known one read as not yet known
  const listed = new Map<string, Partial<LiveSeat>>([
    ["lead-1", {}],
    ["peer-a", { status: "dozing", state: "idle" }],
    ["peer-b", { status: "idle", state: "unknown" }],
  ]);
  const { room, root, works, hold, clock } = roomOf(() => listed);
  const { store } = works.of(root);
  const a = hold("peer-a", "one");
  const b = hold("peer-b", "two");
  const lapsed = lease(store, b);
  await sweepLeases(room);
  assert.ok(Date.parse(lease(store, a)!) > clock.at, "known: pushed on");
  assert.equal(lease(store, b), lapsed, "not known: neither pushed on nor given back");
  assert.equal(store.get(b).assignee, "peer-b");
  works.close();
});

test(
  "the lease pass is not held by an app that never answers: the pass ends, leaves every lease, and the next one runs",
  { timeout: 5000 },
  async () => {
    let answering = false;
    const host = new PaseoHost({ readSeconds: 0.03, historySeconds: 0.03, writeSeconds: 0.03, startSeconds: 0.03 });
    host.use({
      agents: {
        list: () =>
          answering
            ? Promise.resolve({ entries: [{ agent: { id: "lead-1", status: "idle" } }] })
            : new Promise(() => {}),
      },
    } as never);
    const { room, root, works, logs, hold } = roomOf(() => new Map(), host);
    const id = hold("peer-a", "schema");
    await sweepLeases(room);
    assert.equal(works.of(root).store.get(id).assignee, "peer-a", "no answer, no change");
    assert.match(logs.join("\n"), /seats could not be listed.*did not answer the list of open seats/);
    answering = true;
    await sweepLeases(room);
    assert.equal(works.of(root).store.get(id).assignee, null, "the next pass ran: peer-a is not in the list");
    works.close();
  },
);
