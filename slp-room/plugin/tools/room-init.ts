/**
 * The installer's half that needs no app: this machine's choices, the room home, and the room's
 * seats and profiles in Paseo's config.json. install.sh runs it; the plugin's setup screen does the
 * same work through the SDK.
 *   node --require ./test/register.cjs tools/room-init.ts [--hq default|ask|<harness>/<model>] [--hq-thinking <id>]
 *        [--seat <harness>-<role>]... [--watcher off|shadow|on|ask] [--mail-port <port>] [--seats-only] [--no-daemon-policy]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PASEO_HOME, ROOM_HOME, WATCH_DIR } from "../server/paths";
import { cliCatalog } from "../server/setup/catalog";
import { piProblem } from "../server/setup/checks";
import { choose, type ChoiceFlags, type Terminal } from "../server/setup/choices";
import { setUpRoom } from "../server/setup/init";
import { applyToConfigFile } from "../server/setup/paseo-config";
import { checkSetup, roomModels } from "../server/setup/plan";
import { readSetup } from "../server/setup/room-home";

const PLUGIN_DIR = join(__dirname, "..");
const VERSION = (JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")) as { version: string }).version;

function parse(argv: string[]): { flags: ChoiceFlags; mailPort?: number; seatsOnly: boolean; daemonPolicy: boolean } {
  const flags: ChoiceFlags = { seats: [] };
  let mailPort: number | undefined;
  let seatsOnly = false;
  let daemonPolicy = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[(i += 1)];
    };
    if (arg === "--hq") flags.hq = value();
    else if (arg === "--hq-thinking") flags.hqThinking = value();
    else if (arg === "--seat") flags.seats.push(value());
    else if (arg === "--watcher") flags.watcher = value();
    else if (arg === "--mail-port") mailPort = Number(value());
    else if (arg === "--seats-only") seatsOnly = true;
    else if (arg === "--no-daemon-policy") daemonPolicy = false;
    else throw new Error(`unknown option: ${arg}`);
  }
  return { flags, mailPort, seatsOnly, daemonPolicy };
}

/** Lines typed at the installer, one per question; null once the input has ended. */
function terminal(): Terminal & { close(): void } {
  const lines = createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  lines.on("line", (line) => (waiting.length ? waiting.shift()!(line) : queue.push(line)));
  lines.on("close", () => {
    ended = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  });
  return {
    isTTY: Boolean(process.stdin.isTTY),
    ask(prompt) {
      process.stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      return ended ? Promise.resolve(null) : new Promise((resolve) => waiting.push(resolve));
    },
    say: (line) => console.log(line),
    close: () => lines.close(),
  };
}

async function main(): Promise<void> {
  const { flags, mailPort, seatsOnly, daemonPolicy } = parse(process.argv.slice(2));
  const io = terminal();
  const base = roomModels(PLUGIN_DIR);
  let setup;
  try {
    setup = await choose(readSetup(ROOM_HOME), flags, io, { catalog: cliCatalog, hq: base.seats.hq, watchKeyFile: join(WATCH_DIR, "key") });
  } finally {
    io.close();
  }
  if (mailPort !== undefined) setup = checkSetup({ ...setup, mailPort }, "--mail-port");
  const plan = await setUpRoom({ pluginDir: PLUGIN_DIR, roomHome: ROOM_HOME, catalog: cliCatalog, version: VERSION }, setup, { seatsOnly });
  for (const warning of plan.warnings) console.error(`warning: ${warning}`);
  applyToConfigFile(PASEO_HOME, plan, { daemonPolicy });

  const hq = plan.models.seats.hq;
  console.log(`HQ seat: ${hq.provider}, thinking ${hq.thinking}; seats added on this machine: ${(setup.seats ?? []).join(", ") || "none"}; watcher: ${setup.watcher ?? "off"} (${join(ROOM_HOME, "setup.json")})`);
  console.log(`Room files: ${join(ROOM_HOME, "room")}  policy: ${join(ROOM_HOME, "policy.json")}  seats: ${Object.keys(plan.providers).join(", ")}`);
  console.log(`Paseo config updated: ${join(PASEO_HOME, "config.json")} (backup alongside)`);
  console.log(`  profiles:  ${plan.profiles.map((profile) => profile.name).join(", ")}`);
  if (!existsSync(join(ROOM_HOME, "projects.json"))) {
    console.log(`No ${join(ROOM_HOME, "projects.json")}: the room runs in OPEN mode (no project guard).`);
    console.log("  Ask HQ to onboard a project (or copy projects.json.example to projects.json) to switch on the registry.");
  }
  if ((setup.watcher ?? "off") !== "off" && !process.env.SLP_WATCH_KEY && !existsSync(join(WATCH_DIR, "key"))) {
    console.log(`Watcher: no key in ${join(WATCH_DIR, "key")} (or SLP_WATCH_KEY): the rules that read tool calls work, the four that ask a model only log their facts.`);
  }
  if (Object.keys(plan.providers).some((id) => id.startsWith("pi-"))) {
    const problem = await piProblem();
    if (problem) console.error(`WARNING: ${problem}.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
