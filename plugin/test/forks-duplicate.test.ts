import { ROOM_HOME, shipSql } from "./support/room";
import { forksWith, modelSaying } from "./forks-support";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ForkName } from "../server/orchestration/forks";
import { afterWork, type WorkForkDeps } from "../server/orchestration/work-forks";
import { WorkStore } from "../server/tasks/store";
import { work } from "../server/tasks/tools";

shipSql();

const RULES = {
  busyTimeoutMs: 5000,
  flushAfterMs: 60_000,
  staleClaimMinutes: 120,
  close: { minReasonChars: 20, forbidSelfClose: true },
};
let stores = 0;
const freshStore = () => new WorkStore(join(ROOM_HOME, `forks-duplicate-${(stores += 1)}`), RULES);

function roomOf(model: ReturnType<typeof modelSaying>, on: readonly ForkName[]) {
  const { forks, lines } = forksWith(model.router, on);
  const deps = { forks, log: (line: string) => lines.push(line), engine: {} } as unknown as WorkForkDeps;
  return { deps, lines };
}

/** A seat's create of one issue as the room's tool runs it. */
async function creates(deps: WorkForkDeps, store: WorkStore, args: Record<string, unknown>) {
  const asked = { do: "create", ...args };
  const done = work(store, RULES, { id: "lead", owner: true }, asked);
  return (await afterWork(deps, store, "lead", asked, done)) as Record<string, unknown>;
}

test("a new issue that repeats an open one is linked to it as related and its creator is told; neither is merged or closed", async () => {
  const store = freshStore();
  const old = store.create({ title: "Add paging to the orders list", description: "Twenty rows a page." }, "lead");
  store.create({ title: "Rename the billing module" }, "lead");
  const model = modelSaying((labels) => labels.find((label) => label !== "none") ?? null);
  const { deps } = roomOf(model, ["duplicate"]);

  const answer = await creates(deps, store, { title: "Paging for the orders list" });
  assert.equal(answer.duplicate_of, old.id);
  assert.match(String(answer.note), /is open and looks like the same work\. The two are linked as related/);
  assert.deepEqual(
    store.dependencies().map(({ issue_id, depends_on_id, type }) => [issue_id, depends_on_id, type]),
    [[answer.id, old.id, "related"]],
  );
  assert.deepEqual(
    [store.get(old.id).status, store.get(String(answer.id)).status],
    ["open", "open"],
    "nothing is closed or merged",
  );
  assert.deepEqual(
    store
      .ready()
      .map((issue) => issue.id)
      .sort(),
    store
      .all()
      .map((issue) => issue.id)
      .sort(),
  );

  const [call] = model.asked;
  assert.equal(call.caller, "forks.duplicate@2");
  assert.deepEqual(
    call.labels,
    ["none", old.id],
    "only the open issue that shares the new title's words is put to the model",
  );
  assert.deepEqual(call.state, {
    new: { [String(answer.id)]: { title: "Paging for the orders list", description: "(none)" } },
    open: { [old.id]: { title: "Add paging to the orders list", description: "Twenty rows a page." } },
  });
});

test("a new issue is compared with at most three open issues, found by the words of their titles; closed ones and its own are left out", async () => {
  const store = freshStore();
  const alike = ["one", "two", "three", "four"].map((n) =>
    store.create({ title: `Cache the orders list query ${n}` }, "lead"),
  );
  const done = store.create({ title: "Cache the orders list query done" }, "lead");
  store.closeIssue(done.id, "merged with the tests green at abc1234", "boss", RULES.close);
  store.create({ title: "Cache the orders" }, "lead");
  const model = modelSaying("none");
  const { deps } = roomOf(model, ["duplicate"]);
  const made = await creates(deps, store, { title: "Cache the orders list query" });
  const [call] = model.asked;
  assert.equal(call.labels.length, 4, "none and three issues");
  assert.ok(call.labels.slice(1).every((label) => alike.some((one) => one.id === label)));
  assert.ok(!call.labels.includes(done.id), "a closed issue is not a candidate");
  assert.ok(!call.labels.includes(String(made.id)), "the new issue is not compared with itself");
});

