import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway room home and throwaway harness homes. Import this first: server/paths.ts reads
 * the environment when it loads, and no test may touch the real ~/.config/slp-room or ~/.codex.
 */
const base = mkdtempSync(join(tmpdir(), "slp-test-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

export const ROOM_HOME = join(base, "room-home");
export const USER_CODEX = join(base, "codex");
export const PROJECT = join(base, "project");

for (const dir of [ROOM_HOME, USER_CODEX, PROJECT]) mkdirSync(dir);
// a paseo CLI that always fails: the plugin shells out for projects, labels and schedules
const cli = join(base, "paseo");
writeFileSync(cli, "#!/bin/sh\nexit 1\n");
chmodSync(cli, 0o755);

Object.assign(process.env, {
  SLP_ROOM_HOME: ROOM_HOME,
  SLP_PASEO_BIN: cli,
  PASEO_HOME: join(base, "paseo-home"),
  CODEX_HOME: USER_CODEX,
  CLAUDE_CONFIG_DIR: join(base, "claude"),
  PI_CODING_AGENT_DIR: join(base, "pi"),
  OPENCODE_CONFIG_DIR: join(base, "opencode"),
});

const REPO_ROOM = join(__dirname, "..", "..", "..");

/** What install.sh leaves in the room home: the room files, the policy and the enabled seats. */
export function installRoom(providers: string[]): void {
  cpSync(join(REPO_ROOM, "room"), join(ROOM_HOME, "room"), { recursive: true });
  const policy = JSON.parse(readFileSync(join(REPO_ROOM, "paseo", "policy.json"), "utf8"));
  policy.mail.port = 0; // any free port
  writeFileSync(join(ROOM_HOME, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(ROOM_HOME, "seats.json"), JSON.stringify({ providers }));
}

export const MAIL_POLICY = {
  port: 0,
  maxBodyChars: 4000,
  holdFyiWhileRunning: true,
  midTurn: { claude: "hold", codex: "hold", pi: "hold", opencode: "hold" },
} as const;

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
