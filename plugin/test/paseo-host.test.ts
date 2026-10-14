import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PaseoHost } from "../server/paseo/host";
import { PASEO_SCHEDULES } from "../server/paths";

test("with no client from Paseo yet, the room reads seats and writes to one at rest through the paseo CLI; a running seat waits", async () => {
  const bin = join(ROOM_HOME, "..", "paseo-host-cli");
  const said = join(ROOM_HOME, "..", "paseo-host-said");
  const inspect = (json: string) => `echo '${json}'`;
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'case "$1 $2 $3" in',
      `"agent inspect idle-1") ${inspect('{"Status":"idle","Archived":false,"PendingPermissions":[]}')} ;;`,
      `"agent inspect busy-1") ${inspect('{"Status":"running","Archived":false,"PendingPermissions":[]}')} ;;`,
      `"agent inspect asks-1") ${inspect('{"Status":"running","Archived":false,"PendingPermissions":[{}]}')} ;;`,
      `"agent inspect gone-1") ${inspect('{"Status":"idle","Archived":true,"PendingPermissions":[]}')} ;;`,
      `"agent inspect "*) echo '{"error":{"code":"AGENT_NOT_FOUND","message":"Agent not found"}}' >&2; exit 1 ;;`,
      `"send idle-1 --prompt-file") cp "$4" "${said}" ;;`,
      "*) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const before = process.env.SEATWORK_PASEO_BIN;
  process.env.SEATWORK_PASEO_BIN = bin;
  try {
    const host = new PaseoHost();
    assert.deepEqual(
      await Promise.all(["idle-1", "busy-1", "asks-1", "gone-1", "never-1"].map((id) => host.state(id))),
      ["idle", "running", "permission", "gone", "gone"],
    );
    await host.send("idle-1", "RESUME: continue", false);
    assert.equal(readFileSync(said, "utf8"), "RESUME: continue");
    await assert.rejects(host.send("busy-1", "FYI: later", false), /no Paseo client to steer a running seat/);
  } finally {
    if (before === undefined) delete process.env.SEATWORK_PASEO_BIN;
    else process.env.SEATWORK_PASEO_BIN = before;
  }
});

test("the room deletes the heartbeats of its gone seats and the finished ones of its live seats, never a schedule of the user's own", async () => {
  const bin = join(ROOM_HOME, "..", "paseo-host-schedules");
  const deleted = join(ROOM_HOME, "..", "paseo-host-deleted");
  writeFileSync(deleted, "");
  writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "schedule delete" ] && echo "$3" >> "${deleted}"\n`, { mode: 0o755 });
  mkdirSync(PASEO_SCHEDULES, { recursive: true });
  for (const [id, agentId, status] of [
    ["users-finished", "users-own", "completed"],
    ["live-finished", "seat-live", "completed"],
    ["live-running", "seat-live", "active"],
    ["gone-running", "seat-gone", "active"],
  ])
    writeFileSync(
      join(PASEO_SCHEDULES, `${id}.json`),
      JSON.stringify({ id, status, target: { type: "agent", agentId } }),
    );
  const before = process.env.SEATWORK_PASEO_BIN;
  process.env.SEATWORK_PASEO_BIN = bin;
  try {
    const states: Record<string, "gone" | "live"> = { "seat-live": "live", "seat-gone": "gone" };
    await new PaseoHost().dropWakers((agentId) => states[agentId] ?? null);
    assert.deepEqual(readFileSync(deleted, "utf8").trim().split("\n").sort(), ["gone-running", "live-finished"]);
  } finally {
    if (before === undefined) delete process.env.SEATWORK_PASEO_BIN;
    else process.env.SEATWORK_PASEO_BIN = before;
  }
});
