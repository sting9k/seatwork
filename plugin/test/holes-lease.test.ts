import { MAIL_POLICY, ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vocabulary from "../shared/work.json";
import { MailEngine } from "../server/coordination/engine";
import type { LiveSeat } from "../server/host";
import { PaseoHost } from "../server/paseo/host";
import { sweepLeases, type RoomContext } from "../server/room/context";
import { WorkStore } from "../server/tasks/store";
import { WorkStores } from "../server/tasks/stores";
import { WORK_DIR } from "../server/tasks/tools";

shipSql();

const LEASE = vocabulary.leaseMinutes;
const DOWN_HOURS = vocabulary.leaseDownHours;
const POLICY = { minReasonChars: 20, forbidSelfClose: true };
const TIMING = { busyTimeoutMs: 5000, flushAfterMs: 60_000 };
const RULES = { ...TIMING, staleClaimMinutes: 120, close: POLICY };
const START = Date.parse("2026-10-14T09:00:00Z");
const LONG_AGO = "2000-01-01T00:00:00.000Z";
const isSeat = (id: string) => /^(peer|lead)-/.test(id);
let made = 0;

/** A work store made before leases: the shipped layout without its last script, with rows put in from outside the store. */
function olderStore(rows: { id: string; status: string; assignee: string | null }[]) {
  const dir = join(ROOM_HOME, `holes-lease-${(made += 1)}`);
  const earlier = join(ROOM_HOME, `holes-lease-layout-${made}`);
  mkdirSync(earlier, { recursive: true });
  const shipped = join(ROOM_HOME, "room", "sql", "work");
  for (const name of readdirSync(shipped).filter((script) => !script.startsWith("V4__")))
    copyFileSync(join(shipped, name), join(earlier, name));
  new WorkStore(dir, TIMING, undefined, earlier).close();
  const raw = new DatabaseSync(join(dir, "work.db"));
  const stamp = new Date(START).toISOString();
  const insert = raw.prepare(
    "INSERT INTO issues (id, title, status, priority, issue_type, assignee, created_at, created_by, updated_at, closed_at) VALUES (?, 'task', ?, 2, 'task', ?, ?, 'lead-1', ?, ?)",
  );
  for (const row of rows)
    insert.run(row.id, row.status, row.assignee, stamp, stamp, row.status === "closed" ? stamp : null);
  raw.close();
  return dir;
}

test("a store opened with held issues that carry no lease gives those of seats of the room one, and leaves a person's claim alone", () => {
  const dir = olderStore([
    { id: "sw-a", status: "in_progress", assignee: "peer-a" },
    { id: "sw-b", status: "open", assignee: "peer-b" },
    { id: "sw-c", status: "deferred", assignee: "lead-1" },
    { id: "sw-d", status: "in_progress", assignee: "alice" },
    { id: "sw-e", status: "closed", assignee: "peer-a" },
    { id: "sw-f", status: "open", assignee: null },
  ]);
  const clock = { at: START };
  const store = new WorkStore(dir, TIMING, () => new Date(clock.at), undefined, isSeat);
  assert.equal(store.get("sw-a").lease_until, null, "a store made before leases opens as it was");
  store.leaseHeld();
  const lease = (id: string) => store.get(id).lease_until;
  const begins = new Date(START + LEASE * 60_000).toISOString();
  for (const id of ["sw-a", "sw-b", "sw-c"]) assert.equal(lease(id), begins, id);
  for (const id of ["sw-d", "sw-e", "sw-f"]) assert.equal(lease(id), null, id);
  assert.equal(store.get("sw-a").revision, 1, "a lease is no progress: the issue is not rewritten");
  assert.equal(store.events("sw-a").length, 0);
  assert.equal(store.get("sw-a").updated_at, new Date(START).toISOString());

  // from then on the lease runs as any other: with its seat gone, the issues go back
  clock.at += (LEASE + 1) * 60_000;
  assert.deepEqual(
    store
      .expireLeases([], 20)
      .map((one) => one.id)
      .sort(),
    ["sw-a", "sw-b", "sw-c"],
  );
  assert.equal(store.get("sw-d").assignee, "alice");
  store.close();

  const again = new WorkStore(dir, TIMING, () => new Date(clock.at), undefined, isSeat);
  again.leaseHeld();
  assert.equal(again.get("sw-d").lease_until, null, "opened again, a person's claim still holds none");
  again.close();
});

test("the room's stores give the leases when a project's store is opened", () => {
  const dir = olderStore([
    { id: "sw-a", status: "in_progress", assignee: "peer-a" },
    { id: "sw-d", status: "in_progress", assignee: "alice" },
  ]);
  const root = join(ROOM_HOME, `holes-lease-root-${(made += 1)}`);
  mkdirSync(join(root, WORK_DIR), { recursive: true });
  copyFileSync(join(dir, "work.db"), join(root, WORK_DIR, "work.db"));
  const stores = new WorkStores(RULES, () => {}, isSeat);
  const { store } = stores.of(root);
  assert.ok(Date.parse(store.get("sw-a").lease_until!) > Date.now());
  assert.equal(store.get("sw-d").lease_until, null);
  stores.close();
});

test("the leases given when a store opens cost a few statements however many issues are held, found by the index of the holder", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: `sw-${i}`,
    status: i % 3 === 0 ? "closed" : "in_progress",
    assignee: `peer-${i % 40}`,
  }));
  const dir = olderStore(rows);
  const store = new WorkStore(dir, TIMING, () => new Date(START), undefined, isSeat);
  const before = store.stat().calls;
  store.leaseHeld();
  const used = store.stat().calls - before;
  assert.ok(used <= 4, `${used} statements to give 40 holders their leases`);
  const again = store.stat().calls;
  store.leaseHeld();
  assert.ok(store.stat().calls - again <= 1, "with nothing left to give, one read");
  const plans = store.plans().filter(({ sql }) => sql.includes("lease_until IS NULL"));
  assert.ok(plans.length >= 2, "the read and the write");
  for (const { sql, plan } of plans) assert.match(plan, /USING (COVERING )?INDEX issues_by_assignee/, sql);
  store.close();
});

