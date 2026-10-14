import assert from "node:assert/strict";
import { test } from "node:test";
import { Forks, type Fork, type ForkName, type Router } from "../server/orchestration/forks";

/** A model that answers every question of a call with `label` at `probability`, keeping what it was asked. */
function routerOf(label: string, probability: number, why: string | null = null) {
  const asked: { caller: string; state: Record<string, unknown>; ids: string[]; labels: string[] }[] = [];
  const router: Router = {
    why: () => why,
    routes: async (caller, state, questions, sharpAt) => {
      const ids = Object.keys(questions);
      asked.push({
        caller,
        state,
        ids,
        labels: Object.keys((questions[ids[0]] as unknown as { criteria?: object }).criteria ?? {}),
      });
      return Object.fromEntries(
        ids.map((id): [string, Fork] => [
          id,
          { label, probability, sharp: probability >= sharpAt, askId: 1, why: null },
        ]),
      );
    },
  };
  return { router, asked };
}

const forksOf = (router: Router | null, on: readonly ForkName[] = ["report", "answers", "overlap"]) => {
  const lines: string[] = [];
  return { forks: new Forks({ router, on: (name) => on.includes(name), log: (line) => lines.push(line) }), lines };
};

test("a fork is acted on only when the model is sure; a split answer, a fork the policy keeps off, or no model keep the room's rule", async () => {
  const sure = routerOf("nothing_new", 0.95);
  const { forks, lines } = forksOf(sure.router);
  assert.equal(await forks.take("report", { report: "Noted, carrying on." }), "nothing_new");
  assert.deepEqual(lines, ["fork report: nothing_new (0.95)"]);
  assert.equal(sure.asked[0].caller, "forks.report@1");
  assert.equal(await forksOf(routerOf("nothing_new", 0.7).router).forks.take("report", {}), null, "split");
  assert.equal(await forksOf(sure.router, []).forks.take("report", {}), null, "off in the policy");
  assert.equal(await forksOf(routerOf("nothing_new", 0.99, "no key").router).forks.take("report", {}), null);
  assert.equal(await forksOf(null).forks.take("report", {}), null);
  assert.equal(sure.asked.length, 1, "a fork the policy keeps off is never asked");
});

test("a fork's labels may be the call's own, and many questions of one fork go in one call", async () => {
  const { router, asked } = routerOf("m7", 0.97);
  const { forks } = forksOf(router);
  assert.equal(await forks.take("answers", { reply: {} }, { m7: "it answers asks.m7", none: "none" }), "m7");
  assert.deepEqual(asked[0].labels, ["m7", "none"]);
  const pairs = routerOf("true", 0.93);
  assert.deepEqual(await forksOf(pairs.router).forks.takeMany("overlap", { pairs: {} }, ["p1", "p2"]), [
    "true",
    "true",
  ]);
  assert.deepEqual(pairs.asked[0].ids, ["p1", "p2"]);
  assert.deepEqual(await forksOf(pairs.router).forks.takeMany("overlap", {}, []), []);
  assert.equal(pairs.asked.length, 1, "no question, no call");
});
