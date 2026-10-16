import knowledge from "../../shared/knowledge.json";
import type { KnowledgeStore, PairChoice } from "./store";

/** The keep gate: the decision model reads a decision before it is kept, and turns away noise and repeats. */

/** The decision model, from the Jev district: `why` says why it cannot be asked, `decide` asks, `label` adds a later word. */
export interface Judge {
  why(): string | null;
  decide(
    caller: string,
    state: Record<string, unknown>,
    questions: Record<string, unknown>,
    options?: { deadlineMs?: number },
  ): Promise<{
    answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }>;
    asks: Record<string, number>;
  }>;
  label(askId: number, source: string, value: string, note?: string): boolean;
}

/** One older decision beside a new one, with the seat's word on the pair when its act gave one. */
export interface Older {
  id: number;
  text: string;
  choice: PairChoice | null;
}

/** The model's reading of a new decision: how sure it is worth keeping, and how it stands to each older one. */
export interface Reading {
  label: string;
  keep: number;
  same: { id: number; choice: PairChoice; probabilities: Record<string, number>; askId: number }[];
}

/** What the gate made of a new decision: kept, with the reading when there was one, or turned away. */
export type Verdict =
  | { kept: true; reading: Reading | null }
  | { kept: false; noise: { label: string; meaning: string } }
  | { kept: false; repeats: number[] };

/** What the gate takes: the decision model, whether the district's gate is on, and a log. */
export interface GateDeps {
  judge: Judge | null;
  on(): boolean;
  at(): number | undefined;
  log(line: string): void;
}

export const GATE = knowledge.gate;
const CALLER = `knowledge.gate@${GATE.version}`;
const CHOICES = Object.keys(GATE.same.criteria) as PairChoice[];
const REPEATS: readonly PairChoice[] = ["duplicate", "replaces"];

/** The keep gate itself: one reading of a new decision beside older ones. */
export class Gate {
  constructor(private readonly deps: GateDeps) {}

  /** Reads a new decision beside older ones; a repeat is a duplicate or replacement the seat said nothing of. With no reading, it is kept. */
  async check(
    store: KnowledgeStore,
    item: { text: string; facts: Record<string, string> },
    olds: readonly Older[],
  ): Promise<Verdict> {
    const judge = this.deps.judge;
    if (!judge || !this.deps.on() || judge.why() !== null) return { kept: true, reading: null };
    const reading = await this.read(judge, item, olds);
    if (!reading) {
      store.tally("gate-unread");
      return { kept: true, reading: null };
    }
    // a threshold the policy sets holds when it is one: from a half up to certainty
    const set = this.deps.at();
    const at = typeof set === "number" && set >= 0.5 && set <= 1 ? set : GATE.at;
    if (reading.keep < at) {
      store.tally("gate-noise");
      const criteria: Record<string, string> = GATE.question.criteria;
      return { kept: false, noise: { label: reading.label, meaning: criteria[reading.label] ?? "" } };
    }
    const unsaid = new Set(olds.filter((old) => old.choice === null).map((old) => old.id));
    const repeats = reading.same
      .filter((one) => unsaid.has(one.id) && REPEATS.includes(one.choice) && one.probabilities[one.choice] >= at)
      .map((one) => one.id);
    store.tally(`gate-${repeats.length ? "repeat" : "kept"}`);
    return repeats.length ? { kept: false, repeats } : { kept: true, reading };
  }

  /** One call: what the decision is, and the decision against each older one; null when the model gave no answer. */
  private async read(
    judge: Judge,
    item: { text: string; facts: Record<string, string> },
    olds: readonly Older[],
  ): Promise<Reading | null> {
    const idOf = (id: number) => `d${id}`;
    try {
      const decided = await judge.decide(
        CALLER,
        {
          ...item.facts,
          new: item.text,
          ...(olds.length ? { old: Object.fromEntries(olds.map((old) => [idOf(old.id), old.text])) } : {}),
        },
        {
          keep: GATE.question,
          ...Object.fromEntries(
            olds.map((old) => [
              idOf(old.id),
              { ...GATE.same, instructions: GATE.same.instructions.replaceAll("{{id}}", idOf(old.id)) },
            ]),
          ),
        },
        { deadlineMs: GATE.deadlineMs },
      );
      const keep = decided.answers.keep;
      if (typeof keep?.choice !== "string") return null;
      return {
        label: keep.choice,
        keep: keep.probabilities?.[GATE.keep] ?? 0,
        same: olds.flatMap((old) => {
          const answer = decided.answers[idOf(old.id)];
          const askId = decided.asks[idOf(old.id)];
          const choice = answer?.choice as PairChoice | undefined;
          return choice && CHOICES.includes(choice) && askId !== undefined
            ? [{ id: old.id, choice, probabilities: answer.probabilities ?? {}, askId }]
            : [];
        }),
      };
    } catch (error) {
      this.deps.log(`knowledge: the gate did not read a decision: ${(error as Error).message}`);
      return null;
    }
  }
}
