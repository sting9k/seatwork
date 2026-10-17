import { hostOf, MAIL_POLICY, PROJECT, ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles, Collector, dropSeatTmp, KEEP_LOG_DAYS, sweepRuntimes, type DistrictRecords } from "../server/gc";
import { MailEngine } from "../server/coordination/engine";
import { roomStats } from "../server/stats";

shipSql();

/** One GC pass over the seats `paseo` lists. */
const pass = (
  paseo: object,
  engine: MailEngine,
  policy: object,
  log: (line: string) => void = () => {},
  districts: readonly DistrictRecords[] = [],
) => new Collector(hostOf(paseo), engine, policy as never, log, () => {}, undefined, undefined, districts).run();

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
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {});
  for (const agentId of Object.keys(seats))
    engine.rememberSeat({ agentId, parentAgentId: null, role: "peer", provider: "claude-peer", title: null });
  const policy = {
    everyMinutes: 10,
    idleHoursBeforeArchive: { peer: 48 },
    deleteOrphanHeartbeats: false,
    tellParent: false,
  };

  await pass(paseo, engine, policy);

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

test("GC's file sweep clears what the room left longer ago than it keeps it", () => {
  const paseoHome = join(ROOM_HOME, "..", "paseo-of-tidy");
  mkdirSync(paseoHome);
  // the room's backups of config.json, and one file that is not the room's
  for (const name of [
    "config.json.bak-20260901-120000",
    "config.json.bak-20261001-120000",
    "config.json.bak-20261019-120000",
    "config.json.bak-mine",
    "config.json",
  ])
    writeFileSync(join(paseoHome, name), "{}");

  // local skills taken out: kept as long as a folder set aside by Remove
  const removed = join(ROOM_HOME, "skills-local", "removed");
  for (const at of ["20260901-120000", "20261015-120000"])
    mkdirSync(join(removed, at, "peer", "flaky"), { recursive: true });
  // controls of a writer's tests: kept as long as logs
  const controls = join(ROOM_HOME, "controls");
  for (const at of ["20261016-120000", "20261019-120000"])
    mkdirSync(join(controls, at, "peer-abc"), { recursive: true });

  const done = collectFiles(ROOM_HOME, [{ dir: paseoHome, prefixes: ["config.json.bak-"], spare: 1 }], NOW);

  assert.deepEqual(readdirSync(paseoHome).sort(), [
    "config.json",
    "config.json.bak-20261019-120000",
    "config.json.bak-mine",
  ]);
  assert.deepEqual(readdirSync(removed), ["20261015-120000"]);
  assert.deepEqual(readdirSync(controls), ["20261019-120000"]);
  assert.equal(done.length, 4);
  assert.deepEqual(
    collectFiles(ROOM_HOME, [{ dir: paseoHome, prefixes: ["config.json.bak-"], spare: 1 }], NOW),
    [],
    "a second sweep found something to clear",
  );

  // the newest backup stays, however old
  assert.deepEqual(
    collectFiles(
      ROOM_HOME,
      [{ dir: paseoHome, prefixes: ["config.json.bak-"], spare: 1 }],
      new Date(2027, 0, 1),
    ).filter((line) => line.includes("backup")),
    [],
  );
});

test("room stats look no further back than the mail log is kept", () => {
  const posted = (days: number, subject: string) => ({
    at: new Date(Date.now() - days * 86_400_000).toISOString(),
    from: "lead",
    to: "peer",
    subject,
  });
  const lines = [
    posted(KEEP_LOG_DAYS + 3, "ACCEPT abc"),
    posted(KEEP_LOG_DAYS - 1, "CANDIDATE abc"),
    posted(1, "ACCEPT abc"),
  ];
  const stats = roomStats(KEEP_LOG_DAYS * 2, (since) => lines.filter((line) => line.at >= since));
  assert.match(stats, new RegExp(`^mail in the last ${KEEP_LOG_DAYS} days: 2\n`));
});

