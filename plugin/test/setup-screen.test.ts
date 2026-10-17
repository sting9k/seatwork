import { PLUGIN_DIR, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { pluginRoom } from "./support/plugin";
import { PASEO_HOME } from "../server/paths";

const paseoFile = join(PASEO_HOME, "config.json");
const { call, names, restart, stop } = pluginRoom(null, {
  before: () => {
    // this machine keeps the room's mail server off the port the policy names
    writeFileSync(join(ROOM_HOME, "setup.json"), JSON.stringify({ mailPort: 0 }));
    // a folder Remove set aside long ago: the plugin deletes it as it starts, room or no room
    mkdirSync(`${ROOM_HOME}.removed-20260101-000000`);
    // the daemon's own config.json, which holds what the SDK cannot set: the owner dictates, and picked no skills
    mkdirSync(PASEO_HOME, { recursive: true });
    writeFileSync(
      paseoFile,
      JSON.stringify({ plugins: { seatwork: { path: PLUGIN_DIR } }, features: { dictation: { enabled: true } } }),
    );
  },
});

const daemon = {
  config: {
    providers: { "my-own": { extends: "claude" }, claude: { enabled: true } } as Record<string, unknown>,
    agentProfiles: [{ id: "mine" }] as { id: string }[],
    // the owner's own switches, before the room sets its own
    mcp: { enabled: true, injectIntoAgents: false } as Record<string, boolean>,
    browserTools: { enabled: true },
    enableTerminalAgentHooks: true,
    plugins: { seatwork: { path: PLUGIN_DIR } } as Record<string, { path: string }>,
  },
  workspaces: [] as string[],
  open: [] as { id: string; provider: string; title: string }[],
  archived: [] as Record<string, unknown>[],
  patches: [] as object[],
  refuses: "",
};
const VERSION = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version as string;
const paseo = {
  config: {
    get: async () => ({ config: structuredClone(daemon.config) }),
    patch: async (patch: {
      providers?: Record<string, unknown>;
      removeProviders?: string[];
      agentProfiles?: { id: string }[];
      mcp?: Record<string, boolean>;
      browserTools?: { enabled: boolean };
      enableTerminalAgentHooks?: boolean;
    }) => {
      daemon.patches.push(patch);
      if (daemon.refuses) throw new Error(daemon.refuses);
      for (const id of patch.removeProviders ?? []) delete daemon.config.providers[id];
      // as Paseo does, a patched provider is merged into the one it has
      for (const [id, entry] of Object.entries(patch.providers ?? {}))
        daemon.config.providers[id] = { ...(daemon.config.providers[id] as object), ...(entry as object) };
      if (patch.agentProfiles) daemon.config.agentProfiles = patch.agentProfiles;
      if (patch.mcp) Object.assign(daemon.config.mcp, patch.mcp);
      if (patch.browserTools) daemon.config.browserTools = patch.browserTools;
      if (patch.enableTerminalAgentHooks !== undefined)
        daemon.config.enableTerminalAgentHooks = patch.enableTerminalAgentHooks;
    },
  },
  providers: {
    waitForReady: async () => ({
      entries: [
        {
          provider: "claude",
          status: "ready",
          label: "Claude",
          models: [
            {
              id: "claude-opus-5-5",
              label: "Opus 5.5",
              thinkingOptions: [{ id: "medium" }, { id: "high" }],
              defaultThinkingOptionId: "high",
            },
          ],
        },
        { provider: "codex", status: "unavailable", label: "Codex", error: "codex is not installed" },
      ],
    }),
  },
  workspaces: {
    list: async () => ({
      entries: daemon.workspaces.map((projectRootPath) => ({ id: projectRootPath, projectRootPath })),
    }),
    open: async ({ cwd }: { cwd: string }) => void daemon.workspaces.push(cwd),
    archive: async (id: string) => void (daemon.workspaces = daemon.workspaces.filter((dir) => dir !== id)),
  },
  agents: {
    list: async ({ filter }: { filter?: { includeArchived?: boolean } } = {}) => ({
      entries: [...daemon.open, ...(filter?.includeArchived ? daemon.archived : [])].map((agent) => ({ agent })),
    }),
  },
};
const context = { paseo };
const init = (choices: object = {}) =>
  call("rpc setup.init", { models: {}, chime: true, ...choices }, context) as Promise<{
    seats: string[];
    removed: string[];
  }>;
const state = () =>
  call("rpc setup.state", {}, context) as Promise<{
    applied: { models: unknown; version: string; seats: string[] } | null;
    harnesses: { id: string; available: boolean; why: string }[];
    checks: { id: string; ok: boolean | null; detail: string }[];
    table: unknown;
  }>;
const createPeer = () =>
  call(
    "before agent.create",
    { request: { config: { provider: "claude-peer", cwd: PROJECT, title: "[Peer] task" }, env: {} } },
    context,
  ) as Promise<{ config: { systemPrompt: string; mcpServers: object } }>;
const setupFile = join(ROOM_HOME, "setup.json");
const stamp = () => JSON.parse(readFileSync(setupFile, "utf8")).version as string;
/** The plugin as it starts after an update: the room's files are still an earlier version's. */
async function updated(): Promise<void> {
  writeFileSync(setupFile, JSON.stringify({ ...JSON.parse(readFileSync(setupFile, "utf8")), version: "0.1.0" }));
  await restart();
  daemon.patches.length = 0;
}

test("a daemon that only downloaded the plugin: nothing is created, a room seat is refused, the app is told there is no room", async () => {
  assert.equal(existsSync(`${ROOM_HOME}.removed-20260101-000000`), false);
  assert.deepEqual(readdirSync(ROOM_HOME), ["setup.json"]);
  await assert.rejects(createPeer(), /no room is set up on this daemon.*the Seatwork screen/);
  const own = { config: { provider: "claude", cwd: PROJECT }, env: {} };
  assert.deepEqual(await call("before agent.create", { request: own }), own, "an agent that is not a room seat");
  assert.deepEqual(await call("rpc room.waiting", {}, context), { chime: false, waiting: [], seats: [] });
  assert.deepEqual(await call("rpc room.status", {}, context), { waiting: [], projects: [] });

  const screen = await state();
  assert.equal(screen.applied, null);
  assert.deepEqual(
    screen.harnesses.map((h) => [h.id, h.available]),
    [
      ["claude", true],
      ["codex", false],
      ["pi", false],
      ["opencode", false],
    ],
  );
  assert.equal(screen.harnesses[1].why, "codex is not installed");
});

test("the clean-up runs when the screen asks, room or no room, and says what it cleared", async () => {
  const aside = `${ROOM_HOME}.removed-20260102-000000`;
  mkdirSync(aside);
  const { lines, running } = (await call("rpc room.clean", {}, context)) as { lines: string[]; running: boolean };
  assert.equal(existsSync(aside), false);
  assert.equal(running, false);
  assert.deepEqual(lines.filter((line) => line.includes("removed-20260102-000000")).length, 1, lines.join("\n"));
  assert.deepEqual(((await call("rpc room.clean", {}, context)) as { lines: string[] }).lines, []);
});

test("Init sets the room up and starts it without a reload; Apply restarts it on the new choices with its hooks registered once", async () => {
  const first = await init({ chime: false });

  assert.ok(
    first.seats.includes("claude-hq") && "claude-hq" in daemon.config.providers && "my-own" in daemon.config.providers,
  );
  assert.deepEqual(daemon.config.agentProfiles.map((p) => p.id).slice(0, 2), ["mine", "agent_profile_seatwork_hq"]);
  assert.deepEqual(daemon.workspaces, [realpathSync(join(ROOM_HOME, "hq-seatwork"))]);
  const policy = () => JSON.parse(readFileSync(join(ROOM_HOME, "policy.json"), "utf8"));
  assert.deepEqual([policy().owner.chime, policy().mail.port], [false, 0]);
  // the daemon as the room's policy has it: browser tools and terminal hooks on, and the owner's own agents keep
  // the Paseo tools the room's roles use and no other
  assert.deepEqual([daemon.config.browserTools.enabled, daemon.config.enableTerminalAgentHooks], [true, true]);
  const own = daemon.config.providers.claude as { enabled: boolean; paseoTools: { disabledTools: string[] } };
  assert.equal(own.enabled, true, "the owner's own entry keeps what it had");
  assert.ok(own.paseoTools.disabledTools.includes("send_agent_prompt"));
  assert.ok(!own.paseoTools.disabledTools.includes("create_agent"));
  for (const harness of ["codex", "pi", "opencode"])
    assert.deepEqual(daemon.config.providers[harness], { paseoTools: own.paseoTools }, harness);
  // what the SDK cannot set is written into config.json: none of Paseo's bundled skills, no dictation or voice mode
  const written = JSON.parse(readFileSync(paseoFile, "utf8"));
  assert.deepEqual(
    [written.agents.skills.selection, written.features.dictation.enabled, written.features.voiceMode.enabled],
    [{ mode: "custom", skills: [] }, false, false],
  );
  // the room runs: a seat created now gets its role and the room's mail server
  const seat = await createPeer();
  assert.match(seat.config.systemPrompt, /^# The room\n[\s\S]*\n# Seat: peer\n/);
  assert.ok("seatwork" in seat.config.mcpServers);

  // the Lead moved to a harness of its own: its seat is set up, and nothing is registered twice
  await init({ models: { seats: { lead: { provider: "pi-lead/m", thinking: "high" } } }, chime: true });
  assert.ok("pi-lead" in daemon.config.providers);
  assert.equal(policy().owner.chime, true);
  const hooks = names();
  assert.deepEqual(hooks.filter((name) => name === "on agent.turn_ended").length, 1);
  assert.deepEqual(daemon.workspaces.length, 1, "the HQ project was opened a second time");

  const screen = await state();
  assert.deepEqual(screen.applied?.models, { seats: { lead: { provider: "pi-lead/m", thinking: "high" } } });
  assert.ok(screen.applied?.seats.includes("pi-lead"));
  assert.ok(
    !screen.checks.some((check) => check.id === "version"),
    "a room this version set up is told to apply again",
  );
});

test("a project's own models are written into the project from the screen and taken out again; a table the room cannot run on changes nothing", async () => {
  writeFileSync(join(ROOM_HOME, "projects.json"), JSON.stringify({ projects: [{ name: "shop", cwd: PROJECT }] }));
  const project = async () => ((await state()) as unknown as { projects: object[] }).projects[0];
  const marker = () => JSON.parse(readFileSync(join(PROJECT, ".seatwork", "room.json"), "utf8")) as { models?: object };
  const write = (name: string, models: object | null) => call("rpc setup.project", { name, models }, context);
  const shop = { name: "shop", root: realpathSync(PROJECT), error: null };
  assert.deepEqual(await project(), { ...shop, own: false, models: {} });

  // its Supervisor moves to an agent CLI the room has no seat for: the seat is set up first
  const own = { seats: { supervisor: { provider: "opencode-supervisor/m", thinking: "default" } } };
  assert.deepEqual(await write("shop", own), { own: true, seats: ["opencode-supervisor"] });
  assert.ok("opencode-supervisor" in daemon.config.providers);
  assert.deepEqual(marker().models, own);
  assert.deepEqual(await project(), { ...shop, own: true, models: own });

  await assert.rejects(
    write("shop", { peer: { tiers: { cheap: null, default: null, "cross-family": null, high: null, extra: null } } }),
    /leaves the peer role without a model/,
  );
  assert.deepEqual(marker().models, own, "a table the room refused was written");
  await assert.rejects(write("elsewhere", own), /elsewhere is not a registered project/);

  // edited by hand to name a seat the room lacks: the screen says why, and saving sets the seat up
  const byHand = { seats: { lead: { provider: "opencode-lead/m", thinking: "default" } } };
  writeFileSync(join(PROJECT, ".seatwork", "room.json"), JSON.stringify({ models: byHand }));
  assert.match(((await project()) as { error: string }).error, /names opencode-lead, which the room has not enabled/);
  assert.deepEqual(await write("shop", byHand), { own: true, seats: ["opencode-lead"] });
  assert.deepEqual(await project(), { ...shop, own: true, models: byHand });

  assert.deepEqual(await write("shop", {}), { own: false, seats: [] });
  assert.deepEqual(marker(), {});
  rmSync(join(ROOM_HOME, "projects.json"));
});

test("an update of the plugin finishes itself: the next seat starts on this version's files, on the choices the room had, and the daemon's own switches are left alone", async () => {
  const choices = JSON.parse(readFileSync(setupFile, "utf8"));
  writeFileSync(join(ROOM_HOME, "room", "roles", "peer.md"), "the prompt of 0.1.0");
  delete daemon.config.providers["claude-peer"];
  await updated();

  const seat = await createPeer();

  assert.match(seat.config.systemPrompt, /^# The room\n[\s\S]*\n# Seat: peer\n/);
  assert.doesNotMatch(seat.config.systemPrompt, /the prompt of 0\.1\.0/);
  assert.deepEqual(JSON.parse(readFileSync(setupFile, "utf8")), { ...choices, version: VERSION });
  assert.ok("claude-peer" in daemon.config.providers && "pi-lead" in daemon.config.providers);
  assert.ok(!daemon.patches.some((patch) => "browserTools" in patch), "a switch of the daemon was set with no click");
  assert.ok(!(await state()).checks.some((check) => check.id === "version"));
  assert.deepEqual(names().filter((name) => name === "on agent.turn_ended").length, 1);

  // with the app open its own question is enough: no seat has to be created first
  await updated();
  await call("rpc room.waiting", {}, context);
  assert.equal(stamp(), VERSION);
});

test("an update the room cannot finish keeps new seats out and says why; it is tried again when a seat is created or the screen opens, not at every question of the app", async () => {
  await updated();
  daemon.refuses = "the daemon is busy";

  await assert.rejects(
    createPeer(),
    /set up by version 0\.1\.0 .*could not bring them to .*: the daemon is busy.*Press Apply on the Seatwork screen/,
  );
  assert.equal(stamp(), "0.1.0", "a room whose seats Paseo refused was marked as brought up");
  const tried = daemon.patches.length;
  await call("rpc room.waiting", {}, context);
  assert.equal(daemon.patches.length, tried, "the app's question tried again within the minute");
  const row = (await state()).checks.find((check) => check.id === "version");
  assert.deepEqual([row?.ok, /the daemon is busy/.test(row?.detail ?? "")], [false, true]);

  daemon.refuses = "";
  assert.ok(!(await state()).checks.some((check) => check.id === "version"));
  assert.equal(stamp(), VERSION);
});

test("while Paseo still lists the folder of the version before, the room is not brought up from it", async () => {
  const older = join(ROOM_HOME, "..", "the-checkout-before");
  for (const [file, text] of [
    ["package.json", '{"version":"0.1.0"}'],
    ["room/models.json", '{"seats":{"hq":{"provider":"claude-hq/an-old-model"}}}'],
    ["paseo/policy.json", "{}"],
  ]) {
    mkdirSync(join(older, file, ".."), { recursive: true });
    writeFileSync(join(older, file), text);
  }
  daemon.config.plugins = { seatwork: { path: older } };
  await updated();

  await assert.rejects(createPeer(), new RegExp(`folder holds version 0\\.1\\.0 and the plugin running is ${VERSION}`));
  assert.deepEqual([stamp(), daemon.patches.length], ["0.1.0", 0]);

  daemon.config.plugins = { seatwork: { path: PLUGIN_DIR } };
  await createPeer();
  assert.equal(stamp(), VERSION);
  rmSync(older, { recursive: true });
});

test("a seat opened by an earlier version of the plugin is named on the screen until it is archived", async () => {
  const opened = (agentId: string, version?: string) =>
    `${JSON.stringify({ agentId, parentAgentId: null, provider: "claude-lead", role: "lead", title: null, version })}\n`;
  appendFileSync(join(ROOM_HOME, "registry-log.jsonl"), opened("before-1", "0.1.0") + opened("before-2"));
  await restart();
  const created = { id: "now-1", provider: "claude-peer", cwd: PROJECT, title: "[Peer] new", parentAgentId: null };
  await call("on agent.created", { agent: created }, context);
  daemon.open = [
    { id: "before-1", provider: "claude-lead", title: "[Lead] billing" },
    { id: "before-2", provider: "claude-lead", title: "[Lead] search" },
    { id: "now-1", provider: "claude-peer", title: "[Peer] new" },
    { id: "a2", provider: "claude", title: "not a seat" },
  ];

  const row = (await state()).checks.find((check) => check.id === "older-seats");

  assert.equal(row?.ok, false);
  assert.match(row?.detail ?? "", /^2 open seats .*\[Lead\] billing, \[Lead\] search/);
  assert.doesNotMatch(row?.detail ?? "", /\[Peer\] new|not a seat/);
  daemon.open = [daemon.open[2]];
  assert.ok(!(await state()).checks.some((check) => check.id === "older-seats"));
  daemon.open = [];
});

test("the screen says when the room's own seat is not running, so the sidebar needs the Owner; an open one clears it", async () => {
  daemon.open = [];
  const missing = (await state()).checks.find((check) => check.id === "own-seat");
  assert.equal(missing?.ok, false);
  assert.match(missing?.detail ?? "", /not running/);
  daemon.open = [{ id: "hq-1", provider: "claude-hq", title: "[HQ] the room's operator" }];
  const open = (await state()).checks.find((check) => check.id === "own-seat");
  assert.deepEqual([open?.ok, open?.detail], [true, "[HQ] the room's operator runs the room."]);
  daemon.open = [];
});

test("removing the room waits for its seats, then takes it out of Paseo and out of the projects it worked in, keeps all of it beside its home, and leaves the plugin asleep", async () => {
  // a registered project, a folder a seat ran in, one with a linked .seatwork, one the room never knew
  const [seatDir, linked, stranger] = ["seat-ran-here", "linked", "stranger"].map((name) =>
    join(realpathSync(PROJECT), "..", name),
  );
  const seatwork = (dir: string, ...files: string[]) => {
    mkdirSync(join(dir, ".seatwork", "plans"), { recursive: true });
    for (const file of files) writeFileSync(join(dir, ".seatwork", file), file);
  };
  rmSync(join(PROJECT, ".seatwork"), { recursive: true, force: true });
  seatwork(
    PROJECT,
    "room.json",
    "mission.md",
    "shop-law.md",
    "status.md",
    "notebook.md",
    "plans/billing.md",
    "mine.txt",
  );
  writeFileSync(join(PROJECT, "code.ts"), "the user's");
  seatwork(seatDir, "status.md");
  seatwork(stranger, "status.md");
  mkdirSync(linked);
  symlinkSync(join(stranger, ".seatwork"), join(linked, ".seatwork"));
  writeFileSync(join(ROOM_HOME, "projects.json"), JSON.stringify({ projects: [{ name: "shop", cwd: PROJECT }] }));
  appendFileSync(
    join(ROOM_HOME, "registry-log.jsonl"),
    [seatDir, linked, join(ROOM_HOME, "hq-seatwork")]
      .map((cwd) => `${JSON.stringify({ agentId: cwd, cwd })}\n`)
      .join(""),
  );

  daemon.open = [
    { id: "a1", provider: "claude-lead", title: "[Lead] billing" },
    { id: "a2", provider: "claude", title: "not a seat" },
  ];
  await assert.rejects(
    Promise.resolve(call("rpc setup.remove", {}, context)),
    /1 room seat is still open \(\[Lead\] billing\); archive them first/,
  );
  assert.ok("claude-hq" in daemon.config.providers && existsSync(join(PROJECT, ".seatwork", "status.md")));

  daemon.open = [daemon.open[1]];
  // the room's archived HQ seat and its Claude session, beside an agent of the owner's in the same folder
  const hqDir = join(ROOM_HOME, "hq-seatwork");
  const sessions = join(process.env.CLAUDE_CONFIG_DIR!, "projects", hqDir.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(sessions, { recursive: true });
  for (const id of ["hq-session", "own-session"]) writeFileSync(join(sessions, `${id}.jsonl`), "{}\n");
  daemon.archived = [
    { id: "z1", provider: "claude-hq", cwd: hqDir, archivedAt: "2026-10-17", persistence: { sessionId: "hq-session" } },
    { id: "z2", provider: "claude", cwd: hqDir, archivedAt: "2026-10-17", persistence: { sessionId: "own-session" } },
  ];
  const { removed, movedTo, projects, notes } = (await call("rpc setup.remove", {}, context)) as {
    removed: string[];
    movedTo: string;
    projects: { root: string; moved: string[]; left: string[] }[];
    notes: string[];
  };

  assert.deepEqual(
    [Object.keys(daemon.config.providers), daemon.config.agentProfiles],
    [["my-own", "claude"], [{ id: "mine" }]],
  );
  assert.ok(removed.includes("claude-hq") && !removed.includes("my-own"));
  assert.deepEqual(
    [existsSync(ROOM_HOME), dirname(movedTo), existsSync(join(movedTo, "room", "models.json"))],
    [false, dirname(ROOM_HOME), true],
  );
  // the daemon-wide switches the room set are the owner's again
  assert.deepEqual(
    [daemon.config.mcp.injectIntoAgents, daemon.config.browserTools.enabled, daemon.config.enableTerminalAgentHooks],
    [false, true, true],
  );
  // the owner's agents have Paseo's whole set again, and an entry the room added for one goes
  assert.deepEqual(daemon.config.providers.claude, { enabled: true, paseoTools: { enabled: true, disabledTools: [] } });
  const back = JSON.parse(readFileSync(paseoFile, "utf8"));
  assert.deepEqual([back.agents, back.features], [undefined, { dictation: { enabled: true } }]);
  // the HQ seat's session goes with the room; the owner's own stays; the CLI that deletes the record fails here
  assert.deepEqual(readdirSync(sessions), ["own-session.jsonl"]);
  assert.ok(existsSync(join(movedTo, "claude-sessions", hqDir.replace(/[^A-Za-z0-9]/g, "-"), "hq-session.jsonl")));
  assert.match(notes.join(" "), /Paseo still lists 1 archived seat of the room/);
  // the paseo CLI fails here: the HQ workspace is archived, and the screen is told the project's line stays
  assert.deepEqual(daemon.workspaces, [], "the HQ workspace is still listed in Paseo");
  assert.match(notes.join(" "), /hq-seatwork project is still in Paseo's list/);

  // the room's files leave .seatwork/ by name; the user's file stays, and so does its folder
  const shop = projects.find((project) => project.root === realpathSync(PROJECT))!;
  assert.deepEqual(
    [shop.moved.sort(), shop.left],
    [["mission.md", "notebook.md", "plans", "room.json", "shop-law.md", "status.md"], ["mine.txt"]],
  );
  assert.deepEqual(
    [readdirSync(join(PROJECT, ".seatwork")), readFileSync(join(PROJECT, "code.ts"), "utf8")],
    [["mine.txt"], "the user's"],
  );
  const kept = readdirSync(join(movedTo, "projects")).find((name) => name.endsWith("project"))!;
  assert.equal(
    readFileSync(join(movedTo, "projects", kept, ".seatwork", "plans", "billing.md"), "utf8"),
    "plans/billing.md",
  );
  // an emptied .seatwork/ goes; a linked .seatwork and a folder the room never knew are not touched
  assert.deepEqual(projects.map((project) => project.root).sort(), [realpathSync(PROJECT), seatDir].sort());
  assert.deepEqual(
    [
      existsSync(join(seatDir, ".seatwork")),
      readdirSync(join(stranger, ".seatwork")).sort(),
      existsSync(join(linked, ".seatwork", "status.md")),
    ],
    [false, ["plans", "status.md"], true],
  );
  await assert.rejects(createPeer(), /no room is set up on this daemon/);
  assert.deepEqual(
    names().filter((name) => name.startsWith("on ")),
    [],
  );
});

test("removing the plugin takes the room out of Paseo by itself, and puts its home and what was set aside in the Trash", async () => {
  const trash =
    process.platform === "darwin"
      ? join(process.env.HOME!, ".Trash")
      : join(process.env.HOME!, ".local", "share", "Trash", "files");
  mkdirSync(trash, { recursive: true });
  daemon.archived = [];
  await init();
  assert.ok("claude-hq" in daemon.config.providers);
  daemon.config.plugins = {};
  await stop();

  assert.deepEqual(
    [Object.keys(daemon.config.providers), daemon.config.agentProfiles],
    [["my-own", "claude"], [{ id: "mine" }]],
  );
  assert.deepEqual(
    [daemon.config.mcp.injectIntoAgents, daemon.config.browserTools.enabled, daemon.config.enableTerminalAgentHooks],
    [false, true, true],
  );
  assert.equal(existsSync(ROOM_HOME), false);
  const trashed = readdirSync(trash).filter((name) => name.startsWith(`${basename(ROOM_HOME)}.removed-`));
  assert.equal(trashed.length, 2, "the home this removal set aside and the one Remove set aside before");
  assert.deepEqual(
    readdirSync(dirname(ROOM_HOME)).filter((name) => name.startsWith(`${basename(ROOM_HOME)}.removed-`)),
    [],
  );
});
