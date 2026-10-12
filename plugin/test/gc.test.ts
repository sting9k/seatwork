import { MAIL_POLICY, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles, Collector } from "../server/gc";
import { MailEngine } from "../server/mail";
import { roomStats } from "../server/stats";

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
