import { installRoom, PLUGIN_DIR, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { PASEO_HOME } from "../server/paths";
import { loadPolicy } from "../server/policy";
import { envFor } from "../server/orchestration/runtimes";
import { parseSeat } from "../server/orchestration/seats";
import { addSeats, setUpRoom } from "../server/paseo/setup/init";
import { applyWithSdk } from "../server/paseo/setup/paseo-config";
import { planRoom, roomModels, type Catalog, type Setup } from "../server/paseo/setup/plan";
import { sweepRemoved } from "../server/gc";
import { keptAt, takeRoomFiles } from "../server/paseo/setup/project-files";
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

beforeEach(() => rmSync(ROOM_HOME, { recursive: true, force: true }));

/** The warnings setup gave about the room's policy. */
const policyWarnings = (warnings: string[]) => warnings.filter((w) => w.startsWith("policy.json:"));

/** What the table says a role's tier is for. */
const tierUse = (table: Table, role: string, tier: string) =>
  (table[role] as { tiers: Record<string, { use?: string }> }).tiers[tier].use;

test("the provider written for a seat starts it as the plugin does: the same environment, the same flags, the same denials", async () => {
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
    if (seat.harness === "claude")
      for (const denied of [
        `Read(/${PASEO_HOME}/local-credential)`,
        `Read(/${ROOM_HOME}/jev/**)`,
        "Skill(skill:design)",
      ])
        assert.ok(provider.disallowedTools?.includes(denied), `${id} denies ${denied}`);
    if (seat.harness === "opencode")
      assert.deepEqual(
        provider.options?.permission,
        policy.opencode.config.permission,
        `${id} carries the policy's permissions`,
      );
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

test("the screen's choices become the table the room runs on: one model for a seat, several named ones for a Peer", async () => {
  const room = roomModels(PLUGIN_DIR) as unknown as Table;
  let choices = chooseSeat({}, "lead", { harness: "pi", model: "vendor/m-1", thinking: "low" });
  choices = chooseTier(choices, "peer", "cheap", { harness: "pi", model: "m-one", thinking: "" }); // a model of the room's table, changed
  choices = chooseTier(
    choices,
    "peer",
    "long",
    { harness: "opencode", model: "vendor/m-two", thinking: "" },
    "the long jobs",
  ); // one more
  choices = dropTier(choices, room, "peer", "cross-family"); // one of the room's own, taken out

  const { models, providers } = await plan({ models: choices });
  const table = models as unknown as Table;

  assert.deepEqual(seatChoice(table, "lead"), { harness: "pi", model: "vendor/m-1", thinking: "low" });
  assert.deepEqual(
    tierChoices(table, "peer").map((tier) => [tier.label, tier.harness, tier.model, tier.use]),
    [
      ["cheap", "pi", "m-one", tierUse(room, "peer", "cheap")],
      ["default", "claude", "claude-sonnet-5-5", tierUse(room, "peer", "default")],
      ["high", "codex", "gpt-6-astra", tierUse(room, "peer", "high")],
      ["extra", "claude", "claude-opus-5-5", tierUse(room, "peer", "extra")],
      ["long", "opencode", "vendor/m-two", "the long jobs"],
    ],
  );
  // choosing a model for a role is what sets its seat up
  for (const seat of ["pi-lead", "pi-peer", "opencode-peer"]) assert.ok(seat in providers, seat);
  // a model the choices added leaves them whole; one of the room's own stays out
  assert.deepEqual(dropTier(choices, room, "peer", "long").peer, {
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
    "long",
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
      ["high", "same"],
      ["extra", "same"],
      ["long", "added"],
      ["cross-family", "removed"],
    ],
  );
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

test("setting the room up again keeps what was changed in the room's policy and takes a new version's defaults everywhere else", async () => {
  await setUpRoom(source, { chime: true }, paseoAccepts);
  const file = join(ROOM_HOME, "policy.json");
  const changed = JSON.parse(readFileSync(file, "utf8"));
  changed.budget.projects["/work/app"] = { dailyUsd: 5 };
  changed.jev.keepDays = 30;
  delete changed.knowledge.mode;
  changed.owner.chime = false;
  writeFileSync(file, JSON.stringify(changed));

  // the next version ships other defaults
  const next = join(ROOM_HOME, "..", "plugin-next");
  for (const dir of ["paseo", "room"]) cpSync(join(PLUGIN_DIR, dir), join(next, dir), { recursive: true });
  const shipped = JSON.parse(readFileSync(join(next, "paseo", "policy.json"), "utf8"));
  shipped.jev.keepDays = 120;
  shipped.mail.dedupeSeconds = 7;
  writeFileSync(join(next, "paseo", "policy.json"), JSON.stringify(shipped));

  const { warnings } = await setUpRoom({ ...source, pluginDir: next }, { chime: true }, paseoAccepts);

  const policy = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(policy.budget.projects, { "/work/app": { dailyUsd: 5 } });
  assert.equal(policy.jev.keepDays, 30);
  assert.equal("mode" in policy.knowledge, false);
  assert.equal(policy.mail.dedupeSeconds, 7);
  // what the screen sets wins over the file
  assert.equal(policy.owner.chime, true);
  assert.equal(loadPolicy().jev?.keepDays, 30);
  assert.deepEqual(policyWarnings(warnings), []);
});

test("a change kept in the room's policy whose place a new version dropped is named and left out", async () => {
  await setUpRoom(source, {}, paseoAccepts);
  const file = join(ROOM_HOME, "policy.json");
  const changed = JSON.parse(readFileSync(file, "utf8"));
  changed.jev.providers.custom.url = "http://127.0.0.1:9";
  writeFileSync(file, JSON.stringify(changed));

  const next = join(ROOM_HOME, "..", "plugin-gone");
  for (const dir of ["paseo", "room"]) cpSync(join(PLUGIN_DIR, dir), join(next, dir), { recursive: true });
  const shipped = JSON.parse(readFileSync(join(next, "paseo", "policy.json"), "utf8"));
  delete shipped.jev.providers.custom;
  writeFileSync(join(next, "paseo", "policy.json"), JSON.stringify(shipped));

  const { warnings } = await setUpRoom({ ...source, pluginDir: next }, {}, paseoAccepts);

  assert.equal("custom" in JSON.parse(readFileSync(file, "utf8")).jev.providers, false);
  assert.deepEqual(policyWarnings(warnings), [
    "policy.json: jev.providers.custom.url was changed here, and this version has no jev.providers.custom; left out",
  ]);
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

test("two projects whose paths differ only in a separator keep their room files apart when the room is removed", () => {
  const base = mkdtempSync(join(tmpdir(), "seatwork-keep-"));
  try {
    const roots = [join(base, "work", "a-b"), join(base, "work", "a", "b")];
    roots.forEach((root, index) => {
      mkdirSync(join(root, ".seatwork"), { recursive: true });
      writeFileSync(join(root, ".seatwork", "mission.md"), `mission ${index}`);
    });
    const movedTo = join(base, "moved");
    for (const root of roots) assert.ok(takeRoomFiles(root, keptAt(movedTo, root)));
    assert.deepEqual(
      roots.map((root) => readFileSync(join(keptAt(movedTo, root), "mission.md"), "utf8")),
      ["mission 0", "mission 1"],
    );
    assert.ok(keptAt(movedTo, roots[1]).includes("work-a-b"), "the name still says where it came from");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
