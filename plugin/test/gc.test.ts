import { MAIL_POLICY, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles, Collector, dropSeatTmp, sweepRuntimes } from "../server/gc";
import { MailEngine } from "../server/mail";
import { costLines, roomStats } from "../server/stats";

test("GC archives a seat that is at rest, never one that waits on someone or went back to work", async () => {
  const longAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
  // what agents.list reported, and (when it differs) what the agent is by the time GC reaches it
  const seats: Record<string, { listed: object; now?: object }> = {
    idle: { listed: { status: "idle" } },
    closed: { listed: { status: "closed" } },
    error: { listed: { status: "error" } },
    "pending-permission": { listed: { status: "idle", pendingPermissions: [{ id: "p1" }] } },
    "woke-up": { listed: { status: "idle" }, now: { status: "running" } },
  };
  const archived: string[] = [];
  const paseo = {
    agents: {
      list: async () => ({
        entries: Object.entries(seats).map(([id, seat]) => ({ agent: { id, updatedAt: longAgo, ...seat.listed } })),
      }),
      ref: (id: string) => ({
        refresh: async () => {},
        current: () => ({ id, updatedAt: longAgo, ...(seats[id].now ?? seats[id].listed) }),
        archive: async () => void archived.push(id),
      }),
    },
  };
  const engine = new MailEngine(paseo as never, MAIL_POLICY, { routes: {}, spawn: {} } as never, () => {});
  for (const agentId of Object.keys(seats))
    engine.rememberSeat({ agentId, parentAgentId: null, role: "peer", provider: "claude-peer", title: null });
  const policy = {
    everyMinutes: 10,
    idleHoursBeforeArchive: { peer: 48 },
    deleteOrphanHeartbeats: false,
    tellParent: false,
  };

  await new Collector(
    paseo as never,
    engine,
    policy as never,
    () => {},
    () => {},
  ).run();

  assert.deepEqual(archived, ["idle", "closed", "error"]);
});

const NOW = new Date(2026, 9, 20, 12, 0, 0);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { subject?: string; kind: string })
    : [];

