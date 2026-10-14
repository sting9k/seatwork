import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Message } from "../server/coordination/store";
import type { TurnEvent } from "../server/host";
import { Knowledge, type KnowledgePolicy } from "../server/knowledge/index";
import { KnowledgeRefused } from "../server/knowledge/refused";
import { withoutMail } from "../server/coordination/envelope";
import { lintStatement, promptBlock, topicOf } from "../server/knowledge/decisions";
import { Jev } from "../server/jev/index";
import { eventOf } from "../server/paseo/timeline";
import type { Judge } from "../server/knowledge/gate";
import { entriesOf, RECORD_LIMITS, turnRef } from "../server/knowledge/record";
import { ftsQueries, pack } from "../server/knowledge/search";
import { KnowledgeStore, type Found, type Source } from "../server/knowledge/store";
import { BRIEF } from "./support/timeline";

shipSql();

const POLICY: KnowledgePolicy = { mode: "on", keepDays: 60 };
let homes = 0;

/** A district over its own folders; `mail` stands in for the mail store a reader keeps its place in. */
function district(
  options: {
    policy?: KnowledgePolicy;
    mail?: (Message & { to: string[] })[];
    now?: () => Date;
    owns?: (agent: string, task: string) => boolean;
    full?: (task: string) => string;
    taskOf?: (agent: string) => string;
    judge?: Judge;
    threadsOf?: (agent: string) => string[];
  } = {},
) {
  const home = join(ROOM_HOME, `knowledge-${(homes += 1)}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const project = join(home, "project");
  const lines: string[] = [];
  const knowledge = new Knowledge({
    roomDir: join(home, "room"),
    policy: () => options.policy ?? POLICY,
    projectOf: (agent) => (agent.startsWith("hq") ? null : project),
    projects: () => [project],
    mailAfter: (root, id, limit) =>
      root === project ? (options.mail ?? []).filter((mail) => mail.id > id).slice(0, limit) : [],
    seen: (reader) => (reader.startsWith("lead") || reader.startsWith("hq") ? null : [reader]),
    ownedTask: (agent, task) =>
      task === "T-1" || (options.owns?.(agent, task) ?? false) ? (options.full?.(task) ?? task) : null,
    isRoomSeat: (agent) => agent.startsWith("hq"),
    briefs: (agent) => agent.startsWith("lead"),
    taskOf: options.taskOf ?? (() => "T-1"),
    rootOf: () => project,
    threadsOf: options.threadsOf ?? (() => []),
    judge: options.judge ?? null,
    busyTimeoutMs: 1000,
    now: options.now,
    log: (line) => lines.push(line),
  });
  return { knowledge, project, lines };
}

const turn = (
  agent: string,
  events: TurnEvent[],
  extra: { turnId?: string | null; parentId?: string | null } = {},
) => ({
  agent,
  parentId: extra.parentId ?? null,
  role: "peer",
  task: "T-1",
  turnId: extra.turnId === undefined ? `turn-${agent}` : extra.turnId,
  outcome: "completed",
  events,
});

const ask = (knowledge: Knowledge, agent: string, args: Record<string, unknown>) =>
  knowledge.recall(agent, args) as Record<string, unknown>;

test("a turn is kept once as entries: typed words, the start brief, mail taken out, secrets hidden", () => {
  const events: TurnEvent[] = [
    { kind: "prompt", text: "Add the login endpoint" },
    {
      kind: "prompt",
      text: '<mail id="4" from="lead" subject="REVIEW: x" needs="nothing" thread="T-1">\nlooks fine\n</mail>\n\nuse pnpm',
    },
    { kind: "think", text: "my private reasoning" },
    {
      kind: "shell",
      command: "cat .env",
      exitCode: 0,
      output: "STRIPE_SK=sk_live_abcdefghijklmnop1234",
      status: "completed",
    },
    { kind: "shell", command: "npm test", exitCode: 1, output: "1 failing", status: "completed" },
    { kind: "tool", name: "Skill", label: "debugging", status: "completed" },
    { kind: "say", text: "Done; OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa was not needed" },
  ];
  const entries = entriesOf(events, true);
  assert.deepEqual(
    entries.map((entry) => `${entry.ordinal}:${entry.kind}`),
    ["0:prompt", "1:owner", "3:shell", "4:shell", "5:tool", "6:say"],
    "a seat's reasoning is not kept",
  );
  assert.equal(entries[1].text, "use pnpm", "mail is read from the mail store, not from the prompt that carried it");
  assert.match(entries[2].text, /output not kept/);
  assert.equal(entries[3].exitCode, 1);
  assert.ok(!entries[5].text.includes("sk-proj-aaaa"));
  const passed = entriesOf(
    [
      {
        kind: "shell",
        command: "npm test",
        exitCode: 0,
        output: `${"ok ".repeat(500)}all passed`,
        status: "completed",
      },
    ],
    false,
  )[0].text;
  assert.ok(passed.endsWith("all passed") && passed.length <= "$ npm test\n".length + RECORD_LIMITS.passedOutput);

  const { knowledge } = district();
  knowledge.turnStarted("peer-a");
  assert.equal(knowledge.turnEnded(turn("peer-a", events, { parentId: "lead" })), true);
  assert.equal(knowledge.turnEnded(turn("peer-a", events, { parentId: "lead" })), false, "kept once");
  assert.equal(turnRef("peer-a", null, events, "t1"), turnRef("peer-a", null, [...events], "t1"));
  assert.notEqual(
    turnRef("peer-a", null, events, "t1"),
    turnRef("peer-a", null, events, "t2"),
    "a repeat is a new turn",
  );
  const kinds = ask(knowledge, "peer-a", { do: "search", q: "login endpoint" }).hits as { kind: string }[];
  assert.deepEqual(
    kinds.map((hit) => hit.kind),
    ["prompt"],
    "the first prompt of a seat another seat opened is that seat's brief",
  );

  const long = Array.from({ length: RECORD_LIMITS.entries + 40 }, (_, i): TurnEvent =>
    i === 70 ? { kind: "prompt", text: "stop and use yarn" } : { kind: "say", text: `step ${i}` },
  );
  const kept = entriesOf(long, false);
  assert.equal(kept.length, RECORD_LIMITS.entries + 1);
  assert.deepEqual(
    [kept[0].ordinal, kept.at(-1)!.ordinal],
    [0, RECORD_LIMITS.entries + 39],
    "head and end, a gap between",
  );
  assert.ok(
    kept.some((entry) => entry.kind === "owner" && entry.ordinal === 70),
    "a person's words are never cut",
  );
  knowledge.close();
});

test("search reads words in any form, finds more with other phrasings, and keeps accented words apart", () => {
  const { knowledge } = district();
  knowledge.turnEnded(
    turn("peer-b", [
      { kind: "say", text: "The tests failed on the login form" },
      { kind: "say", text: "Switched the session store to Redis" },
      { kind: "prompt", text: "đừng mock DB" },
      { kind: "prompt", text: "dùng pnpm" },
    ]),
  );
  const hits = (args: Record<string, unknown>) =>
    (ask(knowledge, "peer-b", { do: "search", ...args }).hits as { address: string; text: string }[]).map(
      (hit) => hit.address,
    );
  assert.deepEqual(hits({ q: "test fails" }), ["turn:peer-b:turn-peer-b#0"], "porter reads tests and test as one word");
  assert.deepEqual(hits({ q: "cache backend" }), []);
  assert.deepEqual(hits({ q: "cache backend", also: ["Redis session"] }), ["turn:peer-b:turn-peer-b#1"]);
  assert.deepEqual(hits({ q: "dùng" }), ["turn:peer-b:turn-peer-b#3"], "đừng (don't) is not dùng (use)");
  assert.deepEqual(hits({ q: "login", kinds: ["owner"] }), []);
  const understood = ask(knowledge, "peer-b", { do: "search", q: "login redis" }).understood as { matched: string }[];
  assert.deepEqual(
    understood.map((one) => one.matched),
    ["any"],
    "no entry has both words: any of them is tried",
  );
  assert.throws(() => knowledge.recall("peer-b", { do: "search", q: "x", kinds: ["poem"] }), KnowledgeRefused);
  assert.throws(() => knowledge.recall("peer-b", { do: "nothing" }), KnowledgeRefused);
  knowledge.close();
});

test("view and expand read by address; an address whose turn is past its days says expired", () => {
  let now = new Date("2026-10-01T00:00:00Z");
  const { knowledge } = district({ now: () => now });
  knowledge.turnStarted("peer-c");
  knowledge.turnEnded(
    turn(
      "peer-c",
      Array.from({ length: 12 }, (_, i): TurnEvent => ({ kind: "say", text: `line ${i}` })),
    ),
  );
  const view = ask(knowledge, "peer-c", { do: "view", address: "turn:peer-c:turn-peer-c#4" });
  assert.deepEqual(
    (view.entries as { text: string }[]).map((entry) => entry.text),
    ["line 4"],
  );
  const around = ask(knowledge, "peer-c", { do: "expand", address: "turn:peer-c:turn-peer-c#4", around: 2 });
  assert.deepEqual(
    (around.entries as { text: string }[]).map((entry) => entry.text),
    ["line 2", "line 3", "line 4", "line 5", "line 6"],
  );
  assert.throws(() => knowledge.recall("peer-c", { do: "view", address: "nowhere" }), KnowledgeRefused);

  now = new Date("2026-12-15T00:00:00Z");
  assert.equal(knowledge.expire(), 12);
  assert.deepEqual(ask(knowledge, "peer-c", { do: "view", address: "turn:peer-c:turn-peer-c#4" }), {
    address: "turn:peer-c:turn-peer-c#4",
    expired: true,
    entries: [],
  });
  knowledge.close();
});

test("a pack is chosen by a fixed formula into its budget, read in order, failures marked and repeats counted", () => {
  const at = (day: number) => `2026-10-0${day}T00:00:00.000Z`;
  const found = (
    id: number,
    day: number,
    kind: Found["kind"],
    text: string,
    exitCode: number | null = null,
  ): Found => ({
    id,
    kind,
    ordinal: id,
    text,
    exitCode,
    source: {
      kind: "turn",
      ref: `s:${day}`,
      agent: "peer",
      role: "peer",
      task: "T-1",
      startedAt: at(day),
      outcome: "completed",
      audience: ["peer"],
    },
  });
  const pool = [
    found(1, 1, "read", "src/a.ts"),
    found(2, 1, "owner", "use pnpm"),
    found(3, 2, "shell", "$ npm test\n1 failing", 1),
    found(4, 3, "say", "fixed"),
    found(5, 3, "say", "fixed"),
    found(6, 3, "change", "y".repeat(500)),
  ];
  const packed = pack("T-1", pool, 60);
  assert.deepEqual(
    packed.items.map((item) => `${item.address} ${item.trust}`),
    ["turn:s:1#1 turn", "turn:s:1#2 turn", "turn:s:2#3 failed command", "turn:s:3#4 turn"],
  );
  assert.deepEqual(packed.left, { budget: 1, repeated: 1 });
  assert.ok(packed.used <= 60);
  assert.deepEqual(pack("T-1", pool, 60), packed, "the same pool packs the same way");
});

test("mail is read once from where the reader stopped, each mail kept for its sender and readers, secrets hidden", () => {
  const mail = (id: number, senderRole: string, subject: string, body: string): Message & { to: string[] } => ({
    id,
    at: `2026-10-14T0${id}:00:00.000Z`,
    thread: "T-1",
    replyTo: null,
    sender: senderRole === "system" ? "room" : "lead-1",
    senderRole,
    signal: subject.split(":")[0],
    subject,
    body,
    file: null,
    files: [],
    needs: "nothing",
    why: "",
    answeredAt: null,
    answeredBy: null,
    to: ["peer-d"],
  });
  const box = [
    mail(1, "lead", "REJECT: the login form", "The form posts the password in clear; token=Zx9Qw8Er7Ty6Ui5Op4 leaked"),
    mail(2, "system", "COUNCIL: claims on Peer", "claims: the report says tests pass and no check passed"),
  ];
  const { knowledge, project } = district({ mail: box });
  assert.equal(knowledge.readMail(), 2);
  assert.equal(knowledge.readMail(), 0, "nothing is read twice");
  box.push(mail(3, "lead", "ACCEPT: the login form", "Good"));
  assert.equal(knowledge.readMail(), 1);
  const hits = ask(knowledge, "peer-d", { do: "search", q: "login form", kinds: ["mail"] }).hits as { text: string }[];
  assert.equal(hits.length, 2);
  assert.ok(!JSON.stringify(hits).includes("Zx9Qw8Er7Ty6Ui5Op4"));
  const db = (knowledge.storeOf(project) as unknown as { db: DatabaseSync }).db;
  const kept = db.prepare("SELECT ref, audience FROM sources ORDER BY ref").all() as {
    ref: string;
    audience: string;
  }[];
  assert.deepEqual(
    kept.map((row) => `${row.ref}:${row.audience}`),
    ["1:lead-1,peer-d", "2:room,peer-d", "3:lead-1,peer-d"],
  );
  knowledge.close();
});

test("old entries go in slices with their sources, the full-text index follows, and freed pages go back", () => {
  const dir = join(ROOM_HOME, "knowledge-expire");
  rmSync(dir, { recursive: true, force: true });
  const store = new KnowledgeStore(dir, 1000);
  const source = (ref: string, at: string): Source => ({
    kind: "turn",
    ref,
    agent: "peer",
    role: "peer",
    task: "T-1",
    thread: "",
    startedAt: at,
    endedAt: at,
    outcome: "completed",
    audience: ["peer"],
  });
  const entries = Array.from({ length: 4500 }, (_, ordinal) => ({
    ordinal,
    kind: "say" as const,
    text: `old word ${ordinal}`,
    exitCode: null,
  }));
  store.add(source("old", "2026-01-01T00:00:00.000Z"), entries);
  store.add(source("new", "2026-10-01T00:00:00.000Z"), [{ ordinal: 0, kind: "say", text: "new word", exitCode: null }]);
  const cut = new Date("2026-06-01T00:00:00Z");
  assert.equal(store.expire(cut), 4500);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count("SELECT count(*) AS n FROM entries"), 1);
  assert.equal(count("SELECT count(*) AS n FROM sources"), 1);
  assert.equal(count("SELECT count(*) AS n FROM entries_fts WHERE entries_fts MATCH 'old'"), 0);
  db.exec("INSERT INTO entries_fts (entries_fts, rank) VALUES ('integrity-check', 1)");
  assert.equal(
    (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
    0,
    "freed pages go back",
  );
  store.close();
});

test("a seat reads what it and the seats under it saw: a reviewer does not read the turns it reviews", () => {
  const { knowledge } = district({
    mail: [
      {
        id: 1,
        at: "2026-10-14T01:00:00.000Z",
        thread: "T-1",
        replyTo: null,
        sender: "lead-1",
        senderRole: "lead",
        signal: "REVIEW",
        subject: "REVIEW: the cache layer",
        body: "Read the cache layer with fresh eyes",
        file: null,
        files: [],
        needs: "reply",
        why: "",
        answeredAt: null,
        answeredBy: null,
        to: ["lens-1"],
      },
    ],
  });
  knowledge.turnEnded(turn("peer-g", [{ kind: "say", text: "The cache layer keeps stale entries on purpose" }]));
  knowledge.readMail();
  const hits = (reader: string) =>
    (ask(knowledge, reader, { do: "search", q: "cache layer" }).hits as { kind: string }[]).map((hit) => hit.kind);
  assert.deepEqual(hits("lead-1").sort(), ["mail", "say"], "the lead reads the turn under it and the mail it sent");
  assert.deepEqual(hits("lens-1"), ["mail"], "the reviewer reads the mail sent to it, not the turn it reviews");
  assert.throws(
    () => knowledge.recall("lens-1", { do: "view", address: "turn:peer-g:turn-peer-g#0" }),
    /not yours to read/,
  );
  knowledge.close();
});

test("past its entry cap a store gives up its oldest entries first, and no more than it is over", () => {
  const dir = join(ROOM_HOME, "knowledge-cap");
  rmSync(dir, { recursive: true, force: true });
  const store = new KnowledgeStore(dir, 1000);
  const source = (ref: string, at: string): Source => ({
    kind: "turn",
    ref,
    agent: "peer",
    role: "peer",
    task: "T-1",
    thread: "",
    startedAt: at,
    endedAt: at,
    outcome: "completed",
    audience: ["peer"],
  });
  const many = Array.from({ length: 4500 }, (_, ordinal) => ({
    ordinal,
    kind: "say" as const,
    text: `w ${ordinal}`,
    exitCode: null,
  }));
  store.add(source("older", "2026-10-01T00:00:00.000Z"), many);
  store.add(source("newer", "2026-10-02T00:00:00.000Z"), [{ ordinal: 0, kind: "say", text: "kept", exitCode: null }]);
  const longAgo = new Date("2026-01-01T00:00:00Z");
  assert.equal(store.expire(longAgo, 3000), 1501);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const older = db
    .prepare("SELECT min(e.ordinal) AS n FROM entries e JOIN sources s ON s.id = e.source_id WHERE s.ref = 'older'")
    .get() as { n: number };
  assert.equal(older.n, 1501, "the oldest went first");
  assert.equal((db.prepare("SELECT count(*) AS n FROM entries").get() as { n: number }).n, 3000, "no more than over");
  assert.equal(store.slice("turn", "newer", 0, 0)[0].text, "kept");
  store.close();
});

/** A seat's turn that ends with these events, its decisions settled on the person's words in them. */
function endTurn(knowledge: Knowledge, agent: string, events: TurnEvent[], turnId: string) {
  knowledge.turnEnded({ ...turn(agent, events, { turnId }), role: agent.split("-")[0] });
}

const decide = async (knowledge: Knowledge, agent: string, args: Record<string, unknown>) =>
  (await knowledge.act(agent, { do: "decide", ...args })) as Record<string, unknown>;

test("a person's decision recorded by the room's seat takes effect when its turn ends, on the person's words in it", async () => {
  const { knowledge } = district();
  knowledge.turnStarted("hq-1");
  const asked = await decide(knowledge, "hq-1", {
    scope: "project",
    project: "project",
    topic: "Package manager",
    statement: "Use pnpm for every install; never npm.",
  });
  assert.equal(asked.state, "pending");
  assert.match(String(asked.line), /^Pending: .* nothing is in force yet/);
  assert.deepEqual((ask(knowledge, "peer-a", { do: "list" }).inForce as string[]).length, 0, "pending binds no one");
  endTurn(
    knowledge,
    "hq-1",
    [
      { kind: "prompt", text: "từ mai dùng pnpm nhé" },
      { kind: "say", text: "ok" },
    ],
    "t1",
  );
  const list = ask(knowledge, "peer-a", { do: "list" });
  assert.deepEqual(list.inForce, [
    `- [project] package-manager: Use pnpm for every install; never npm. (since ${String(list.now).slice(0, 10)}; v1)`,
  ]);
  const book = knowledge.storeOf(null) as unknown as { db: DatabaseSync };
  assert.deepEqual(
    { ...(book.db.prepare("SELECT address, text FROM decision_sources").get() as object) },
    { address: "turn:hq-1:t1#0", text: "từ mai dùng pnpm nhé" },
    "the person's own words stay beside the decision, in their own language",
  );
  const told = ask(knowledge, "hq-1", { do: "list" }).notices as string[];
  assert.match(told[0], /Recorded: Use pnpm/);
  knowledge.close();
});

test("only the room's seat records a room's or a project's decision; a seat that briefs records its task's at once", async () => {
  const { knowledge } = district();
  await assert.rejects(
    () =>
      decide(knowledge, "peer-b", {
        scope: "project",
        project: "project",
        topic: "db",
        statement: "Use SQLite for the store.",
      }),
    /recorded by the room's own seat/,
  );
  await assert.rejects(
    () => decide(knowledge, "peer-b", { scope: "task", topic: "db", statement: "Use SQLite for the store." }),
    /only a seat that briefs/,
  );
  const task = await decide(knowledge, "lead-1", {
    scope: "task",
    topic: "db",
    statement: "Use SQLite for the store.",
  });
  assert.deepEqual([task.state, task.version], ["active", 1]);
  assert.match((ask(knowledge, "peer-b", { do: "list" }).inForce as string[])[0], /\[task T-1\] db: Use SQLite/);
  knowledge.close();
});

test("a change restates the whole decision against the version in force; a stale base or a near topic is refused", async () => {
  const { knowledge } = district();
  await decide(knowledge, "lead-2", {
    scope: "task",
    topic: "package manager",
    statement: "Use pnpm for every install.",
  });
  await assert.rejects(
    () =>
      decide(knowledge, "lead-2", {
        scope: "task",
        topic: "package manager",
        statement: "Use yarn for every install.",
      }),
    /in force at version 1: "Use pnpm for every install\."/,
  );
  const changed = await decide(knowledge, "lead-2", {
    scope: "task",
    topic: "package manager",
    statement: "Use yarn for every install, pnpm is dropped.",
    replaces_version: 1,
  });
  assert.equal(changed.version, 2);
  await assert.rejects(
    () => decide(knowledge, "lead-2", { scope: "task", topic: "pkg manager", statement: "Use bun for installs." }),
    /topics near pkg-manager are in force: package-manager v2/,
  );
  assert.equal(
    (
      await decide(knowledge, "lead-2", {
        scope: "task",
        topic: "pkg manager",
        statement: "Use bun for installs.",
        new_topic: true,
      })
    ).state,
    "active",
  );
  knowledge.close();
});

test("a temporary decision ends on its date and gives the topic back; a withdrawal gives it back too", async () => {
  let now = new Date("2026-10-14T10:00:00Z");
  const { knowledge } = district({ now: () => now });
  await decide(knowledge, "lead-3", {
    scope: "task",
    topic: "slow tests",
    statement: "Run the slow tests on every push.",
  });
  const temporary = await decide(knowledge, "lead-3", {
    scope: "task",
    topic: "slow tests",
    statement: "Run the slow tests only at night until the release.",
    replaces_version: 1,
    valid_until: "2026-10-18T00:00:00Z",
  });
  assert.equal(temporary.version, 2);
  now = new Date("2026-10-18T00:01:00Z");
  knowledge.tick();
  assert.match((ask(knowledge, "lead-3", { do: "list" }).inForce as string[])[0], /Run the slow tests on every push\./);
  await decide(knowledge, "lead-3", {
    scope: "task",
    topic: "slow tests",
    statement: "Run the slow tests twice a day.",
    replaces_version: 1,
  });
  const withdrawn = (await knowledge.act("lead-3", {
    do: "withdraw",
    scope: "task",
    topic: "slow tests",
    reason: "The twice a day schedule was a mistake.",
    replaces_version: 2,
  })) as Record<string, unknown>;
  assert.match(
    String(withdrawn.line),
    /^Withdrawn: slow-tests v2\. In force again: Run the slow tests on every push\./,
  );
  await assert.rejects(
    () =>
      decide(knowledge, "lead-3", {
        scope: "task",
        topic: "deadline",
        statement: "Ship the release candidate.",
        valid_until: "2026-01-01",
      }),
    /valid_until .* is past; today is 2026-10-18/,
  );
  // a day its month does not have, a time with no zone and a date in words would each land on another day
  for (const valid_until of ["2026-11-31", "2026-11-01T09:00", "November 1 2026"])
    await assert.rejects(
      () => decide(knowledge, "lead-3", { scope: "task", topic: "freeze", statement: "Freeze the API.", valid_until }),
      /valid_until is not an ISO date like 2026-11-01/,
    );
  assert.throws(() => ask(knowledge, "lead-3", { do: "search", q: "slow tests", since: "yesterday" }), /`since` is/);
  knowledge.close();
});

test("a replaced decision stays past the year closed ones are kept while it can come back, then goes", async () => {
  let now = new Date("2026-10-15T00:00:00.000Z");
  const { knowledge } = district({ now: () => now });
  const record = async (args: Record<string, unknown>, turnId: string) => {
    knowledge.turnStarted("hq-r");
    await decide(knowledge, "hq-r", { scope: "room", topic: "package manager", ...args });
    endTurn(knowledge, "hq-r", [{ kind: "prompt", text: "the package manager" }], turnId);
  };
  await record({ statement: "Use pnpm for every install." }, "t1");
  await record(
    { statement: "Use bun for every install while pnpm is broken.", replaces_version: 1, valid_until: "2028-06-01" },
    "t2",
  );
  now = new Date("2027-12-01T00:00:00.000Z");
  knowledge.expire();
  now = new Date("2028-06-02T00:00:00.000Z");
  knowledge.tick();
  assert.deepEqual(ask(knowledge, "hq-r", { do: "list" }).inForce, [
    "- [room] package-manager: Use pnpm for every install. (since 2026-10-15; v1)",
  ]);
  now = new Date("2029-07-01T00:00:00.000Z");
  knowledge.expire();
  assert.deepEqual(
    rowsOf(knowledge, null, "SELECT id, state FROM decisions ORDER BY id"),
    [{ id: 1, state: "active" }],
    "the ended one goes once its year is past",
  );
  knowledge.close();
});

test("no person's words, no decision; words of an earlier turn carry a decision by their address, once", async () => {
  const { knowledge } = district();
  knowledge.turnStarted("hq-2");
  await decide(knowledge, "hq-2", { scope: "room", topic: "push", statement: "Push through a pull request only." });
  endTurn(knowledge, "hq-2", [{ kind: "say", text: "I think we should use pull requests" }], "t1");
  assert.match(
    (ask(knowledge, "hq-2", { do: "list" }).notices as string[])[0],
    /^\[knowledge\] Dropped: no person's words/,
  );
  assert.equal((ask(knowledge, "hq-2", { do: "list" }).inForce as string[]).length, 0);

  knowledge.turnStarted("hq-2");
  endTurn(knowledge, "hq-2", [{ kind: "prompt", text: "push qua PR thôi, đừng đẩy thẳng main" }], "t2");
  assert.equal(ask(knowledge, "hq-2", { do: "list" }).notices, undefined, "words with no decision bring no reminder");
  await assert.rejects(
    () =>
      decide(knowledge, "hq-2", {
        scope: "room",
        topic: "push",
        statement: "Push through a pull request only.",
        from: "turn:hq-2:t1#0",
      }),
    /holds no person's words/,
  );
  const made = await decide(knowledge, "hq-2", {
    scope: "room",
    topic: "push",
    statement: "Push through a pull request; push to main only on the owner's word.",
    from: "turn:hq-2:t2#0",
  });
  assert.deepEqual([made.state, made.version], ["active", 1]);
  await assert.rejects(
    () =>
      decide(knowledge, "hq-2", {
        scope: "room",
        topic: "merge",
        statement: "Squash every merge.",
        from: "turn:hq-2:t2#0",
      }),
    /already carries a decision/,
  );
  knowledge.close();
});

test("a decision is one English sentence with no secret, no relative date, and nothing that turns a rule off", () => {
  assert.equal(topicOf("  Package Manager! "), "package-manager");
  assert.equal(topicOf("đ"), null);
  assert.equal(lintStatement("Use pnpm for every install."), null);
  assert.equal(
    lintStatement("Keep the error text `Không tìm thấy` as it is."),
    null,
    "a product's own words in backticks",
  );
  assert.equal(
    lintStatement("Never skip the tests before a release."),
    null,
    "a rule that keeps a check is no override",
  );
  for (const [statement, why] of [
    ["dùng pnpm cho mọi lần cài", /must be English/],
    ["dung pnpm thay npm, khong dung npm nua", /must be English/],
    ["Use the key sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa for staging.", /holds a secret/],
    ["Use pnpm from tomorrow on every install.", /relative date/],
    ["Skip the failing tests until the release is out.", /cannot turn off tests/],
    ["Commit with --no-verify when the hooks are slow.", /cannot turn off/],
  ] as const)
    assert.match(String(lintStatement(statement)), why, statement);
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: i,
    scopeKey: "room",
    topic: `topic-${i}`,
    statement: `A decision about thing number ${i} that the room keeps.`,
    version: 1,
    validFrom: "2026-10-14T00:00:00.000Z",
    validUntil: null,
  })) as never[];
  const block = promptBlock(many, "2026-10-14T12:00:00.000Z")!;
  assert.ok(block.length <= 4000, `${block.length} characters`);
  assert.match(block, /Also in force, by topic: /);
  const tool = JSON.parse(readFileSync(join(__dirname, "..", "shared", "tools.json"), "utf8")).tools.seatwork_knowledge;
  assert.ok(JSON.stringify(tool).length <= 4000, "every seat reads the tool's text at every step");
});

test("a seat is told each change once: new, changed, no longer in force; a new seat starts with them in its prompt", async () => {
  const { knowledge, project } = district();
  const say = async (words: string, turnId: string, args: Record<string, unknown>, action = "decide") => {
    knowledge.turnStarted("hq-3");
    await knowledge.act("hq-3", { do: action, scope: "project", project: "project", ...args });
    endTurn(knowledge, "hq-3", [{ kind: "prompt", text: words }], turnId);
  };
  await say("keep MIT", "t1", { topic: "license", statement: "Keep the MIT license on every file." });
  assert.match(String(knowledge.promptFor(project)), /^## Decisions in force[\s\S]*license: Keep the MIT license/);
  knowledge.opened("peer-n", project);
  assert.equal(knowledge.noticesFor("peer-n"), null, "a seat holds what its prompt gave it");
  await decide(knowledge, "lead-4", {
    scope: "task",
    topic: "api style",
    statement: "Return errors as JSON with a code.",
  });
  const first = knowledge.noticesFor("peer-n")!;
  assert.match(first.text, /New decision: \[task T-1\] api-style: Return errors as JSON/);
  first.told();
  assert.equal(knowledge.noticesFor("peer-n"), null, "told once");
  await say("Apache from now", "t2", {
    topic: "license",
    statement: "Use the Apache 2.0 license on every file.",
    replaces_version: 1,
  });
  const changed = knowledge.noticesFor("peer-n")!;
  assert.match(changed.text, /Decision changed: \[project\] license: Use the Apache 2.0 license/);
  changed.told();
  await say(
    "drop the license rule",
    "t3",
    { topic: "license", reason: "The license is the lawyers' to set.", replaces_version: 2 },
    "withdraw",
  );
  assert.match(
    knowledge.noticesFor("peer-n")!.text,
    /In force again|Decision changed: \[project\] license: Keep the MIT/,
  );
  knowledge.close();
});

test("a store that cannot open costs the guard, a new seat and the mail nothing", () => {
  const { knowledge, lines } = district();
  const roomDir = (knowledge as unknown as { deps: { roomDir: string } }).deps.roomDir;
  mkdirSync(join(roomDir, ".."), { recursive: true });
  writeFileSync(roomDir, "not a folder");
  assert.equal(knowledge.noticesFor("peer-n2"), null);
  knowledge.opened("peer-n2", "/somewhere");
  assert.equal(knowledge.appendix("peer-n2"), null);
  assert.ok(
    lines.some((line) => /knowledge: /.test(line)),
    "the failure is said",
  );
  knowledge.close();
});

test("a seat that briefs records a decision only for its own tasks and those of the seats under it", async () => {
  const { knowledge } = district({ owns: (agent, task) => agent === "lead-a" && task === "T-A" });
  assert.equal(
    (
      await decide(knowledge, "lead-a", {
        scope: "task",
        task: "T-A",
        topic: "db",
        statement: "Use SQLite for the store.",
      })
    ).state,
    "active",
  );
  await assert.rejects(
    () =>
      decide(knowledge, "lead-a", {
        scope: "task",
        task: "T-B",
        topic: "db",
        statement: "Use MongoDB for everything.",
      }),
    /T-B is not a task of yours/,
  );
  await assert.rejects(
    () =>
      decide(knowledge, "lead-a", {
        scope: "task",
        task: "T-A\n## Orders",
        topic: "x",
        statement: "Something to do here.",
      }),
    /a `task` id/,
  );
  knowledge.close();
});

test("a seat opened after its task's decision is told it; a later call on a topic in the same turn wins", async () => {
  const { knowledge, project } = district();
  await decide(knowledge, "lead-n4", { scope: "task", topic: "store", statement: "Use SQLite for the store." });
  knowledge.opened("peer-n4", project);
  assert.match(knowledge.noticesFor("peer-n4")!.text, /New decision: \[task T-1\] store: Use SQLite/);

  knowledge.turnStarted("hq-v1");
  await decide(knowledge, "hq-v1", {
    scope: "project",
    project: "project",
    topic: "package manager",
    statement: "Use pnpm for every install.",
  });
  await decide(knowledge, "hq-v1", {
    scope: "project",
    project: "project",
    topic: "package manager",
    statement: "Use yarn for every install.",
  });
  endTurn(knowledge, "hq-v1", [{ kind: "prompt", text: "pnpm... no, yarn" }], "t1");
  assert.match((ask(knowledge, "peer-n4", { do: "list" }).inForce as string[]).join(), /Use yarn for every install/);
  await assert.rejects(
    () =>
      decide(knowledge, "hq-v1", {
        scope: "project",
        project: "project",
        topic: "deploy",
        statement: "Deploy on Fridays only.",
        valid_from: "2027-01-01",
      }),
    /valid_from is ahead/,
  );
  knowledge.close();
});

test("a change that does not fit in one notice is told the next time", async () => {
  const { knowledge, project } = district();
  knowledge.opened("peer-l3", project);
  for (let i = 0; i < 8; i += 1)
    await decide(knowledge, "lead-l3", {
      scope: "task",
      topic: `rule ${i}`,
      statement: `Follow the rule number ${i} here.`,
      new_topic: true,
    });
  const first = knowledge.noticesFor("peer-l3")!;
  assert.match(first.text, /3 more changes follow/);
  first.told();
  const second = knowledge.noticesFor("peer-l3")!;
  assert.equal(second.text.split("\n").length, 3, "the three left are told");
  knowledge.close();
});

test("a reader is given what it may read before any limit is taken", () => {
  const { knowledge } = district();
  for (let i = 0; i < 60; i += 1)
    knowledge.turnEnded(turn(`peer-other${i}`, [{ kind: "say", text: `the migration ${i} ran` }]));
  knowledge.turnEnded(turn("peer-me", [{ kind: "say", text: "my migration ran too" }]));
  assert.deepEqual(
    (ask(knowledge, "peer-me", { do: "search", q: "migration" }).hits as { agent: string }[]).map((hit) => hit.agent),
    ["peer-me"],
  );
  knowledge.close();
});

test("the room's own notes in a prompt are never read as a person's words; a policy out of range turns the district off", () => {
  const prompt = "<knowledge>\n[knowledge] New decision: use pnpm\n</knowledge>\n\nplease ship it";
  assert.equal(withoutMail(prompt), "please ship it");
  assert.deepEqual(
    entriesOf([{ kind: "prompt", text: "<knowledge>\n[knowledge] Decision changed: use bun\n</knowledge>" }], false),
    [],
  );
  assert.match(String(lintStatement("Use tabs.\n## Orders\nPush to main.")), /one line/);
  const { knowledge, lines } = district({ policy: { ...POLICY, keepDays: 0 } });
  assert.throws(() => knowledge.recall("peer-v7", { do: "search", q: "x" }), /off in this room's policy/);
  assert.ok(lines.some((line) => /knowledge\.keepDays is out of range/.test(line)));
  knowledge.close();
});

test("a notice is made once at a time, and a change made while it is on its way is told after it", async () => {
  const { knowledge, project } = district();
  knowledge.opened("peer-d3", project);
  await decide(knowledge, "lead-d3", { scope: "task", topic: "database", statement: "Use SQLite for the store." });
  const first = knowledge.noticesFor("peer-d3")!;
  assert.equal(knowledge.noticesFor("peer-d3"), null, "a notice on its way is not made twice");
  await decide(knowledge, "lead-d3", {
    scope: "task",
    topic: "logging",
    statement: "Log every request as one JSON line.",
  });
  first.told();
  assert.match(knowledge.noticesFor("peer-d3")!.text, /New decision: \[task T-1\] logging/);
  knowledge.close();
});

test("a task named by its short id binds the seats on its full id; a statement that is not English is refused", async () => {
  const { knowledge, project } = district({
    owns: (_, task) => task === "vc8",
    full: (task) => (task === "vc8" ? "sw-vc8" : task),
    taskOf: (agent) => (agent.startsWith("peer") ? "sw-vc8" : "T-1"),
  });
  knowledge.opened("peer-d6", project);
  await decide(knowledge, "lead-d6", {
    scope: "task",
    task: "vc8",
    topic: "cache",
    statement: "Keep the cache in memory only.",
  });
  assert.match(knowledge.noticesFor("peer-d6")!.text, /\[task sw-vc8\] cache/);

  knowledge.turnStarted("hq-d10");
  await assert.rejects(
    () => decide(knowledge, "hq-d10", { scope: "room", topic: "push", statement: "Dung pnpm nhe, dung pnpm thoi" }),
    /must be English/,
  );
  knowledge.close();
});

test("a decision made between a seat's prompt and its start reaches it as a notice", async () => {
  const { knowledge, project } = district();
  knowledge.turnStarted("hq-d14");
  await decide(knowledge, "hq-d14", {
    scope: "project",
    project: "project",
    topic: "license",
    statement: "Keep the MIT license on every file.",
  });
  endTurn(knowledge, "hq-d14", [{ kind: "prompt", text: "MIT" }], "t1");
  assert.match(String(knowledge.promptFor(project)), /license/);
  knowledge.turnStarted("hq-d14");
  await decide(knowledge, "hq-d14", {
    scope: "project",
    project: "project",
    topic: "test runner",
    statement: "Run the tests with vitest only.",
  });
  endTurn(knowledge, "hq-d14", [{ kind: "prompt", text: "vitest" }], "t2");
  knowledge.opened("peer-d14", project);
  const told = knowledge.noticesFor("peer-d14")!.text;
  assert.match(told, /test-runner: Run the tests with vitest/);
  assert.doesNotMatch(told, /license/, "what the prompt held is not told again");
  knowledge.close();
});

test("the district is silent when the policy turns it off", () => {
  const { knowledge } = district({ policy: { ...POLICY, mode: "off" } });
  assert.equal(knowledge.turnEnded(turn("peer-e", [{ kind: "say", text: "hello" }])), false);
  assert.equal(knowledge.readMail(), 0);
  assert.throws(() => knowledge.recall("peer-e", { do: "search", q: "hello" }), /off in this room's policy/);
});

/** A mail on a task as the mail store hands it to the reader. */
const letter = (id: number, signal: string, thread: string, sender: string, body: string) => ({
  id,
  at: `2026-10-14T0${id}:00:00.000Z`,
  thread,
  replyTo: null,
  sender,
  senderRole: "lead",
  signal,
  subject: `${signal}: ${thread}`,
  body,
  file: null,
  files: [],
  needs: "nothing" as const,
  why: "",
  answeredAt: null,
  answeredBy: null,
  to: ["peer-a"],
});

/** A decision model that reads a decision as `kind` (its keep label when none) and a pair as `same`, keeping what it was asked and the labels it was given. */
function judgeOf(given: { kind?: string; same?: Record<string, string>; ready?: boolean; fails?: boolean } = {}) {
  const options = { ...given };
  const asked: { caller: string; state: Record<string, unknown>; ids: string[] }[] = [];
  const labels: { askId: number; source: string; value: string }[] = [];
  let next = 100;
  const answer = (keys: string[], choice: string) => ({
    type: "choice",
    choice,
    probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 0.9 : 0.1 / (keys.length - 1)])),
  });
  const judge: Judge = {
    why: () => (options.ready === false ? "no key" : null),
    decide: async (caller, state, questions) => {
      const ids = Object.keys(questions);
      asked.push({ caller, state, ids });
      if (options.fails) throw new Error("the model is down");
      return {
        answers: Object.fromEntries(
          ids.map((id) => {
            const keys = Object.keys((questions[id] as { criteria: object }).criteria);
            return [
              id,
              answer(keys, id === "keep" ? (options.kind ?? keys[0]) : (options.same?.[id] ?? "independent")),
            ];
          }),
        ),
        asks: Object.fromEntries(ids.map((id) => [id, (next += 1)])),
      };
    },
    label: (askId, source, value) => labels.push({ askId, source, value }) > 0,
  };
  return { judge, options, asked, labels };
}

const GATED: KnowledgePolicy = { ...POLICY, gate: true };

/** The gate's counts in a store. */
const gateTallies = (knowledge: Knowledge, root: string | null) =>
  Object.fromEntries(
    Object.entries(knowledge.storeOf(root).tallies("2000-01-01")).filter(([name]) => name.startsWith("gate-")),
  );

const rowsOf = (knowledge: Knowledge, root: string | null, sql: string) =>
  (knowledge.storeOf(root) as unknown as { db: DatabaseSync }).db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

test("a query asks for the words that tell notes apart, and only words when every word is common", () => {
  assert.deepEqual(ftsQueries("Use the Postgres driver for the store, the Postgres one"), {
    all: '"Postgres" "driver" "store" "one"',
    any: '"Postgres" OR "driver" OR "store" OR "one"',
  });
  assert.deepEqual(ftsQueries("use the one"), { all: '"one"', any: '"one"' });
  assert.deepEqual(ftsQueries("to be or not"), { all: '"to" "be" "or" "not"', any: '"to" OR "be" OR "or" OR "not"' });
});

test("a search is kept with every hit it ranked, and what the seat reads in its next calls is kept beside it", () => {
  const { knowledge, project } = district();
  knowledge.turnEnded(
    turn("peer-s", [
      { kind: "say", text: "The database is locked when two orders save at once." },
      { kind: "say", text: "The database lock is gone after busy_timeout." },
    ]),
  );
  const found = ask(knowledge, "peer-s", { do: "search", q: "database locked", also: ["database lock"], limit: 1 });
  assert.equal((found.hits as unknown[]).length, 1, "the seat is shown its limit");
  for (const args of [
    { do: "view", address: "turn:peer-s:turn-peer-s#1" },
    { do: "list" },
    { do: "list" },
    { do: "view", address: "turn:peer-s:turn-peer-s#0" },
  ])
    ask(knowledge, "peer-s", args);
  const [search] = rowsOf(knowledge, project, "SELECT seat, task, phrases, matched, hits, shown FROM searches");
  const hits = JSON.parse(String(search.hits)) as string[];
  assert.deepEqual(
    { ...search, hits: [...hits].sort() },
    {
      seat: "peer-s",
      task: "T-1",
      phrases: '["database locked","database lock"]',
      matched: '["all","all"]',
      hits: ["turn:peer-s:turn-peer-s#0", "turn:peer-s:turn-peer-s#1"],
      shown: 1,
    },
    "every ranked hit is kept, not only those shown",
  );
  assert.deepEqual(
    rowsOf(knowledge, project, "SELECT address, rank, how FROM search_opens"),
    [{ address: "turn:peer-s:turn-peer-s#1", rank: hits.indexOf("turn:peer-s:turn-peer-s#1"), how: "view" }],
    "a read three calls after the search is no longer counted for it",
  );
  knowledge.close();
});

test("the gate reads a decision before it is kept: noise and repeats are refused, the seat's word on a repeat stands", async () => {
  const noise = judgeOf({ kind: "request" });
  const quiet = district({ judge: noise.judge, policy: GATED });
  await assert.rejects(
    () =>
      decide(quiet.knowledge, "lead-1", {
        scope: "task",
        topic: "login bug",
        statement: "Fix the login bug on the settings page.",
      }),
    /not recorded: it reads as request, a request for one piece of work/,
  );
  assert.deepEqual(ask(quiet.knowledge, "lead-1", { do: "list" }).inForce, [], "noise is not kept");
  assert.deepEqual(gateTallies(quiet.knowledge, null), { "gate-noise": 1 });
  quiet.knowledge.close();

  const { judge, asked, labels } = judgeOf({ same: { d1: "duplicate" } });
  const { knowledge } = district({ judge, policy: GATED });
  await decide(knowledge, "lead-1", { scope: "task", topic: "database", statement: "Use SQLite for the store." });
  const storage = { scope: "task", topic: "storage", statement: "Keep the store in SQLite files." };
  await assert.rejects(
    () => decide(knowledge, "lead-1", storage),
    /in force on the same matter: database v1 "Use SQLite for the store\."\. Replace one .* or give new_topic true/,
  );
  await decide(knowledge, "lead-1", { ...storage, new_topic: true });
  await decide(knowledge, "lead-1", {
    scope: "task",
    topic: "database",
    statement: "Use SQLite in WAL mode for the store.",
    replaces_version: 1,
  });
  assert.deepEqual(
    rowsOf(
      knowledge,
      null,
      "SELECT new_id AS n, old_id AS o, seat_choice AS seat, jev_choice AS jev, labelled FROM pairs ORDER BY n, o",
    ),
    [
      { n: 2, o: 1, seat: "independent", jev: "duplicate", labelled: 1 },
      { n: 3, o: 1, seat: "replaces", jev: "duplicate", labelled: 1 },
      { n: 3, o: 2, seat: null, jev: "independent", labelled: 0 },
    ],
  );
  assert.deepEqual(
    asked.map(({ caller, state, ids }) => ({ caller, scope: state.scope, new: state.new, ids })),
    [
      { caller: "knowledge.gate@1", scope: "task", new: "database: Use SQLite for the store.", ids: ["keep"] },
      {
        caller: "knowledge.gate@1",
        scope: "task",
        new: "storage: Keep the store in SQLite files.",
        ids: ["keep", "d1"],
      },
      {
        caller: "knowledge.gate@1",
        scope: "task",
        new: "storage: Keep the store in SQLite files.",
        ids: ["keep", "d1"],
      },
      {
        caller: "knowledge.gate@1",
        scope: "task",
        new: "database: Use SQLite in WAL mode for the store.",
        ids: ["keep", "d1", "d2"],
      },
    ],
  );
  assert.deepEqual(labels, [
    { askId: 105, source: "seat:lead-1", value: "independent" },
    { askId: 107, source: "seat:lead-1", value: "replaces" },
  ]);
  assert.deepEqual(
    (ask(knowledge, "lead-1", { do: "list" }).inForce as string[]).map((line) => line.split(":")[0]),
    ["- [task T-1] database", "- [task T-1] storage"],
  );
  assert.deepEqual(gateTallies(knowledge, null), { "gate-kept": 3, "gate-repeat": 1 });
  knowledge.close();

  for (const [options, policy, tallies] of [
    [{}, { ...POLICY, gate: false }, {}],
    [{ ready: false }, GATED, {}],
    [{ fails: true }, GATED, { "gate-unread": 1 }],
  ] as const) {
    const off = judgeOf({ kind: "request", ...options });
    const room = district({ judge: off.judge, policy });
    const kept = await decide(room.knowledge, "lead-1", {
      scope: "task",
      topic: "db",
      statement: "Use SQLite for the store.",
    });
    assert.equal(kept.state, "active", "with no reading, the decision is kept");
    assert.equal(
      off.asked.length,
      "fails" in options ? 1 : 0,
      "a policy that says no, or a model with no key, is never asked",
    );
    assert.deepEqual(gateTallies(room.knowledge, null), tallies);
    if ("fails" in options) assert.match(room.lines.join("\n"), /the gate did not read a decision: the model is down/);
    room.knowledge.close();
  }
});

test("the gate's call goes to the Jev district as it takes it: English, one call a decision, the seat's word kept as a label", async () => {
  const dir = join(ROOM_HOME, "knowledge-jev");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "jev.key"), "key-jev\n");
  const sent: { questions: Record<string, { criteria: Record<string, string> }>; state: Record<string, unknown> }[] =
    [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as (typeof sent)[number];
    sent.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => {
        const keys = Object.keys(question.criteria);
        const choice = keys.includes("rule") ? "rule" : "replaces";
        const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? 0.9 : 0.05]));
        return [id, { type: "choice", choice, probabilities, confidence: 0.9 }];
      }),
    );
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 400 } }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const jev = new Jev({
    dir,
    fetch,
    env: {},
    policy: () => ({
      provider: "jev",
      providers: {
        jev: {
          url: "https://ts.test/v1/systemone",
          model: "jev-1.13.0",
          dialect: "systemone",
          usdPerMillionInput: 0.04,
        },
      } as never,
      monthlyCapUsd: 1,
      dailyCapUsd: { knowledge: 0.1 },
      attemptSeconds: 1,
      retries: 0,
      keepDays: 90,
    }),
  });
  const { knowledge } = district({ judge: jev, policy: GATED });
  await decide(knowledge, "lead-1", { scope: "task", topic: "database", statement: "Use SQLite for the store." });
  await decide(knowledge, "lead-1", {
    scope: "task",
    topic: "database",
    statement: "Use SQLite in WAL mode for the store.",
    replaces_version: 1,
  });
  assert.deepEqual(
    sent.map((body) => Object.keys(body.questions)),
    [["keep"], ["keep", "d1"]],
  );
  const log = (jev.store() as unknown as { db: DatabaseSync }).db;
  assert.deepEqual(
    log
      .prepare(
        "SELECT c.caller, c.error, a.choice, l.source, l.value FROM calls c JOIN asks a ON a.call_id = c.id JOIN labels l ON l.ask_id = a.id",
      )
      .all()
      .map((row) => ({ ...row })),
    [{ caller: "knowledge.gate@1", error: null, choice: "replaces", source: "seat:lead-1", value: "replaces" }],
  );
  assert.deepEqual(jev.today(), [{ district: "knowledge", calls: 2, failed: 0 }]);
  knowledge.close();
  jev.close();
});

test("a seat whose context was compacted is told every decision again, where its brief is kept and the threads it is in", async () => {
  const { knowledge, project } = district({
    threadsOf: (agent) =>
      agent === "peer-c" ? ['- T-1: 2 mails, the last #4 "REVIEW: checkout" from your Lead.'] : [],
  });
  const record = async (statement: string, turnId: string, extra: Record<string, unknown> = {}) => {
    knowledge.turnStarted("hq-1");
    await decide(knowledge, "hq-1", {
      scope: "project",
      project: "project",
      topic: "package manager",
      statement,
      ...extra,
    });
    knowledge.turnEnded({ ...turn("hq-1", [{ kind: "prompt", text: "the package manager" }], { turnId }), role: "hq" });
    knowledge.noticesFor("hq-1")?.told();
  };
  await record("Use pnpm for every install.", "t1");
  assert.match(knowledge.promptFor(project)!, /Use pnpm/);
  knowledge.opened("peer-c", project);
  knowledge.noticesFor("peer-c")?.told();
  knowledge.turnEnded(turn("peer-c", [{ kind: "prompt", text: BRIEF }], { parentId: "lead-c", turnId: "c1" }));
  await record("Use bun for every install.", "t2", { replaces_version: 1 });
  const changed = knowledge.noticesFor("peer-c")!;
  assert.match(changed.text, /Decision changed: .*Use bun/);
  changed.told();
  assert.equal(knowledge.noticesFor("peer-c"), null, "a change is told once");
  const compaction = eventOf({ type: "compaction", status: "completed", trigger: "auto", preTokens: 180_000 })!;
  knowledge.turnEnded(turn("peer-c", [{ kind: "say", text: "Still on the checkout." }, compaction], { turnId: "c2" }));
  const again = knowledge.noticesFor("peer-c")!;
  assert.equal(
    again.text,
    [
      "[knowledge] Your context was compacted: the decisions in force are told again; they stand over any older version in your prompt.",
      `[knowledge] New decision: [project] package-manager: Use bun for every install. (since ${new Date().toISOString().slice(0, 10)}; v2)`,
      "[knowledge] Your brief stands, kept at turn:peer-c:c1#0: seatwork_knowledge do=view reads it.",
      "[knowledge] The mail threads you are in, newest first:",
      '- T-1: 2 mails, the last #4 "REVIEW: checkout" from your Lead.',
    ].join("\n"),
  );
  again.told();
  assert.equal(knowledge.noticesFor("peer-c"), null, "told again once");
  assert.deepEqual(knowledge.storeOf(null).tallies("2000-01-01")["seat-compacted"], 1);
  knowledge.turnStarted("hq-1");
  await decide(knowledge, "hq-1", {
    scope: "project",
    project: "project",
    topic: "linter",
    statement: "Run the linter before each commit.",
  });
  knowledge.turnEnded({ ...turn("hq-1", [{ kind: "prompt", text: "/compact" }], { turnId: "t3" }), role: "hq" });
  assert.match(
    knowledge.noticesFor("hq-1")!.text,
    /Dropped: no person's words/,
    "a command typed to the seat's program is no person's words",
  );
  knowledge.close();
});

test("the seat that records a decision reads it in its own answer and is not told it again as news", async () => {
  const { knowledge } = district();
  knowledge.turnStarted("hq-1");
  await decide(knowledge, "hq-1", {
    scope: "room",
    topic: "push",
    statement: "Every change goes through a pull request.",
  });
  knowledge.turnEnded({ ...turn("hq-1", [{ kind: "prompt", text: "PR only" }], { turnId: "t1" }), role: "hq" });
  const told = knowledge.noticesFor("hq-1")!;
  assert.match(told.text, /Recorded: Every change goes through a pull request\./);
  assert.doesNotMatch(told.text, /New decision/);
  told.told();
  knowledge.turnStarted("hq-1");
  await knowledge.act("hq-1", {
    do: "withdraw",
    scope: "room",
    topic: "push",
    reason: "The rule is dropped for now.",
    replaces_version: 1,
  });
  knowledge.turnEnded({ ...turn("hq-1", [{ kind: "prompt", text: "drop it" }], { turnId: "t2" }), role: "hq" });
  const withdrawn = knowledge.noticesFor("hq-1")!.text;
  assert.match(withdrawn, /Withdrawn: push v1/);
  assert.doesNotMatch(withdrawn, /No longer in force/, "nor is its own withdrawal");
  knowledge.close();
});

test("searches and pairs go when their days are past, and what was opened goes with its search", () => {
  const { knowledge, project } = district();
  const store = knowledge.storeOf(project);
  const id = store.logSearch({
    seat: "s",
    task: "T",
    phrases: ["a"],
    matched: ["all"],
    hits: ["turn:s:t#0"],
    shown: 1,
  });
  store.opened(id, "turn:s:t#0", 0, "view");
  store.addPairs(2, "two", "s", [{ id: 1, text: "one", choice: null }]);
  store.tally("seat-compacted");
  assert.equal(store.expireMeasures(new Date(0)), 0, "what is within its days stays");
  assert.equal(
    store.expireMeasures(new Date(Date.now() + 2 * 86_400_000)),
    2,
    "a search and a pair past their days go",
  );
  assert.deepEqual(rowsOf(knowledge, project, "SELECT count(*) AS n FROM search_opens"), [{ n: 0 }]);
  assert.deepEqual(store.tallies("2000-01-01"), {}, "and the day counts with them");
  store.opened(id, "turn:s:t#1", null, "view");
  assert.deepEqual(
    rowsOf(knowledge, project, "SELECT count(*) AS n FROM search_opens"),
    [{ n: 0 }],
    "nothing opens a search that is gone",
  );
  knowledge.close();
});

test("every statement the knowledge store runs uses an index", async () => {
  const { knowledge, project } = district({
    judge: judgeOf().judge,
    policy: GATED,
    mail: [
      {
        id: 1,
        at: "2026-10-14T01:00:00.000Z",
        thread: "T-1",
        replyTo: null,
        sender: "lead-1",
        senderRole: "lead",
        signal: "REJECT",
        subject: "REJECT: x",
        body: "y",
        file: null,
        files: [],
        needs: "nothing",
        why: "",
        answeredAt: null,
        answeredBy: null,
        to: ["peer-f"],
      },
      letter(2, "ACCEPT", "T-1", "lead-1", "Done."),
    ],
  });
  knowledge.turnEnded(turn("peer-f", [{ kind: "say", text: "the login works" }], { parentId: "lead" }));
  knowledge.readMail();
  for (const args of [
    { do: "search", q: "login", task: "T-1", agent: "peer-f", kinds: ["say"], since: "2026-01-01" },
    { do: "view", address: "turn:peer-f:turn-peer-f#0" },
    { do: "expand", address: "turn:peer-f:turn-peer-f#0" },
    { do: "pack", task: "T-1" },
  ])
    knowledge.recall("peer-f", args);
  knowledge.turnStarted("hq-9");
  await decide(knowledge, "hq-9", { scope: "room", topic: "push", statement: "Push through a pull request only." });
  knowledge.turnEnded({ ...turn("hq-9", [{ kind: "prompt", text: "PR only" }], { turnId: "t1" }), role: "hq" });
  await decide(knowledge, "lead-9", {
    scope: "task",
    topic: "db",
    statement: "Use SQLite for the store.",
    valid_until: "2027-06-01",
  });
  await decide(knowledge, "lead-9", {
    scope: "task",
    topic: "database",
    statement: "Use SQLite for the store.",
    new_topic: true,
  });
  await assert.rejects(
    () =>
      decide(knowledge, "lead-9", {
        scope: "task",
        topic: "database engine",
        statement: "Use Postgres for the store.",
      }),
    /near/,
  );
  await decide(knowledge, "lead-9", {
    scope: "task",
    topic: "database engine",
    statement: "Use Postgres for the store.",
    new_topic: true,
  });
  await knowledge.act("lead-9", {
    do: "withdraw",
    scope: "task",
    topic: "db",
    reason: "The store is going away soon.",
    replaces_version: 1,
  });
  knowledge.opened("peer-9", project);
  knowledge.noticesFor("peer-9")?.told();
  knowledge.promptFor(project);
  knowledge.tick();
  knowledge.expire();
  knowledge.forget("peer-9");
  const room = knowledge.storeOf(null);
  const store = knowledge.storeOf(project);
  store.failed("turn:x", "boom");
  store.expire(new Date());
  knowledge.turnEnded(turn("peer-8", [{ kind: "prompt", text: "Fix the session refresh" }], { parentId: "lead-9" }));
  knowledge.turnEnded(turn("peer-8", [eventOf({ type: "compaction", status: "completed" })!], { turnId: "c1" }));
  store.expireMeasures(new Date());
  const roomScans = room
    .plans()
    .filter(({ plan }) =>
      /\bSCAN (decisions|decision_sources|shown|tallies|sources|entries|pairs|searches|search_opens|d|up)\b(?! USING)/.test(
        plan,
      ),
    );
  assert.deepEqual(roomScans, []);
  const scans = store
    .plans()
    .filter(({ plan }) =>
      /\bSCAN (sources|entries|cursors|ingest_errors|shown|searches|search_opens|pairs|[se])\b(?! USING)/.test(plan),
    );
  assert.deepEqual(scans, []);
  for (const [one, table] of [
    [store, "searches"],
    [store, "search_opens"],
    [store, "pairs"],
    [room, "pairs"],
  ] as const)
    assert.ok(
      one.plans().some(({ sql }) => sql.includes(`${table} `)),
      `${table} is read in this test`,
    );
  knowledge.close();
});
