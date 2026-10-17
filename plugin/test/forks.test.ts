import { forksWith, modelSaying } from "./forks-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Forks, type Router } from "../server/orchestration/forks";

const ON = ["report", "answers", "overlap"] as const;

test("a fork is acted on only when the model is sure; a split answer, a fork the policy keeps off, or no model keep the room's rule", async () => {
  const sure = modelSaying("nothing_new");
  const { forks, lines } = forksWith(sure.router, ON);
  assert.equal(await forks.take("report", { report: "Noted, carrying on." }), "nothing_new");
  assert.deepEqual(lines, ["fork report: nothing_new (0.95)"]);
  assert.equal(sure.asked[0].caller, "forks.report@1");
  assert.equal(await forksWith(modelSaying("nothing_new", 0.7).router, ON).forks.take("report", {}), null, "split");
  assert.equal(await forksWith(sure.router, []).forks.take("report", {}), null, "off in the policy");
  assert.equal(await forksWith(modelSaying("nothing_new", 0.99, "no key").router, ON).forks.take("report", {}), null);
  assert.equal(await forksWith(null, ON).forks.take("report", {}), null);
  assert.equal(sure.asked.length, 1, "a fork the policy keeps off is never asked");
});

test("a fork the room needs is asked whatever the policy lists; an optional one the policy leaves out is not", async () => {
  const { router, asked } = modelSaying("m7", 0.97);
  const { forks } = forksWith(router, []);
  assert.equal(await forks.take("answers", { reply: {} }, { m7: "it answers asks.m7", none: "none" }), "m7");
  assert.equal(await forks.take("report", { report: "Noted." }), null);
  assert.equal(asked.length, 1);
});

test("a fork's labels may be the call's own, and many questions of one fork go in one call", async () => {
  const { router, asked } = modelSaying("m7", 0.97);
  const { forks } = forksWith(router, ON);
  assert.equal(await forks.take("answers", { reply: {} }, { m7: "it answers asks.m7", none: "none" }), "m7");
  assert.deepEqual(asked[0].labels, ["m7", "none"]);
  const pairs = modelSaying("true", 0.93);
  const { forks: overlap } = forksWith(pairs.router, ON);
  assert.deepEqual(await overlap.takeMany("overlap", { pairs: {} }, ["p1", "p2"]), ["true", "true"]);
  assert.deepEqual(pairs.asked[0].ids, ["p1", "p2"]);
  assert.deepEqual(await overlap.takeMany("overlap", {}, []), []);
  assert.equal(pairs.asked.length, 1, "no question, no call");
});

test("a decision model that throws keeps the room's rule and is logged, whatever it threw", async () => {
  const lines: string[] = [];
  const router: Router = {
    why: () => null,
    routes: async () => {
      throw new Error("database is locked");
    },
  };
  const forks = new Forks({ router, on: () => true, log: (line) => lines.push(line) });
  assert.equal(await forks.take("report", {}), null);
  assert.deepEqual(await forks.takeMany("overlap", {}, ["p1", "p2"]), [null, null]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /fork report: .*database is locked/);
});
