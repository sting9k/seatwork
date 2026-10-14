import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PaseoHost } from "../server/paseo/host";

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
