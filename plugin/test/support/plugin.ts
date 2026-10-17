import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock } from "node:test";
import contribute from "../../index.server";
import { installRoom, ROOM_HOME } from "./room";
import { roomSeats } from "./seats";
import { fakeServer } from "./server";

/** The plugin started on a stand-in Paseo, for a whole test file or for one test, with the console quiet while it runs. */

/** Changes the room home's policy file in place. */
export function editPolicy(change: (policy: Record<string, any>) => void): void {
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  change(policy);
  writeFileSync(file, JSON.stringify(policy));
}

/** What a file sets around the plugin's start: a change to the policy, mock timers (the minute's intervals, or the clock as well, from now), and its own steps before the start and after the stop. */
interface Around {
  policy?: (policy: Record<string, any>) => void;
  timers?: "minute" | "clock";
  before?: () => void;
  after?: () => void;
}

/** Starts the plugin before a file's tests on a room set up with `providers` (none set up for null) and stops it after them; the stand-in Paseo, the room's seats, and a restart and a stop for a test that needs them. */
export function pluginRoom(providers: string[] | null, around: Around = {}) {
  const paseo = fakeServer();
  const output = { log: console.log, error: console.error };
  let dispose = async () => {};
  before(() => {
    if (providers) installRoom(providers);
    if (around.policy) editPolicy(around.policy);
    around.before?.();
    console.log = console.error = () => {};
    if (around.timers === "minute") mock.timers.enable({ apis: ["setInterval"] });
    if (around.timers === "clock") mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
    dispose = contribute(paseo.server);
  });
  after(async () => {
    if (around.timers) mock.timers.reset();
    await dispose();
    around.after?.();
    Object.assign(console, output);
  });
  return {
    ...paseo,
    ...roomSeats(paseo.call),
    /** The plugin as Paseo starts it again: stopped, then contributed anew. */
    async restart(): Promise<void> {
      await dispose();
      dispose = contribute(paseo.server);
    },
    /** The plugin stopped for good: the file's end has nothing left to stop. */
    async stop(): Promise<void> {
      await dispose();
      dispose = async () => {};
    },
  };
}

/** Runs `work` with the plugin started on a stand-in Paseo, and stops it after, whatever happens. */
export async function withPlugin<T>(work: (paseo: ReturnType<typeof fakeServer>) => Promise<T>): Promise<T> {
  const paseo = fakeServer();
  const output = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  const dispose = contribute(paseo.server);
  try {
    return await work(paseo);
  } finally {
    await dispose();
    Object.assign(console, output);
  }
}
