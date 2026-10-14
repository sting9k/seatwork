import type { Judge, Older, Reading } from "./gate";
import type { KnowledgeStore } from "./store";

/** Pairs of decisions: a new one beside older ones, with the seat's word and the model's on each, to be measured. */

export interface PairDeps {
  judge: Judge | null;
  log(line: string): void;
}

export class PairBook {
  constructor(private readonly deps: PairDeps) {}

  /** Keeps a new decision beside older ones, with the gate's reading of them when it had one; never in a call's way. */
  keep(
    store: KnowledgeStore,
    item: { id: number; text: string },
    olds: readonly Older[],
    seat: string,
    reading: Reading | null = null,
  ): void {
    if (olds.length === 0) return;
    try {
      store.addPairs(item.id, item.text, seat, olds);
      if (reading?.same.length) {
        const pairOf = new Map(store.pairsOf(item.id).map((pair) => [pair.oldId, pair.id]));
        store.judged(
          reading.same.flatMap((one) => {
            const id = pairOf.get(one.id);
            return id === undefined ? [] : [{ ...one, id }];
          }),
        );
      }
      this.forward(store, item.id);
    } catch (error) {
      this.deps.log(`knowledge: the pairs of decision ${item.id} were not kept: ${(error as Error).message}`);
    }
  }

  /** Gives the model's log the seat's word on each pair it answered, once. */
  private forward(store: KnowledgeStore, newId: number): void {
    const judge = this.deps.judge;
    if (!judge) return;
    const given = store
      .unlabelled(newId)
      .filter((pair) => judge.label(pair.askId, `seat:${pair.seat}`, pair.seatChoice));
    if (given.length) store.labelled(given.map((pair) => pair.id));
  }
}