test("GC's file sweep clears what the room left more than a week ago, and keeps what the watcher and a restore still need", () => {
  const mailLog = join(ROOM_HOME, "mail", "log.jsonl");
  const gcLog = join(ROOM_HOME, "gc.log");
  const paseoHome = join(ROOM_HOME, "..", "paseo-of-tidy");
  mkdirSync(join(ROOM_HOME, "mail"), { recursive: true });
  mkdirSync(paseoHome);
  const mail = (days: number, kind: string, subject: string) =>
    JSON.stringify({ at: daysAgo(days), kind, id: `m${days}`, from: "lead", to: "peer", priority: "action", subject });
  writeFileSync(
    mailLog,
    [
      mail(30, "queued", "QUESTION: which unit"),
      mail(30, "delivered-idle", "QUESTION: which unit"),
      mail(20, "queued", "REJECT abc: one repair"),
      mail(20, "delivered-idle", "REJECT abc: one repair"),
      "a torn li",
      mail(2, "queued", "ANSWER: seconds"),
    ].join("\n") + "\n",
  );
  writeFileSync(
    gcLog,
    [
      { at: daysAgo(9), kind: "archived-idle" },
      { at: daysAgo(1), kind: "deleted-heartbeat" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  // the room's backups of config.json, and one file that is not the room's
  for (const name of [
    "config.json.bak-20260901-120000",
    "config.json.bak-20261001-120000",
    "config.json.bak-20261019-120000",
    "config.json.bak-mine",
    "config.json",
  ])
    writeFileSync(join(paseoHome, name), "{}");

  const done = collectFiles(ROOM_HOME, paseoHome, NOW);

  // a verdict stays: the watcher's statistics need it
  assert.deepEqual(
    lines(mailLog).map((line) => `${line.kind} ${line.subject}`),
    ["queued REJECT abc: one repair", "queued ANSWER: seconds"],
  );
  assert.deepEqual(
    lines(gcLog).map((line) => line.kind),
    ["deleted-heartbeat"],
  );
  assert.deepEqual(readdirSync(paseoHome).sort(), [
    "config.json",
    "config.json.bak-20261019-120000",
    "config.json.bak-mine",
  ]);
  assert.equal(done.length, 4);
  assert.deepEqual(collectFiles(ROOM_HOME, paseoHome, NOW), [], "a second sweep found something to clear");

  // the newest backup stays, however old
  assert.deepEqual(
    collectFiles(ROOM_HOME, paseoHome, new Date(2027, 0, 1)).filter((line) => line.includes("backup")),
    [],
  );
});

test("room stats look no further back than the mail log is kept", () => {
  const mailLog = join(ROOM_HOME, "mail", "log.jsonl");
  const queued = (days: number, subject: string) =>
    JSON.stringify({
      at: new Date(Date.now() - days * 86_400_000).toISOString(),
      kind: "queued",
      id: `s${days}`,
      from: "lead",
      to: "peer",
      subject,
    });
  writeFileSync(
    mailLog,
    [queued(10, "ACCEPT abc"), queued(3, "CANDIDATE abc"), queued(1, "ACCEPT abc")].join("\n") + "\n",
  );

  assert.match(roomStats(14), /^mail in the last 7 days: 2\n/);
});

test("room stats count the seats whose work came back three times or more", () => {
  const queued = (to: string, subject: string) =>
    JSON.stringify({ at: new Date().toISOString(), kind: "queued", id: "r", from: "lead", to, subject });
  writeFileSync(
    join(ROOM_HOME, "mail", "log.jsonl"),
    [...["p1", "p1", "p1", "p2"].map((to) => queued(to, "REJECT abc: repair")), queued("p1", "ACCEPT abc")].join("\n") +
      "\n",
  );
  assert.match(roomStats(1), /seats sent back 3 times or more: 1/);
});

test("GC deletes a closed seat's temporary directory after a week and leaves an open seat's", () => {
  const tmp = join(ROOM_HOME, "tmp");
  const old = new Date(Date.now() - 8 * 86_400_000);
  for (const name of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) {
    mkdirSync(join(tmp, name), { recursive: true });
    writeFileSync(join(tmp, name, "scratch.txt"), "x");
  }
  utimesSync(join(tmp, "aaaaaaaa"), old, old);
  utimesSync(join(tmp, "bbbbbbbb"), old, old);
  // aaaaaaaa is closed and old, bbbbbbbb is old and still open, cccccccc was closed today
  assert.deepEqual(dropSeatTmp(tmp, ["bbbbbbbb-1111-2222"]), [join(tmp, "aaaaaaaa")]);
  assert.deepEqual(readdirSync(tmp).sort(), ["bbbbbbbb", "cccccccc"]);
});

test("room stats add up what each seat used, across a seat's reopening", () => {
  const log = join(ROOM_HOME, "usage-test.jsonl");
  const line = (agentId: string, role: string, usd: number, out: number) =>
    JSON.stringify({
      at: new Date().toISOString(),
      agentId,
      role,
      cwd: "/work/demo",
      usage: { totalCostUsd: usd, outputTokens: out },
    });
  // the first seat's total runs up, then starts again at zero after it was reopened
  writeFileSync(
    log,
    [
      line("p1", "peer", 1, 1000),
      line("p1", "peer", 3, 2000),
      line("p1", "peer", 0.5, 500),
      line("l1", "lead", 2, 4000),
    ].join("\n"),
  );
  assert.deepEqual(costLines(0, log), [
    "/work/demo: $5.50 as the agent CLIs report it, 8k output tokens (peer 1 seats $3.50, lead 1 seats $2.00)",
  ]);
});

test("GC clears what agent CLIs left in a seat's home once no seat of it is open, and only what the table names", async () => {
  const runtimes = join(ROOM_HOME, "runtimes-swept");
  const old = new Date(Date.now() - 8 * 86_400_000);
  const put = (path: string, aged = false) => {
    mkdirSync(join(runtimes, path, ".."), { recursive: true });
    writeFileSync(join(runtimes, path), "x");
    if (aged) utimesSync(join(runtimes, path), old, old);
  };
  for (const home of ["codex/lens", "codex/peer"]) {
    put(`${home}/.tmp/plugins/pack`);
    put(`${home}/tmp/scratch`);
    put(`${home}/config.toml`, true);
    put(`${home}/state_5.sqlite`, true);
    put(`${home}/sessions/2026/10/01/old.jsonl`, true);
    put(`${home}/sessions/2026/10/13/new.jsonl`);
    put(`${home}/archived_sessions/old.jsonl`, true);
  }
  // the owner's own sessions, shared into a seat's home by a link, are not the room's
  put("owner/kept.jsonl", true);
  mkdirSync(join(runtimes, "pi", "peer"), { recursive: true });
  symlinkSync(join(runtimes, "owner"), join(runtimes, "pi", "peer", "sessions"));
  const table = {
    codex: {
      rebuilt: [".tmp", "tmp", "../../owner", "/etc"],
      sessions: ["sessions", "archived_sessions", "config.toml"],
    },
    pi: { rebuilt: [], sessions: ["sessions"] },
  };

  const done = sweepRuntimes(runtimes, new Set(["codex-peer"]), table);
  const left = (home: string) =>
    (readdirSync(join(runtimes, home), { recursive: true }) as string[])
      .filter((path) => statSync(join(runtimes, home, path)).isFile())
      .sort();
  // a home with no open seat: what the CLI makes again is gone, old session files are gone, the rest stays
  assert.deepEqual(left("codex/lens"), ["config.toml", "sessions/2026/10/13/new.jsonl", "state_5.sqlite"]);
  assert.ok(!existsSync(join(runtimes, "codex/lens/sessions/2026/10/01")));
  // a home with an open seat is left whole
  assert.equal(left("codex/peer").length, 7);
  assert.ok(existsSync(join(runtimes, "owner", "kept.jsonl")));
  assert.equal(done.length, 4);
  assert.deepEqual(sweepRuntimes(runtimes, new Set(["codex-peer"]), table), []);
  // a room that has not applied this version has no table: nothing is swept
  assert.deepEqual(sweepRuntimes(runtimes, new Set(), {}), []);

  // inside a GC pass, Paseo says which seats are open
  const scratch = (home: string) => join(ROOM_HOME, "runtimes", home, ".tmp");
  for (const home of ["codex/lens", "codex/peer"]) mkdirSync(scratch(home), { recursive: true });
  const seat = { id: "a1", status: "running", updatedAt: new Date().toISOString(), provider: "codex-peer" };
  const paseo = { agents: { list: async () => ({ entries: [{ agent: seat }] }) } };
  const engine = new MailEngine(paseo as never, MAIL_POLICY, { routes: {}, spawn: {} } as never, () => {});
  const policy = { idleHoursBeforeArchive: {}, deleteOrphanHeartbeats: false, tellParent: false, runtimes: table };
  await new Collector(
    paseo as never,
    engine,
    policy as never,
    () => {},
    () => {},
  ).run();
  assert.deepEqual([existsSync(scratch("codex/lens")), existsSync(scratch("codex/peer"))], [false, true]);
});