test("a store of hundreds of open issues is read by title in two bounded pages, and the model still sees three at most", async () => {
  const store = freshStore();
  for (let n = 0; n < 250; n += 1) store.create({ title: `Cache the orders list query ${n}` }, "lead");
  const model = modelSaying("none");
  const { deps } = roomOf(model, ["duplicate"]);
  const pages: (number | undefined)[] = [];
  const titles = store.titles.bind(store);
  store.titles = (status, limit) => {
    pages.push(limit);
    return titles(status, limit);
  };
  await creates(deps, store, { title: "Cache the orders list query" });
  assert.deepEqual(pages, [100, 100], "one page of open issues and one of those in progress, each bounded");
  assert.equal(model.asked[0].labels.length, 4);
});

test("an answer of none, a split answer, a fork that is off, and no issue like it all leave the issues as they are", async () => {
  for (const [name, model, on] of [
    ["none", modelSaying("none"), ["duplicate"]],
    ["split", modelSaying((labels) => labels[1], 0.6), ["duplicate"]],
    ["off", modelSaying((labels) => labels[1]), []],
  ] as const) {
    const store = freshStore();
    store.create({ title: "Add paging to the orders list" }, "lead");
    const answer = await creates(roomOf(model, on).deps, store, { title: "Paging for the orders list" });
    assert.equal(answer.duplicate_of, undefined, name);
    assert.deepEqual(store.dependencies(), [], name);
  }

  const store = freshStore();
  store.create({ title: "Add paging to the orders list" }, "lead");
  const model = modelSaying((labels) => labels[1]);
  const { deps } = roomOf(model, ["duplicate"]);
  await creates(deps, store, { title: "Wire the metrics exporter to the dashboard" });
  assert.equal(model.asked.length, 0, "no title in common: the model is not asked");
});

test("a plan made in one call is read in one call: each issue against the open ones, never against the plan's own", async () => {
  const store = freshStore();
  const paging = store.create({ title: "Add paging to the orders list" }, "lead");
  const cache = store.create({ title: "Cache the billing report query" }, "lead");
  const model = modelSaying((labels, state, id) => {
    const made = (state.new as Record<string, { title: string }>)[id].title;
    return made.includes("orders") ? paging.id : made.includes("billing") ? "none" : cache.id;
  });
  const { deps } = roomOf(model, ["duplicate"]);
  const asked = {
    do: "create",
    issues: [
      { title: "Paging for the orders list" },
      { title: "Cache for the billing report query" },
      { title: "Wire the metrics exporter" },
      { title: "Wire the metrics exporter to the dashboard" },
    ],
  };
  const plan = work(store, RULES, { id: "lead", owner: true }, asked) as { id: string }[];
  const answer = (await afterWork(deps, store, "lead", asked, plan)) as { id: string; duplicate_of?: string }[];
  assert.deepEqual(
    answer.map((one) => one.duplicate_of),
    [paging.id, undefined, undefined, undefined],
  );
  assert.equal(model.asked.length, 1, "the plan is one call");
  assert.deepEqual(Object.keys(model.asked[0].state.new as object), [plan[0].id, plan[1].id]);
  assert.deepEqual(model.asked[0].labels.sort(), ["none", cache.id, paging.id].sort());
  assert.deepEqual(
    store.dependencies().map(({ issue_id, depends_on_id, type }) => [issue_id, depends_on_id, type]),
    [[plan[0].id, paging.id, "related"]],
  );
});

test("a link that cannot be made leaves the issue made, and the answer is the create's own", async () => {
  const store = freshStore();
  store.create({ title: "Add paging to the orders list" }, "lead");
  const model = modelSaying((labels) => labels[1]);
  const { deps, lines } = roomOf(model, ["duplicate"]);
  const made = work(store, RULES, { id: "lead", owner: true }, { do: "create", title: "Paging for the orders list" });
  store.addDependency = () => {
    throw new Error("the store is locked");
  };
  const answer = await afterWork(deps, store, "lead", { do: "create", title: "x" }, made);
  assert.equal(answer, made, "the answer is the create's own");
  assert.match(lines.join("\n"), /fork duplicate: nothing was done for sw-\w+: the store is locked/);
});
