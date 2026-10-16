import type { DatabaseSync } from "node:sqlite";
import type { SafetyStore } from "../../server/safety/store";

/** The calls the guard kept in a safety store, oldest first, as `pack:rule`, of one seat when named. */
export function keptRules(store: SafetyStore, seat?: string): string[] {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const rows = (
    seat === undefined
      ? db.prepare("SELECT pack, rule FROM decisions ORDER BY id").all()
      : db.prepare("SELECT pack, rule FROM decisions WHERE seat = ? ORDER BY id").all(seat)
  ) as { pack: string; rule: string }[];
  return rows.map(({ pack, rule }) => `${pack}:${rule}`);
}
