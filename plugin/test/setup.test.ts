import { installRoom, PLUGIN_DIR, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { loadPolicy } from "../server/policy";
import { envFor } from "../server/orchestration/runtimes";
import { parseSeat } from "../server/orchestration/seats";
import { choose, type ChoiceFlags, type Terminal } from "../server/paseo/setup/choices";
import { addSeats, setUpRoom } from "../server/paseo/setup/init";
import { applyToConfigFile, applyWithSdk } from "../server/paseo/setup/paseo-config";
import { checkSetup, planRoom, roomModels, type Catalog, type Setup } from "../server/paseo/setup/plan";
import { sweepRemoved } from "../server/gc";
import { isSetUp, readSetup } from "../server/paseo/setup/room-home";
import {
  changedRoles,
  chooseSeat,
  chooseTier,
  clearRole,
  dropTier,
  merge,
  seatChanged,
  seatChoice,
  type Table,
  tierChoices,
  tierDiff,
} from "../shared/model-choices";

// every harness has the same two models, plus the one the room's own table puts HQ on
const catalog: Catalog = async () => ({
  "m-one": { label: "One", thinking: ["low", "medium", "high"], defaultThinking: "medium" },
  "vendor/m-two": { label: "Two", thinking: [] },
  "claude-opus-5-5": { label: "Opus", thinking: ["medium", "high"], defaultThinking: "high" },
});
const source = { pluginDir: PLUGIN_DIR, roomHome: ROOM_HOME, catalog, version: "9.9.9" };
const paseoAccepts = () => {};
const plan = (setup: Setup = {}) => planRoom({ ...source, setup });

/** A terminal with these lines typed at it; the input ends after the last one. */
function typed(text: string): Terminal {
  const lines = text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  return { isTTY: false, ask: async () => lines.shift() ?? null, say: () => {} };
}

const chosen = (flags: Partial<ChoiceFlags>, text: string, before: Setup = {}) =>
  choose(before, { seats: [], ...flags }, typed(text), {
    catalog,
    hq: { provider: "claude-hq/claude-opus-5-5", thinking: "high" },
  });

beforeEach(() => rmSync(ROOM_HOME, { recursive: true, force: true }));

/** What the table says a role's tier is for. */
const tierUse = (table: Table, role: string, tier: string) =>
  (table[role] as { tiers: Record<string, { use?: string }> }).tiers[tier].use;

/** The room's own seat among a machine's model choices, if they name it. */
const ownSeat = (setup: Setup) => (setup.models as { seats?: Record<string, unknown> } | undefined)?.seats?.hq;

test("the installer's question: the room's HQ seat as the table has it, or the user's own agent CLI and model, kept in the model choices", async () => {
  const cases: [typed: string, seat: unknown][] = [
    ["\n", undefined],
    ["", undefined], // no terminal to answer
    ["2\n3\n1\n\n", { provider: "pi-hq/m-one", thinking: "medium" }],
    ["custom\nopencode\nvendor/m-two\n", { provider: "opencode-hq/vendor/m-two", thinking: "default" }], // a model without thinking options
    ["2\ncodex\nnope\n1\nhigh\n", { provider: "codex-hq/m-one", thinking: "high" }], // a wrong answer is asked again
  ];
  for (const [text, seat] of cases)
    assert.deepEqual(ownSeat(await chosen({ hq: "ask" }, text)), seat, JSON.stringify(text));
  // default takes the table's seat back, and leaves the machine's other choices
  const before: Setup = { models: { seats: { hq: { provider: "pi-hq/m-one" }, lead: { provider: "pi-lead/m-one" } } } };
  assert.deepEqual((await chosen({ hq: "default" }, "", before)).models, {
    seats: { lead: { provider: "pi-lead/m-one" } },
  });
});

test("an hq an earlier version wrote into setup.json becomes the room's seat among the model choices", () => {
  const moved = checkSetup({ hq: { provider: "codex-hq/m-one", thinking: "high" }, chime: true }, "setup.json");
  assert.deepEqual(moved, { chime: true, models: { seats: { hq: { provider: "codex-hq/m-one", thinking: "high" } } } });
  assert.deepEqual(checkSetup({ hq: "default", seats: [] }, "setup.json"), { seats: [] });
  const named = { hq: { provider: "codex-hq/m-one" }, models: { seats: { hq: { provider: "pi-hq/m-one" } } } };
  assert.deepEqual(checkSetup(named, "setup.json"), { models: named.models }, "the table's own choice stands");
  assert.throws(
    () => checkSetup({ hq: { provider: "codex-lead/m-one" } }, "setup.json"),
    /for a role at home in the room/,
  );
});

test("a choice the installer cannot honour is refused by name", async () => {
  const cases: [flags: Partial<ChoiceFlags>, error: RegExp][] = [
    [{ seats: ["claude-boss"] }, /--seat claude-boss: a seat is <harness>-<role>/],
    [{ hq: "codex/nope" }, /codex has no model nope; it has: m-one/],
    [{ hq: "codex/m-one", hqThinking: "max" }, /no thinking option max; it has: low, medium, high/],
    [{ hq: "emacs/m-one" }, /--hq takes default, ask or <harness>\/<model>/],
    [{ hqThinking: "high" }, /--hq-thinking goes with --hq/],
  ];
  for (const [flags, error] of cases) await assert.rejects(chosen(flags, ""), error, JSON.stringify(flags));
});

test("the provider written for a seat starts it as the plugin does: the same environment, the same flags", async () => {
  installRoom([]);
  // every install gets Claude and Codex seats; this machine added one of each other harness
  const { providers } = await plan({ seats: ["pi-peer", "opencode-peer"] });
  const policy = loadPolicy();

  assert.deepEqual([...new Set(Object.keys(providers).map((id) => parseSeat(id)!.harness))].sort(), [
    "claude",
    "codex",
    "opencode",
    "pi",
  ]);
  for (const [id, provider] of Object.entries(providers)) {
    const seat = parseSeat(id)!;
    assert.deepEqual(provider.env, envFor(seat, policy), id);
    assert.deepEqual(provider.options?.extraArgs, policy.launch[seat.harness].extraArgs, id);
  }
});

test("a role's seat and profile follow the model this machine chose for it", async () => {
  const { providers, profiles, models } = await plan({
    models: {
      seats: {
        hq: { provider: "opencode-hq/vendor/m-two", thinking: "default" },
        supervisor: { provider: "pi-supervisor/m-one", thinking: "high" },
      },
    },
  });
  const profile = (id: string) => {
    const { provider, model, modeId, thinkingOptionId } = profiles.find((p) => p.id === id)!;
    return { provider, model, modeId, thinkingOptionId };
  };

  // choosing a model for a role is what sets its seat up
  assert.ok("opencode-hq" in providers && "pi-supervisor" in providers);
  assert.deepEqual(models.seats.hq, { provider: "opencode-hq/vendor/m-two", thinking: "default" });
  // a model without thinking options and a harness without session modes take no such setting
  assert.deepEqual(profile("agent_profile_seatwork_hq"), {
    provider: "opencode-hq",
    model: "vendor/m-two",
    modeId: "build",
    thinkingOptionId: undefined,
  });
  assert.deepEqual(profile("agent_profile_seatwork_supervisor"), {
    provider: "pi-supervisor",
    model: "m-one",
    modeId: undefined,
    thinkingOptionId: "high",
  });
  // a seat lists only the models the table gives it, the first as its default
  assert.deepEqual(providers["pi-supervisor"].models, [
    {
      id: "m-one",
      label: "One",
      thinkingOptions: [
        { id: "low", label: "low" },
        { id: "medium", label: "medium", isDefault: true },
        { id: "high", label: "high" },
      ],
      isDefault: true,
    },
  ]);
});

test("the screen's choices become the table the room runs on: one model for a seat, several named ones for a Peer or a Lens", async () => {
  const room = roomModels(PLUGIN_DIR) as unknown as Table;
  let choices = chooseSeat({}, "lead", { harness: "pi", model: "vendor/m-1", thinking: "low" });
  choices = chooseTier(choices, "peer", "cheap", { harness: "pi", model: "m-one", thinking: "" }); // a model of the room's table, changed
  choices = chooseTier(
    choices,
    "peer",
    "extra",
    { harness: "opencode", model: "vendor/m-two", thinking: "" },
    "the long jobs",
  ); // one more
  choices = dropTier(choices, room, "peer", "cross-family"); // one of the room's own, taken out
  choices = chooseTier(choices, "lens", "high", { harness: "pi", model: "m-one", thinking: "high" });

  const { models, providers } = await plan({ models: choices });
  const table = models as unknown as Table;

  assert.deepEqual(seatChoice(table, "lead"), { harness: "pi", model: "vendor/m-1", thinking: "low" });
  assert.deepEqual(
    tierChoices(table, "peer").map((tier) => [tier.label, tier.harness, tier.model, tier.use]),
    [
      ["cheap", "pi", "m-one", tierUse(room, "peer", "cheap")],
      ["default", "claude", "claude-sonnet-5-5", tierUse(room, "peer", "default")],
      ["extra", "opencode", "vendor/m-two", "the long jobs"],
    ],
  );
  assert.deepEqual(
    tierChoices(table, "lens").find((tier) => tier.label === "high"),
    { label: "high", use: tierUse(room, "lens", "high"), more: 0, harness: "pi", model: "m-one", thinking: "high" },
  );
  // choosing a model for a role is what sets its seat up
  for (const seat of ["pi-lead", "pi-peer", "opencode-peer", "pi-lens"]) assert.ok(seat in providers, seat);
  // a model the choices added leaves them whole; one of the room's own stays out
  assert.deepEqual(dropTier(choices, room, "peer", "extra").peer, {
    tiers: { cheap: (choices.peer as { tiers: Record<string, unknown> }).tiers.cheap, "cross-family": null },
  });
});

test("a project's own choices name the roles they change, and a role given back leaves nothing of itself behind", () => {
  let own = chooseSeat({}, "lead", { harness: "claude", model: "m", thinking: "low" });
  own = chooseTier(own, "peer", "cheap", { harness: "pi", model: "m-one", thinking: "" });
  assert.deepEqual(changedRoles(own), ["lead", "peer"]);

  own = clearRole(own, "peer");
  assert.deepEqual(changedRoles(own), ["lead"]);
  assert.deepEqual(clearRole(own, "lead"), {}, "a project with no role of its own is on the room's table");
});

test("what applying would change is named model by model: changed, added, taken out", async () => {
  const room = roomModels(PLUGIN_DIR) as unknown as Table;
  let choices = chooseSeat({}, "lead", { harness: "claude", model: "claude-sonnet-5-5", thinking: "medium" });
  choices = chooseTier(choices, "peer", "cheap", { harness: "pi", model: "m-one", thinking: "" });
  choices = chooseTier(
    choices,
    "peer",
    "extra",
    { harness: "claude", model: "claude-opus-5-5", thinking: "high" },
    "the long jobs",
  );
  choices = dropTier(choices, room, "peer", "cross-family");
  const next = merge(room, choices) as Table;

  assert.deepEqual([seatChanged(room, next, "lead"), seatChanged(room, next, "supervisor")], [true, false]);
  assert.deepEqual(
    tierDiff(room, next, "peer").map((tier) => [tier.label, tier.change]),
    [
      ["cheap", "changed"],
      ["default", "same"],
      ["extra", "added"],
      ["cross-family", "removed"],
    ],
  );
  assert.ok(tierDiff(room, next, "lens").every((tier) => tier.change === "same"));
  // a daemon with no room yet has nothing to compare with: nothing waits
  assert.deepEqual(
    [seatChanged(null, next, "lead"), tierDiff(null, next, "peer").some((tier) => tier.change !== "same")],
    [false, false],
  );
});

test("choices the room cannot run on are refused before anything is written", async () => {
  const cases: [setup: Setup, error: RegExp][] = [
    [{ models: { seats: { supervisor: { provider: "pi-peer/m-one" } } } }, /not a supervisor seat/],
    [{ models: { seats: { lead: { provider: "emacs-lead/m-one" } } } }, /"emacs-lead", which is not a seat/],
  ];
  for (const [setup, error] of cases)
    await assert.rejects(setUpRoom(source, setup, paseoAccepts), error, JSON.stringify(setup));
  assert.ok(!isSetUp(ROOM_HOME));
});

test("setting the room up again replaces the room's files and keeps what the room wrote since", async () => {
  await setUpRoom(source, { seats: ["pi-peer", "opencode-peer"], chime: false }, paseoAccepts);
  for (const kept of ["mail", "runtimes/pi/peer", "runtimes/opencode/peer", "runtimes/claude/peer"])
    mkdirSync(join(ROOM_HOME, kept), { recursive: true });
  writeFileSync(join(ROOM_HOME, "mail", "log.jsonl"), "{}\n");
  writeFileSync(join(ROOM_HOME, "room", "roles", "dropped-from-the-plugin.md"), "stale");

  await setUpRoom(source, { seats: ["pi-peer"] }, paseoAccepts);

  const policy = JSON.parse(readFileSync(join(ROOM_HOME, "policy.json"), "utf8"));
  assert.equal(policy.owner.chime, true);
  assert.ok(existsSync(join(ROOM_HOME, "mail", "log.jsonl")));
  assert.ok(!existsSync(join(ROOM_HOME, "room", "roles", "dropped-from-the-plugin.md")));
  // a seat no longer enabled loses its runtime; a Claude seat runs on the user's own home and has none
  assert.deepEqual(
    ["pi/peer", "opencode/peer", "claude/peer"].map((dir) => existsSync(join(ROOM_HOME, "runtimes", dir))),
    [true, false, false],
  );
  assert.equal(readSetup(ROOM_HOME).version, "9.9.9");
});

test("a seat added to a running room is kept by every later setup, and adding it moves nothing else", async () => {
  await setUpRoom(source, {}, paseoAccepts);
  writeFileSync(join(ROOM_HOME, "room", "roles", "edited-by-hand.md"), "kept");

  // the plugin was updated since: adding a seat does not make the room's files this version's
  const added = await addSeats({ ...source, version: "10.0.0" }, ["pi-supervisor"]);

  assert.ok("pi-supervisor" in added.providers);
  assert.ok(existsSync(join(ROOM_HOME, "room", "roles", "edited-by-hand.md")));
  assert.equal(readSetup(ROOM_HOME).version, "9.9.9");
  assert.ok("pi-supervisor" in (await setUpRoom(source, readSetup(ROOM_HOME), paseoAccepts)).providers);
  await assert.rejects(addSeats(source, ["pi-boss"]), /"pi-boss" is not a seat/);
});

test("Paseo's config.json takes the room's seats and profiles and keeps everything of the user's", async () => {
  const before = {
    version: 1,
    daemon: {
      listen: "127.0.0.1:1",
      mcp: { enabled: false },
      agentProfiles: [
        { id: "mine", name: "Mine" },
        { id: "agent_profile_seatwork_gone", name: "Old room profile" },
        { id: "agent_profile_slp_hq", name: "From before 0.19.0" },
      ],
    },
    agents: {
      providers: {
        "my-own": { extends: "claude" },
        "pi-lens": { extends: "pi" },
        "claude-peer": { extends: "claude", env: { OLD: "1" } },
      },
      skills: { selection: { mode: "all" } },
    },
    features: { dictation: { enabled: true, model: "kept" } },
  };
  const room = await plan();
  const paseoHome = join(ROOM_HOME, "a-paseo-home");
  const file = join(paseoHome, "config.json");
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(file, JSON.stringify(before));
  applyToConfigFile(paseoHome, room);
  const written = JSON.parse(readFileSync(file, "utf8"));

  assert.deepEqual(Object.keys(written.agents.providers).sort(), ["my-own", ...Object.keys(room.providers)].sort());
  assert.deepEqual(written.agents.providers["claude-peer"], room.providers["claude-peer"]); // replaced whole: no key of the old entry stays
  assert.deepEqual(
    written.daemon.agentProfiles.map((p: { id: string }) => p.id),
    ["mine", ...room.profiles.map((p) => p.id)],
  );
  assert.deepEqual(
    [written.daemon.listen, written.daemon.mcp, written.pluginsEnabled],
    ["127.0.0.1:1", { enabled: true, injectIntoAgents: true }, true],
  );
  // the daemon-wide switches follow the room's policy; what the user kept beside one stays
  assert.deepEqual(
    [written.features.dictation, written.agents.skills.selection],
    [
      { enabled: false, model: "kept" },
      { mode: "custom", skills: [] },
    ],
  );
  // the file as it was stays beside the new one
  const backup = readdirSync(paseoHome).find((name) => name.startsWith("config.json.bak-"))!;
  assert.deepEqual(JSON.parse(readFileSync(join(paseoHome, backup), "utf8")), before);
});

test("the installer's command sets the room up from a terminal: the room home, and the seats and profiles in Paseo's config.json", () => {
  const paseoHome = process.env.PASEO_HOME!;
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(
    join(paseoHome, "config.json"),
    JSON.stringify({ version: 1, agents: { providers: { "my-own": { extends: "claude" } } } }),
  );

  const run = spawnSync(
    process.execPath,
    [
      "--require",
      join(PLUGIN_DIR, "test", "register.cjs"),
      join(PLUGIN_DIR, "tools", "room-init.ts"),
      "--hq",
      "default",
      "--seat",
      "pi-peer",
      "--mail-port",
      "0",
    ],
    { encoding: "utf8", input: "" },
  );

  assert.equal(run.status, 0, run.stderr);
  const config = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8"));
  assert.ok(["my-own", "claude-hq", "pi-peer"].every((id) => id in config.agents.providers));
  assert.equal(config.daemon.agentProfiles[0].id, "agent_profile_seatwork_hq");
  assert.deepEqual([isSetUp(ROOM_HOME), readSetup(ROOM_HOME).seats], [true, ["pi-peer"]]);
  assert.equal(JSON.parse(readFileSync(join(ROOM_HOME, "policy.json"), "utf8")).mail.port, 0);
  assert.equal(
    spawnSync(
      process.execPath,
      ["--require", join(PLUGIN_DIR, "test", "register.cjs"), join(PLUGIN_DIR, "tools", "room-init.ts"), "--hq"],
      { encoding: "utf8" },
    ).status,
    1,
    "a flag without its value",
  );
});

test("a folder set aside by Remove is deleted once its keep is over, by the time in its name, and nothing else beside the room home is", () => {
  const parent = join(ROOM_HOME, "..", "kept");
  const home = join(parent, "seatwork");
  const names = [
    "seatwork.removed-20260901-120000",
    "seatwork.removed-20261001-080000",
    "other.removed-20260901-120000",
    "seatwork.removed-by-hand",
    "seatwork",
  ];
  for (const name of names) mkdirSync(join(parent, name, "mail"), { recursive: true });

  const gone = sweepRemoved(home, 30, new Date(2026, 9, 12, 9, 0, 0));

  assert.deepEqual(gone.map((folder) => folder.slice(parent.length + 1)).sort(), ["seatwork.removed-20260901-120000"]);
  assert.deepEqual(readdirSync(parent).sort(), [
    "other.removed-20260901-120000",
    "seatwork",
    "seatwork.removed-20261001-080000",
    "seatwork.removed-by-hand",
  ]);
  rmSync(parent, { recursive: true });
});

test("install.sh refuses, before it writes anything, when Paseo runs the plugin from another folder, under its id or its old one", () => {
  const bin = join(ROOM_HOME, "..", "install-bin");
  const paseoHome = join(ROOM_HOME, "..", "install-paseo-home");
  mkdirSync(bin, { recursive: true });
  for (const id of ["seatwork", "slp-seat"]) {
    // a stand-in paseo: new enough, with the plugin installed from its own checkout
    writeFileSync(
      join(bin, "paseo"),
      `#!/bin/sh\ncase "$*" in\n"daemon status --json") echo '{"daemonVersion":"0.11.2"}' ;;\n"plugin ls --json") echo '[{"id":"${id}","path":"/paseo/own/checkout/plugin"}]' ;;\n*) exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );

    const run = spawnSync("bash", [join(PLUGIN_DIR, "..", "install.sh")], {
      encoding: "utf8",
      env: { ...process.env, PASEO_HOME: paseoHome, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.equal(run.status, 1, run.stderr);
    assert.match(
      run.stderr,
      new RegExp(`^${id} already runs from /paseo/own/checkout/plugin.*\\n.*\\n.*paseo plugin remove ${id}'`),
    );
    assert.deepEqual([isSetUp(ROOM_HOME), existsSync(paseoHome)], [false, false]);
  }
});

test("a running daemon is patched so that no seat keeps a key its new entry dropped", async () => {
  const room = await plan();
  const config = {
    providers: {
      "my-own": { extends: "claude" },
      "pi-lens": { extends: "pi" },
      "claude-peer": { ...room.providers["claude-peer"], env: { ...room.providers["claude-peer"].env, OLD: "1" } },
      "claude-lead": room.providers["claude-lead"],
    },
    agentProfiles: [{ id: "mine" }, { id: "agent_profile_seatwork_gone" }],
  };
  const patches: {
    providers?: Record<string, unknown>;
    removeProviders?: string[];
    agentProfiles?: { id: string }[];
  }[] = [];
  const paseo = {
    config: {
      get: async () => ({ config }),
      patch: async (patch: (typeof patches)[number]) => void patches.push(patch),
    },
  };

  const { removed } = await applyWithSdk(paseo as never, room, { daemonPolicy: false });

  // Paseo merges a patched provider into the one it holds, and drops one named in both lists of a patch
  assert.deepEqual(patches[0], { removeProviders: ["pi-lens", "claude-peer"] });
  assert.equal(patches[1].removeProviders, undefined);
  assert.deepEqual(patches[1].providers, room.providers);
  assert.deepEqual(
    patches[1].agentProfiles!.map((p) => p.id),
    ["mine", ...room.profiles.map((p) => p.id)],
  );
  assert.deepEqual(removed, ["pi-lens"]);
});