/** A room of a Lead and Peers over one project, with a host whose list of seats is `open`. */
function roomOf(open: () => Map<string, Partial<LiveSeat>>, host?: PaseoHost) {
  const root = join(ROOM_HOME, `holes-lease-room-${(made += 1)}`);
  mkdirSync(root, { recursive: true });
  const sent: { to: string; text: string }[] = [];
  const logs: string[] = [];
  const engine = new MailEngine(
    {
      state: async () => "idle",
      send: async (to, text) => void sent.push({ to, text }),
      reparent: async () => {},
    },
    MAIL_POLICY,
    (line) => logs.push(line),
    { rootOf: () => root },
  );
  const seat = (agentId: string, role: string, parent: string | null) =>
    engine.rememberSeat({
      agentId,
      parentAgentId: parent,
      role,
      provider: `claude-${role}`,
      title: agentId,
      cwd: root,
    });
  seat("lead-1", "lead", null);
  for (const peer of ["peer-a", "peer-b", "peer-c", "peer-d", "peer-e"]) seat(peer, "peer", "lead-1");
  const works = new WorkStores(
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
    const db = new DatabaseSync(join(root, ".seatwork", ".work", "work.db"));
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("UPDATE issues SET lease_until = ? WHERE id = ?").run(LONG_AGO, id);
    db.close();
    return id;
  };
  return { room, root, works, sent, logs, hold };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

test("a seat the app shows closed or failed for longer than the set time gives its claims back; one that is at rest, or only lately down, keeps them", async () => {
  const listed = new Map<string, Partial<LiveSeat>>([
    ["lead-1", { status: "idle" }],
    ["peer-a", { status: "closed", updatedAt: hoursAgo(DOWN_HOURS + 1) }],
    ["peer-b", { status: "error", updatedAt: hoursAgo(DOWN_HOURS + 1) }],
    ["peer-c", { status: "closed", updatedAt: hoursAgo(DOWN_HOURS - 1) }],
    ["peer-d", { status: "idle", updatedAt: hoursAgo(DOWN_HOURS * 5) }],
    ["peer-e", { status: "closed", updatedAt: "" }],
  ]);
  const { room, root, works, sent, hold } = roomOf(() => listed);
  const closed = hold("peer-a", "schema");
  const failed = hold("peer-b", "views");
  const lately = hold("peer-c", "routes");
  const resting = hold("peer-d", "auth");
  const undated = hold("peer-e", "docs");

  await sweepLeases(room);
  const { store } = works.of(root);
  for (const id of [closed, failed]) {
    assert.equal(store.get(id).assignee, null, "back on the board");
    assert.equal(store.get(id).status, "open");
    assert.match(store.comments(id).comments[0].text, /(peer-a|peer-b) is gone or has stopped.*back on the board/);
  }
  for (const id of [lately, resting, undated]) {
    assert.equal(store.get(id).status, "in_progress", "kept");
    assert.ok(Date.parse(store.get(id).lease_until!) > Date.now(), "and its lease is pushed on");
  }
  assert.equal(sent.length, 1, "its Owner is told once");
  assert.match(sent[0].text, /subject="LEASE: 2 claimed issues went back to the board"/);
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
  const { room, root, works, hold } = roomOf(() => listed);
  const a = hold("peer-a", "one");
  const b = hold("peer-b", "two");
  await sweepLeases(room);
  const { store } = works.of(root);
  assert.ok(Date.parse(store.get(a).lease_until!) > Date.now(), "known: pushed on");
  assert.equal(store.get(b).lease_until, LONG_AGO, "not known: neither pushed on nor given back");
  assert.equal(store.get(b).assignee, "peer-b");
  works.close();
});

test("the adapter reads a seat's state the same way for the list of open seats and for one seat", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ status: "idle" }, "idle"],
    [{ status: "running" }, "running"],
    [{ status: "closed" }, "idle"],
    [{ status: "error" }, "idle"],
    [{ status: "initializing" }, "unknown"],
    [{ status: "running", pendingPermissions: [{}] }, "permission"],
    [{ status: "idle", archivedAt: "2026-10-14T00:00:00Z" }, "gone"],
  ];
  const agents = new Map<string, Record<string, unknown>>(
    cases.map(([agent], index) => [`seat-${index}`, { id: `seat-${index}`, ...agent }]),
  );
  const host = new PaseoHost();
  host.use({
    agents: {
      ref: (id: string) => ({ refresh: async () => {}, current: () => agents.get(id) ?? null }),
      list: async () => ({
        entries: [...agents.values()].filter((agent) => !agent.archivedAt).map((agent) => ({ agent })),
      }),
    },
  } as never);
  const live = await host.live();
  for (const [index, [agent, state]] of cases.entries()) {
    const id = `seat-${index}`;
    assert.equal(await host.state(id), state, JSON.stringify(agent));
    if (state !== "gone") assert.equal(live.get(id)?.state, state, JSON.stringify(agent));
    else assert.equal(live.has(id), false);
  }
});

test(
  "the lease pass is not held by an app that never answers: the pass ends, leaves every lease, and the next one runs",
  { timeout: 5000 },
  async () => {
    let answering = false;
    const host = new PaseoHost({ readSeconds: 0.03, historySeconds: 0.03, writeSeconds: 0.03 });
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
