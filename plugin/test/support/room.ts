import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PaseoHost } from "../../server/paseo/host";

/** The throwaway homes test/isolate.cjs made for this process; a test run without it would reach the real ones. */
const base = process.env.SEATWORK_TEST_BASE;
if (!base) throw new Error("run the tests with npm test: test/isolate.cjs gives them homes of their own");

export const ROOM_HOME = join(base, "room-home");
export const USER_CODEX = join(base, "codex");
export const USER_PI = join(base, "pi");
export const PROJECT = join(base, "project");
export const USER_HOME = join(base, "home");

/** The plugin folder: the room files and the policy ship inside it. */
export const PLUGIN_DIR = join(__dirname, "..", "..");

/** Puts the stores' layout scripts where a store looks for them: they ship with the room files. */
export function shipSql(): void {
  cpSync(join(PLUGIN_DIR, "room", "sql"), join(ROOM_HOME, "room", "sql"), { recursive: true });
}

/** A room home as setting the room up leaves it: the room files, the policy and the enabled seats. */
export function installRoom(providers: string[]): void {
  cpSync(join(PLUGIN_DIR, "room"), join(ROOM_HOME, "room"), { recursive: true });
  const policy = JSON.parse(readFileSync(join(PLUGIN_DIR, "paseo", "policy.json"), "utf8"));
  policy.mail.port = 0; // any free port
  writeFileSync(join(ROOM_HOME, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(ROOM_HOME, "seats.json"), JSON.stringify({ providers, source: PLUGIN_DIR }));
  // set up by the plugin version under test: a room from another version is asked to apply again first
  writeFileSync(
    join(ROOM_HOME, "setup.json"),
    JSON.stringify({ version: JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version }),
  );
}

/** The room's Host over a stand-in Paseo client. */
export function hostOf(paseo: unknown): PaseoHost {
  const host = new PaseoHost();
  host.use(paseo as never);
  return host;
}

export const MAIL_POLICY = {
  port: 0,
  holdFyiWhileRunning: true,
  gatherReviews: true,
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