test("room stats count the seats whose work came back three times or more", () => {
  const posted = (to: string, subject: string) => ({
    at: new Date().toISOString(),
    from: "lead",
    to,
    subject,
  });
  const lines = [...["p1", "p1", "p1", "p2"].map((to) => posted(to, "REJECT abc: repair")), posted("p1", "ACCEPT abc")];
  assert.match(
    roomStats(1, () => lines),
    /seats sent back 3 times or more: 1/,
  );
});

test("GC deletes a closed seat's temporary directory once its keep has passed, and leaves an open seat's", () => {
  const tmp = join(ROOM_HOME, "tmp");
  const old = new Date(Date.now() - (KEEP_LOG_DAYS * 86_400_000 + 60_000));
  const within = new Date(Date.now() - (KEEP_LOG_DAYS * 86_400_000 - 60_000));
  for (const name of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) {
    mkdirSync(join(tmp, name), { recursive: true });
    writeFileSync(join(tmp, name, "scratch.txt"), "x");
  }
  utimesSync(join(tmp, "aaaaaaaa"), old, old);
  utimesSync(join(tmp, "bbbbbbbb"), old, old);
  utimesSync(join(tmp, "cccccccc"), within, within);
  // aaaaaaaa is closed and past its keep, bbbbbbbb is past it and still open, cccccccc closed a minute short of it
  assert.deepEqual(dropSeatTmp(tmp, ["bbbbbbbb-1111-2222"]), [join(tmp, "aaaaaaaa")]);
  assert.deepEqual(readdirSync(tmp).sort(), ["bbbbbbbb", "cccccccc"]);
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
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {});
  const policy = { idleHoursBeforeArchive: {}, deleteOrphanHeartbeats: false, tellParent: false, runtimes: table };
  await pass(paseo, engine, policy);
  assert.deepEqual([existsSync(scratch("codex/lens")), existsSync(scratch("codex/peer"))], [false, true]);
});

test("GC deletes a project's handoffs once older than the logs are kept, and leaves newer ones and what keeps them out of git", async () => {
  const project = join(ROOM_HOME, "handoff-project");
  const handoffs = join(project, ".seatwork", "handoffs");
  mkdirSync(handoffs, { recursive: true });
  const old = new Date(Date.now() - (KEEP_LOG_DAYS + 1) * 86_400_000);
  for (const [name, aged] of [
    ["2026-10-01-10-00_aaaaaaaa.md", true],
    ["2026-10-14-10-00_bbbbbbbb.md", false],
    [".gitignore", true],
  ] as const) {
    writeFileSync(join(handoffs, name), name);
    if (aged) utimesSync(join(handoffs, name), old, old);
  }
  const paseo = { agents: { list: async () => ({ entries: [] }) } };
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {}, {
    rootOf: (cwd) => (cwd.startsWith(project) ? project : null),
  });
  engine.rememberSeat({
    agentId: "lead-h",
    parentAgentId: null,
    role: "lead",
    provider: "claude-lead",
    title: null,
    cwd: project,
  });
  const policy = { idleHoursBeforeArchive: {}, deleteOrphanHeartbeats: false, tellParent: false };
  await pass(paseo, engine, policy);
  assert.deepEqual(readdirSync(handoffs).sort(), [".gitignore", "2026-10-14-10-00_bbbbbbbb.md"]);
});

