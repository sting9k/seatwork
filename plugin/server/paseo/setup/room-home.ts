import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stamp } from "../../gc";
import { checkSetup, type RoomPlan, type Setup } from "./plan";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Writes a file of the room home for its owner only, even if it was there with wider rights. */
function writePrivate(file: string, text: string): void {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** setup.json of a room home, checked; {} when the room was never set up there. */
export function readSetup(roomHome: string): Setup {
  const file = join(roomHome, "setup.json");
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return checkSetup(parsed, file);
}

/** Moves a room home aside, whole, and returns where it went; it is kept for keepRemovedDays (shared/settings.json). */
export function moveRoomHomeAside(roomHome: string): string {
  const target = `${roomHome}.removed-${stamp()}`;
  renameSync(roomHome, target);
  return target;
}

/** Whether a room is set up in this home: the plugin stays asleep until it is. */
export function isSetUp(roomHome: string): boolean {
  return existsSync(join(roomHome, "policy.json")) && existsSync(join(roomHome, "seats.json"));
}

/** Marks a room home as set up by this plugin version, once Paseo has its seats. */
export function stampVersion(roomHome: string, version: string): void {
  writePrivate(join(roomHome, "setup.json"), json({ ...readSetup(roomHome), version }));
}

/** Writes the room home for a plan, keeping mail, logs and the registry; `seatsOnly` only adds seats. */
export function writeRoomHome(input: {
  plan: RoomPlan;
  pluginDir: string;
  roomHome: string;
  setup: Setup;
  seatsOnly?: boolean;
}): void {
  const { plan, pluginDir, roomHome, setup } = input;
  const { version } = readSetup(roomHome);
  // the room home holds mail and copies of the user's harness config: its owner only
  mkdirSync(roomHome, { recursive: true, mode: 0o700 });
  chmodSync(roomHome, 0o700);

  if (!input.seatsOnly) {
    // the room tree is replaced in one move, so a file dropped from the plugin is dropped here
    const room = join(roomHome, "room");
    const next = `${room}.next`;
    const previous = `${room}.previous`;
    for (const stale of [next, previous]) rmSync(stale, { recursive: true, force: true });
    cpSync(join(pluginDir, "room"), next, { recursive: true });
    writeFileSync(join(next, "models.json"), json(plan.models));
    if (existsSync(room)) renameSync(room, previous);
    renameSync(next, room);
    rmSync(previous, { recursive: true, force: true });
    if (plan.keepAside) copyFileSync(join(roomHome, "policy.json"), join(roomHome, plan.keepAside));
    writePrivate(join(roomHome, "policy.json"), json(plan.policy));
    writePrivate(join(roomHome, "policy.shipped.json"), json(plan.shipped));
  }
  writePrivate(
    join(roomHome, "seats.json"),
    json({ seats: plan.seats, providers: Object.keys(plan.providers).sort(), source: pluginDir }),
  );
  writePrivate(join(roomHome, "setup.json"), json({ ...setup, version }));

  // runtimes of seats no longer enabled go; Claude seats run on the user's ~/.claude and have none
  const runtimes = join(roomHome, "runtimes");
  if (existsSync(runtimes)) {
    for (const harness of readdirSync(runtimes, { withFileTypes: true })) {
      if (!harness.isDirectory()) continue;
      for (const role of readdirSync(join(runtimes, harness.name), { withFileTypes: true })) {
        const kept = harness.name !== "claude" && `${harness.name}-${role.name}` in plan.providers;
        if (role.isDirectory() && !kept)
          rmSync(join(runtimes, harness.name, role.name), { recursive: true, force: true });
      }
    }
  }
  if (!existsSync(join(roomHome, "projects.json"))) {
    writeFileSync(
      join(roomHome, "projects.json.example"),
      json({ projects: [{ name: "example", cwd: "/Users/you/code/example" }] }),
    );
  }
}
