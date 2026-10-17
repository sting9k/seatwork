import { join } from "node:path";
import { evaluate, type Tools } from "../../server/safety/gate/evaluate";
import type { Place } from "../../server/safety/gate/types";
import { Guard } from "../../server/safety/guard";
import { SafetyStore } from "../../server/safety/store";
import { ROOM_HOME } from "./room";

/** The guard's fixture: a seat in a project of a home on a machine the tests describe, and what the guard keeps of what it runs. */

export const HOME = "/Users/u";
export const PROJECT = "/Users/u/proj";
export const PLACE: Place = {
  home: HOME,
  project: PROJECT,
  tmp: null,
  start: PROJECT,
  guard: null,
  roomFolder: ".seatwork",
};
export const SEAT = { id: "peer", role: "peer", project: PROJECT, tmp: null, start: PROJECT };

/** A machine where node_modules is ignored and nothing else is known: no alias, no file, no link; `over` tells more. */
export function machine(over: Partial<Tools> = {}): Tools {
  return {
    ignored: async (paths) => new Set(paths.filter((path) => /\/node_modules(\/|$)/.test(path))),
    alias: async () => null,
    external: async () => false,
    stat: () => ({ exists: false, link: false, dir: false }),
    real: () => null,
    changed: async () => null,
    ...over,
  };
}

/** What the guard keeps of a command run in `cwd`, as `effect:rule`, sorted, with `doubt` for each thing the gate could not read. */
export async function keptOf(
  command: string,
  tools: Tools,
  at: { cwd?: string | null; place?: Place } = {},
): Promise<string[]> {
  const cwd = at.cwd === undefined ? PROJECT : at.cwd;
  const found = await evaluate(command, cwd, at.place ?? PLACE, { budgetMs: 1000, maxBytes: 64 * 1024 }, tools);
  return [...found.findings.map((f) => `${f.effect}:${f.rule}`), ...found.doubts.map(() => "doubt")].sort();
}

/** A guard over `tools` at `place`, with a store of its own named in the room home. */
export function guardAt(name: string, tools: Tools, place: Place = PLACE): { guard: Guard; store: SafetyStore } {
  const store = new SafetyStore(join(ROOM_HOME, name), 1000);
  return {
    guard: new Guard({ store: () => store, policy: () => ({}), tools: () => tools, place: () => place }),
    store,
  };
}

/** The calls the guard kept in a safety store, oldest first, as `effect:rule`, of one seat when named. */
export function keptRules(store: SafetyStore, seat?: string): string[] {
  return store
    .kept("", 100_000, seat ?? null)
    .reverse()
    .map(({ pack, rule }) => `${pack}:${rule}`);
}
