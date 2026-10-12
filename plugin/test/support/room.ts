import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway room home and harness homes; import this first: server/paths.ts reads the environment as it loads. */
const base = mkdtempSync(join(tmpdir(), "seatwork-test-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

export const ROOM_HOME = join(base, "room-home");
export const USER_CODEX = join(base, "codex");
export const USER_PI = join(base, "pi");
export const PROJECT = join(base, "project");

for (const dir of [ROOM_HOME, USER_CODEX, USER_PI, PROJECT]) mkdirSync(dir);
// a paseo CLI that always fails: the plugin shells out for projects, labels and schedules
const cli = join(base, "paseo");
writeFileSync(cli, "#!/bin/sh\nexit 1\n");
chmodSync(cli, 0o755);

Object.assign(process.env, {
  SEATWORK_ROOM_HOME: ROOM_HOME,
  SEATWORK_PASEO_BIN: cli,
  PASEO_HOME: join(base, "paseo-home"),
  CODEX_HOME: USER_CODEX,
  CLAUDE_CONFIG_DIR: join(base, "claude"),
  PI_CODING_AGENT_DIR: USER_PI,
  OPENCODE_CONFIG_DIR: join(base, "opencode"),
});

/** The plugin folder: the room files and the policy ship inside it. */
export const PLUGIN_DIR = join(__dirname, "..", "..");

/** A room home as setting the room up leaves it: the room files, the policy and the enabled seats. */
export function installRoom(providers: string[], adjust: (policy: { watcher: { mode: string } }) => void = () => {}): void {
  cpSync(join(PLUGIN_DIR, "room"), join(ROOM_HOME, "room"), { recursive: true });
  const policy = JSON.parse(readFileSync(join(PLUGIN_DIR, "paseo", "policy.json"), "utf8"));
  policy.mail.port = 0; // any free port
  adjust(policy);
  writeFileSync(join(ROOM_HOME, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(ROOM_HOME, "seats.json"), JSON.stringify({ providers }));
  // set up by the plugin version under test: a room from another version is asked to apply again first
  writeFileSync(join(ROOM_HOME, "setup.json"), JSON.stringify({ version: JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version }));
}

export const MAIL_POLICY = {
  port: 0,
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
