import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { registerProject } from "../server/onboard";

const ROOM_SEATS = ["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "claude-lens", "codex-peer", "codex-lens"];
const seatsFile = join(ROOM_HOME, "seats.json");
const installer = join(ROOM_HOME, "install.sh");
const ran = join(ROOM_HOME, "installer-ran");
const marker = join(PROJECT, ".slp", "room.json");

// Paseo knows one project, the test's
writeFileSync(process.env.SLP_PASEO_BIN!, `#!/bin/sh\n[ "$1 $2" = "project ls" ] || exit 1\necho '${JSON.stringify([{ projectId: "p1", name: "demo", path: PROJECT }])}'\n`);

beforeEach(() => {
  installRoom(ROOM_SEATS);
  writeFileSync(seatsFile, JSON.stringify({ providers: ROOM_SEATS, installer }));
  // install.sh, as far as the plugin sees it: called with flags, it leaves the seats it was asked for in seats.json
  writeFileSync(join(ROOM_HOME, "seats.after.json"), JSON.stringify({ providers: [...ROOM_SEATS, "pi-supervisor"], installer }));
  writeFileSync(installer, `#!/bin/sh\necho "$@" >> "${ran}"\ncp "${join(ROOM_HOME, "seats.after.json")}" "${seatsFile}"\n`);
  chmodSync(installer, 0o755);
  rmSync(ran, { force: true });
  rmSync(marker, { force: true });
});

test("a project's table may put a role on a harness the room has no seat for: the seat is set up, then the table is written", async () => {
  const models = { seats: { supervisor: { provider: "pi-supervisor/zai/glm-5" } } };

  const result = await registerProject({ path: PROJECT, models });

  assert.equal(readFileSync(ran, "utf8"), "--seats-only --seat pi-supervisor\n");
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")).models, models);
  assert.match(result, /Seats set up for this table: pi-supervisor\./);
  assert.match(result, /models: custom \| supervisor: pi-supervisor\/zai\/glm-5/);
});

test("a table the room refuses sets up no seat and is not written", async () => {
  // a Peer seat in the Supervisor's slot
  await assert.rejects(registerProject({ path: PROJECT, models: { seats: { supervisor: { provider: "pi-peer/zai/glm-5" } } } }), /not a supervisor seat/);

  assert.ok(!existsSync(ran), "install.sh ran for a table that was then refused");
  assert.ok(!existsSync(marker));
});