test("one step of a GC pass that fails is logged and the others still run", async () => {
  const project = join(ROOM_HOME, "isolated-project");
  const handoffs = join(project, ".seatwork", "handoffs");
  mkdirSync(handoffs, { recursive: true });
  const old = new Date(Date.now() - (KEEP_LOG_DAYS + 1) * 86_400_000);
  writeFileSync(join(handoffs, "2026-10-01-10-00_aaaaaaaa.md"), "old");
  utimesSync(join(handoffs, "2026-10-01-10-00_aaaaaaaa.md"), old, old);
  const policy = { idleHoursBeforeArchive: {}, deleteOrphanHeartbeats: false, tellParent: false };
  const rooted = { rootOf: (cwd: string) => (cwd.startsWith(project) ? project : null) };
  const seat = {
    agentId: "lead-i",
    parentAgentId: null,
    role: "lead",
    provider: "claude-lead",
    title: null,
    cwd: project,
  };

  for (const list of [
    async () => ({ entries: [] }),
    async () => {
      throw new Error("the daemon does not answer");
    },
  ]) {
    writeFileSync(join(handoffs, "2026-10-01-10-00_aaaaaaaa.md"), "old");
    utimesSync(join(handoffs, "2026-10-01-10-00_aaaaaaaa.md"), old, old);
    const paseo = { agents: { list } };
    const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {}, rooted);
    engine.rememberSeat(seat);
    const log: string[] = [];
    const ran: string[] = [];
    await pass(paseo, engine, policy, (message) => void log.push(message), [
      {
        what: "guard records",
        expire: () => {
          throw new Error("disk full");
        },
      },
      { what: "decision states", expire: () => (ran.push("ran"), 0) },
    ]);

    assert.deepEqual(ran, ["ran"], "a district after the failing one was skipped");
    assert.deepEqual(readdirSync(handoffs), [], "the step after the failing ones did not run");
    assert.ok(
      log.some((line) => /guard records.*failed.*disk full/.test(line)),
      log.join("\n"),
    );
  }
});

test("GC trims the seat records to what the room can still need: recent seats, open seats and the seats above them, the newest seat of each folder", () => {
  const file = join(ROOM_HOME, "registry-log.jsonl");
  const seat = (agentId: string, cwd: string | undefined, days: number, parentAgentId: string | null = null) =>
    JSON.stringify({
      at: daysAgo(days),
      agentId,
      parentAgentId,
      role: "peer",
      provider: "claude-peer",
      title: null,
      cwd,
    });
  writeFileSync(
    file,
    [
      seat("a-old", "/p/a", 20),
      seat("a-newer", "/p/a", 10),
      seat("b-only", "/p/b", 15),
      seat("c-boss", "/p/c", 14),
      seat("c-dead", "/p/c", 13),
      seat("c-open", "/p/c", 12, "c-boss"),
      seat("nowhere", undefined, 11),
      "a torn li",
      seat("d-recent", "/p/d", 1),
      JSON.stringify({ agentId: "undated", cwd: "/p/e" }),
      seat("e-newest", "/p/e", 9),
    ].join("\n") + "\n",
  );
  const ids = () => lines(file).map((line) => (line as unknown as { agentId: string }).agentId);
  try {
    // without a daemon there is no telling which seats are open: the records stay
    const before = readFileSync(file, "utf8");
    collectFiles(ROOM_HOME, [], NOW);
    assert.equal(readFileSync(file, "utf8"), before);

    const done = collectFiles(ROOM_HOME, [], NOW, new Set(["c-open"]));

    assert.deepEqual(ids(), ["a-newer", "b-only", "c-boss", "c-open", "d-recent", "undated", "e-newest"]);
    assert.ok(
      done.some((line) => /^4 seat records .* left registry-log\.jsonl$/.test(line)),
      done.join("\n"),
    );
    assert.deepEqual(collectFiles(ROOM_HOME, [], NOW, new Set(["c-open"])), [], "a second sweep found something");
  } finally {
    rmSync(file, { force: true });
  }
});

test(
  "a seat home GC cannot clear is named, and the homes after it are still cleared",
  { skip: process.getuid?.() === 0 },
  () => {
    const runtimes = join(ROOM_HOME, "runtimes-locked");
    const scratch = (role: string) => join(runtimes, "codex", role, ".tmp");
    for (const role of ["lens", "peer"]) {
      mkdirSync(scratch(role), { recursive: true });
      writeFileSync(join(scratch(role), "scratch"), "x");
    }
    chmodSync(scratch("lens"), 0o500);
    try {
      const done = sweepRuntimes(runtimes, new Set(), { codex: { rebuilt: [".tmp"], sessions: [] } });

      assert.ok(!existsSync(scratch("peer")), "the home after the locked one was not cleared");
      assert.ok(
        done.some((line) => line.startsWith("could not clear") && line.includes("lens")),
        done.join("\n"),
      );
    } finally {
      chmodSync(scratch("lens"), 0o700);
    }
  },
);

