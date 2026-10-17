import { rmSync } from "node:fs";
import { join } from "node:path";
import councilCatalog from "../../shared/safety/council.json";
import type { Decider } from "../../server/safety/council/council";
import { SafetyStore, type ReadingRow } from "../../server/safety/store";
import { ROOM_HOME } from "./room";

/** The council's tests: a safety store of their own, the decision district standing in, and a member's level earned from labels. */

/** A safety store in a fresh folder of the room home, on `now` when given. */
export function storeIn(name: string, now?: () => Date): SafetyStore {
  const dir = join(ROOM_HOME, name);
  rmSync(dir, { recursive: true, force: true });
  return new SafetyStore(dir, 2000, now);
}

/** The decision district as the council asks it: `score` answers each question, a question about a state asked before is answered from memory when `remember`, and what was asked and how it was phrased is kept. */
export function standIn(score: (state: Record<string, unknown>) => number, remember = false) {
  const asked: Record<string, unknown>[] = [];
  const phrased: string[] = [];
  const memory = new Map<string, Awaited<ReturnType<Decider["decide"]>>>();
  const decider: Decider = {
    why: () => null,
    decide: async (_caller, state, questions) => {
      const key = JSON.stringify([state, questions]);
      const kept = remember ? memory.get(key) : undefined;
      if (kept) return kept;
      asked.push(state);
      const id = Object.keys(questions)[0];
      phrased.push(String((questions[id] as { instructions: unknown }).instructions));
      const decided = { answers: { [id]: { type: "noul", noul: score(state) } }, asks: { [id]: asked.length } };
      if (remember) memory.set(key, decided);
      return decided;
    },
  };
  return { decider, asked, phrased };
}

/** A found reading of `member` as the council keeps one: a fact of turn `n` of `seat`, on one of eight tasks. */
export function found(member: keyof typeof councilCatalog.members, seat = "s", n = 0): ReadingRow {
  return {
    member,
    version: councilCatalog.members[member].version,
    seat,
    role: "peer",
    task: `task-${n % 8}`,
    turn: `t${n}`,
    tier: "fact",
    zone: "found",
    score: null,
    askId: null,
    level: 0,
    shown: false,
    fingerprint: `f${n}`,
    evidence: null,
  };
}

/** Sixty right findings of `member` over eight tasks, each read into `store` for the seat `seatOf` names and labelled by `label`: the labels that earn level 3. */
export async function earnLevel3(
  store: SafetyStore,
  member: keyof typeof councilCatalog.members,
  label: (reading: number) => unknown,
  seatOf: (i: number) => string = (i) => `s${i % 8}`,
  labels = 60,
): Promise<void> {
  for (let i = 0; i < labels; i += 1) await label(store.read(found(member, seatOf(i), i)));
}
