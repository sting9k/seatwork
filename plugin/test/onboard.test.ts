import { deferred, installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { registerProject, unregisterProject } from "../server/orchestration/onboard";
import { loadRegistry } from "../server/orchestration/registry";

const ROOM_SEATS = ["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "codex-peer"];
const seatsFile = join(ROOM_HOME, "seats.json");
const marker = join(PROJECT, ".seatwork", "room.json");
let asked: string[][] = [];
/** Stands in for setting seats up: keeps the providers asked for, and leaves them in seats.json. */
const setUpSeats = async (providers: string[]) => {
  asked.push(providers);
  writeFileSync(seatsFile, JSON.stringify({ providers: [...ROOM_SEATS, ...providers] }));
};

const paseo = async () => [{ name: "demo", path: PROJECT }];

beforeEach(() => {
  installRoom(ROOM_SEATS);
  asked = [];
  rmSync(marker, { force: true });
});

test("a project's table may put a role on a harness the room has no seat for: the seat is set up, then the table is written", async () => {
  const models = { seats: { supervisor: { provider: "pi-supervisor/zai/glm-5" } } };

  const result = await registerProject(paseo, { path: PROJECT, models }, setUpSeats);

  assert.match(result, /registered: demo at /);
  assert.deepEqual(asked, [["pi-supervisor"]]);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")).models, models);
  assert.match(result, /Seats set up for this table: pi-supervisor\./);
  assert.match(result, /models: custom \| supervisor: pi-supervisor\/zai\/glm-5/);
});

test("a table the room refuses sets up no seat and is not written", async () => {
  await assert.rejects(
    registerProject(
      paseo,
      { path: PROJECT, models: { seats: { supervisor: { provider: "pi-peer/zai/glm-5" } } } },
      setUpSeats,
    ),
    /not a supervisor seat/,
  );

  assert.deepEqual(asked, []);
  assert.ok(!existsSync(marker));
});

test("registering writes the project's law beside its mission, and a project with both is ready", async () => {
  for (const file of ["mission.md", "demo-law.md"]) rmSync(join(PROJECT, ".seatwork", file), { force: true });
  const first = await registerProject(paseo, { path: PROJECT, mission: "Parse durations." }, setUpSeats);
  assert.match(first, /Still missing: law \(\.seatwork\/demo-law\.md: give `law`\)\./);
  const second = await registerProject(paseo, { path: PROJECT, law: "## Policy\n- Commits: one per task" }, setUpSeats);
  assert.equal(readFileSync(join(PROJECT, ".seatwork", "demo-law.md"), "utf8"), "## Policy\n- Commits: one per task\n");
  assert.match(second, /Mission and law are in place\./);
});

test("a project leaves the registry only when none of its seats is open, and keeps its files", async () => {
  await registerProject(paseo, { path: PROJECT, mission: "Parse durations." }, setUpSeats);
  const open = async () => [{ title: "[Supervisor] demo", cwd: PROJECT }];
  await assert.rejects(
    unregisterProject("demo", open),
    /1 seat of demo is still open \(\[Supervisor\] demo\); archive/,
  );
  await assert.rejects(
    unregisterProject("shop", async () => []),
    /shop is not a registered project/,
  );
  const result = await unregisterProject("demo", async () => [{ title: "[Lead] elsewhere", cwd: "/work/other" }]);
  assert.match(result, /^unregistered: demo at .*no project, so no project seat can start/);
  assert.deepEqual(loadRegistry()?.projects, []);
  assert.ok(existsSync(join(PROJECT, ".seatwork", "mission.md")));
});

/** An app that knows two projects, the test's and another, and a registry that holds neither. */
function twoProjects() {
  const other = join(PROJECT, "..", "other-project");
  mkdirSync(other, { recursive: true });
  rmSync(join(ROOM_HOME, "projects.json"), { force: true });
  const both = async () => [
    { name: "demo", path: PROJECT },
    { name: "other", path: other },
  ];
  return { other, both };
}

test("projects registered at the same moment all stay in the registry, however long one of them takes", async () => {
  const { other, both } = twoProjects();
  const release = deferred();
  const slow = async (providers: string[]) => {
    await release.promise;
    await setUpSeats(providers);
  };
  // the first has a table that needs a seat set up, which takes a while
  const models = { seats: { supervisor: { provider: "pi-supervisor/zai/glm-5" } } };
  const first = registerProject(both, { path: PROJECT, models }, slow);
  const second = registerProject(both, { path: other }, setUpSeats);
  await new Promise((done) => setTimeout(done, 50));
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(
    loadRegistry()
      ?.projects.map((entry) => entry.name)
      .sort(),
    ["demo", "other"],
  );
});

test("a project leaves the registry without taking one registered at the same moment with it", async () => {
  const { other, both } = twoProjects();
  await registerProject(both, { path: PROJECT }, setUpSeats);
  const release = deferred();
  const slowList = async () => {
    await release.promise;
    return [];
  };
  const leaving = unregisterProject("demo", slowList);
  const arriving = registerProject(both, { path: other }, setUpSeats);
  await new Promise((done) => setTimeout(done, 50));
  release.resolve();
  await Promise.all([leaving, arriving]);
  assert.deepEqual(
    loadRegistry()?.projects.map((entry) => entry.name),
    ["other"],
  );
});
