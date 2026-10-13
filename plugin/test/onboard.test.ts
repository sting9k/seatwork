import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { registerProject, unregisterProject } from "../server/onboard";
import { loadRegistry } from "../server/registry";
import type { PaseoApi } from "../server/paseo";

const ROOM_SEATS = [
  "claude-hq",
  "claude-supervisor",
  "claude-lead",
  "claude-peer",
  "claude-lens",
  "codex-peer",
  "codex-lens",
];
const seatsFile = join(ROOM_HOME, "seats.json");
const marker = join(PROJECT, ".seatwork", "room.json");
/** The seats the room was asked to set up; setting one up leaves it in seats.json. */
let asked: string[][] = [];
const setUpSeats = async (providers: string[]) => {
  asked.push(providers);
  writeFileSync(seatsFile, JSON.stringify({ providers: [...ROOM_SEATS, ...providers] }));
};

// Paseo knows one project, the test's
const paseo = {
  projects: {
    list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "demo", projectRootPath: PROJECT }] }),
  },
} as unknown as PaseoApi;

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
  // a Peer seat in the Supervisor's slot
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
