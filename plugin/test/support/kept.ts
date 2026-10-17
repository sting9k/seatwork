import type { SafetyStore } from "../../server/safety/store";

/** The calls the guard kept in a safety store, oldest first, as `effect:rule`, of one seat when named. */
export function keptRules(store: SafetyStore, seat?: string): string[] {
  return store
    .kept("", 100_000, seat ?? null)
    .reverse()
    .map(({ pack, rule }) => `${pack}:${rule}`);
}
