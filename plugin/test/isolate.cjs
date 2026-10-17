// Gives each test process throwaway homes before any module loads: server/paths.ts reads them as it loads.
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const base = mkdtempSync(join(tmpdir(), "seatwork-test-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));
for (const dir of ["room-home", "codex", "pi", "project", "home"]) mkdirSync(join(base, dir));
// a paseo CLI that moves a label and fails at anything else
const cli = join(base, "paseo");
writeFileSync(cli, '#!/bin/sh\n[ "$1 $2" = "agent update" ] && exit 0\nexit 1\n');
chmodSync(cli, 0o755);

Object.assign(process.env, {
  SEATWORK_TEST_BASE: base,
  HOME: join(base, "home"),
  SEATWORK_ROOM_HOME: join(base, "room-home"),
  SEATWORK_PASEO_BIN: cli,
  PASEO_HOME: join(base, "paseo-home"),
  CODEX_HOME: join(base, "codex"),
  CLAUDE_CONFIG_DIR: join(base, "claude"),
  PI_CODING_AGENT_DIR: join(base, "pi"),
  OPENCODE_CONFIG_DIR: join(base, "opencode"),
});