test("GC lets the room forget a seat the app has not listed for the keep, but not one the room still needs", async () => {
  const day = 86_400_000;
  let at = Date.now();
  const listed = new Set(["boss-f", "lead-f", "peer-f-live"]);
  const paseo = {
    agents: {
      list: async () => ({
        entries: [...listed].map((id) => ({ agent: { id, status: "idle", updatedAt: new Date(at).toISOString() } })),
      }),
      // an app that does not say what a seat is: its mail waits
      ref: () => ({
        refresh: async () => {
          throw new Error("no answer");
        },
      }),
    },
  };
  const [one, other] = [join(PROJECT, "forget-one"), join(PROJECT, "forget-other")];
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {}, {
    now: () => new Date(at),
    rootOf: (cwd) => cwd,
  });
  const seat = (agentId: string, role: string, parentAgentId: string | null, cwd = one) =>
    engine.rememberSeat({ agentId, parentAgentId, role, provider: `claude-${role}`, title: null, cwd });
  // the newest seat of a folder stays, so the one that goes is registered before the others
  seat("peer-f-gone", "peer", "lead-f");
  seat("peer-f-waiting", "peer", "lead-f");
  seat("lead-f-gone", "lead", "boss-f");
  seat("peer-f-live", "peer", "lead-f-gone");
  seat("lead-f", "lead", "boss-f");
  seat("boss-f", "supervisor", null);
  seat("boss-f-other", "supervisor", null, other);
  await engine.post({
    from: { agentId: "lead-f", role: "lead" },
    to: "peer-f-waiting",
    priority: "action",
    subject: "INSTRUCTION: go on",
    body: "Go on.",
    needs: "nothing",
  });
  const policy = { idleHoursBeforeArchive: {}, deleteOrphanHeartbeats: false, tellParent: false };
  const known = () => engine.allSeats().map((one) => one.agentId);
  const all = known();

  await pass(paseo, engine, policy);
  at += (KEEP_LOG_DAYS - 1) * day;
  await pass(paseo, engine, policy);
  assert.deepEqual(known(), all, "a seat gone for less than the keep stays");

  at += 2 * day;
  await pass(paseo, engine, policy);
  assert.deepEqual(
    known(),
    all.filter((id) => id !== "peer-f-gone"),
    "gone past the keep and needed by none, it leaves; a seat with mail waiting, one with a live seat below it, and the last of a folder, stay",
  );
  assert.equal(engine.projectOf("peer-f-gone"), null, "nothing of it is remembered");
  assert.equal(engine.canWrite("lead-f", "peer-f-gone").ok, false);
});

test("an archived seat whose parent could not be told does not keep the other idle seats from being archived", async () => {
  const longAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
  const archived: string[] = [];
  const seats: Record<string, { status: string; updatedAt: string }> = {
    "lead-t": { status: "running", updatedAt: new Date().toISOString() },
    "peer-t1": { status: "idle", updatedAt: longAgo },
    "peer-t2": { status: "idle", updatedAt: longAgo },
  };
  const paseo = {
    agents: {
      list: async () => ({ entries: Object.entries(seats).map(([id, seat]) => ({ agent: { id, ...seat } })) }),
      ref: (id: string) => ({
        refresh: async () => {},
        current: () => ({ id, ...seats[id] }),
        archive: async () => void archived.push(id),
      }),
    },
  };
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {});
  engine.rememberSeat({ agentId: "lead-t", parentAgentId: null, role: "lead", provider: "claude-lead", title: null });
  for (const agentId of ["peer-t1", "peer-t2"])
    engine.rememberSeat({ agentId, parentAgentId: "lead-t", role: "peer", provider: "claude-peer", title: null });
  engine.post = async () => {
    throw new Error("the mail store is locked");
  };
  const log: string[] = [];
  const policy = { idleHoursBeforeArchive: { peer: 48 }, deleteOrphanHeartbeats: false, tellParent: true };

  await pass(paseo, engine, policy, (line) => void log.push(line));

  assert.deepEqual(archived.sort(), ["peer-t1", "peer-t2"]);
  assert.ok(
    log.some((line) => /lead-t.*mail store is locked/.test(line)),
    log.join("\n"),
  );
});
