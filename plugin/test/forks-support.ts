import { Forks, type Fork, type ForkName, type Router } from "../server/orchestration/forks";
import { join } from "node:path";
import { WorkStore } from "../server/tasks/store";
import { ROOM_HOME } from "./support/room";

/** One call the stand-in decision model was put: the caller, the state, the question ids and the labels of the first question. */
export interface Asked {
  caller: string;
  state: Record<string, unknown>;
  ids: string[];
  labels: string[];
}

/** A decision model that answers each question with `pick` at `probability` as Jev would (a label outside the question's is no answer) and keeps what it was asked; `held` is why it cannot answer. */
export function modelSaying(
  pick: string | null | ((labels: string[], state: Record<string, unknown>, id: string) => string | null),
  probability = 0.95,
  held: string | null = null,
) {
  const asked: Asked[] = [];
  const router: Router = {
    why: () => held,
    routes: async (caller, state, questions, sharpAt) => {
      const ids = Object.keys(questions);
      const first = questions[ids[0]] as unknown as { criteria?: Record<string, unknown> };
      const labels = Object.keys(first.criteria ?? {});
      asked.push({ caller, state, ids, labels });
      return Object.fromEntries(
        ids.map((id): [string, Fork] => {
          const said = typeof pick === "function" ? pick(labels, state, id) : pick;
          const label = said !== null && labels.includes(said) ? said : null;
          return [
            id,
            { label, probability, sharp: label !== null && probability >= sharpAt, askId: asked.length, why: null },
          ];
        }),
      );
    },
  };
  return { router, asked };
}

/** The room's forks over a decision model, with the forks that are on and the lines they log. */
export function forksWith(router: Router | null, on: readonly ForkName[]) {
  const lines: string[] = [];
  return { forks: new Forks({ router, on: (name) => on.includes(name), log: (line) => lines.push(line) }), lines };
}

/** The work rules the fork tests run the store and its tool on. */
export const RULES = {
  busyTimeoutMs: 5000,
  staleClaimMinutes: 120,
  close: { minReasonChars: 20, forbidSelfClose: true },
};

/** A fresh work store under the test's room home, named `<prefix>-<n>`. */
let stores = 0;
export function freshStore(prefix: string): WorkStore {
  return new WorkStore(join(ROOM_HOME, `${prefix}-${(stores += 1)}`), RULES);
}
