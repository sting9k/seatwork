import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { alerts, blockerChain, next, plan, triage } from "../server/tasks/graph";
import { WorkStore } from "../server/tasks/store";

shipSql();

let stores = 0;
const NOW = new Date("2026-10-14T12:00:00Z");
const TIMING = { busyTimeoutMs: 5000, flushAfterMs: 60_000 };
/** schema → api → ui, schema → report; docs and lint stand apart and touch the same file. */
function sample() {
  let tick = Date.parse("2026-10-14T09:00:00Z");
  const store = new WorkStore(join(ROOM_HOME, `graph-test-${(stores += 1)}`), TIMING, () => new Date((tick += 1000)));
  const make = (title: string, extra: object = {}) => store.create({ title, ...extra }, "lead").id;
  const schema = make("schema", { write_scope: "src/schema.js" });
  const api = make("api", { deps: [{ id: schema }], write_scope: "src/api/**" });
  const ui = make("ui", { deps: [{ id: api }] });
  const report = make("report", { deps: [{ id: schema }] });
  const docs = make("docs", { priority: 3, write_scope: "README.md, docs/" });
  const lint = make("lint", { priority: 3, write_scope: "docs/style.md" });
  return { store, schema, api, ui, report, docs, lint, work: () => store.openWork() };
}

test("triage puts first the ready issue that most work rests on, and says why; a pick is the first one nobody holds", () => {
  const s = sample();
  const first = triage(s.work(), NOW);
  assert.deepEqual(first.counts, { open: 6, ready: 3, blocked: 3, in_progress: 0 });
  assert.equal(first.recommendations[0].id, s.schema);
  assert.deepEqual(first.recommendations.map((one) => one.id).sort(), [s.schema, s.docs, s.lint].sort());
  assert.deepEqual(first.recommendations[0].unblocks.sort(), [s.api, s.report].sort());
  assert.equal(first.recommendations[0].reasons[0], "nothing is in its way");
  assert.match(first.recommendations[0].reasons[1], /^closing it frees 2: sw-\w+, sw-\w+$/);
  assert.deepEqual(
    first.blockers_to_clear.map((one) => [one.id, one.holds_up]),
    [
      [s.schema, 2],
      [s.api, 1],
    ],
  );
  assert.equal(next(s.work(), NOW)?.id, s.schema);

  s.store.claim(s.schema, "peer-a");
  // in progress it is still worth clearing, and no longer on offer
  assert.equal(triage(s.work(), NOW).recommendations[0].id, s.schema);
  assert.ok([s.docs, s.lint].includes(next(s.work(), NOW)!.id));
  s.store.closeIssue(s.schema, "done in 4f2a91c, npm test 88/88", "lead", {
    minReasonChars: 20,
    forbidSelfClose: true,
  });
  assert.equal(next(s.work(), NOW)?.id, s.api);
});

test("a plan groups what no dependency joins, lists what is ready in each group, and names ready issues whose files collide", () => {
  const s = sample();
  const made = plan(s.work(), NOW);
  // the track with the highest priority comes first; the rest by id
  assert.deepEqual(
    made.tracks.map((track) => track.items.map((item) => item.id)),
    [[s.schema], ...[[s.docs], [s.lint]].sort((a, b) => a[0].localeCompare(b[0]))],
  );
  assert.deepEqual([made.ready, made.blocked], [3, 3]);
  assert.deepEqual(
    made.overlaps.map((one) => [[one.a, one.b].sort(), one.paths]),
    [[[s.docs, s.lint].sort(), ["docs"]]],
  );
});

test("a blocker chain goes down level by level to what nothing blocks; alerts name a claim left alone and one issue holding many", () => {
  const s = sample();
  assert.deepEqual(
    blockerChain(s.work(), s.ui).map((level) => level.map((one) => one.title)),
    [["api"], ["schema"]],
  );
  assert.deepEqual(blockerChain(s.work(), s.schema), []);
  s.store.claim(s.schema, "peer-a");
  const extra = s.store.create({ title: "export", deps: [{ id: s.schema }] }, "lead").id;
  const found = alerts(s.work(), new Date("2026-10-14T12:00:00Z"), 120);
  assert.deepEqual(
    found.map((one) => [one.type, one.id]),
    [
      ["stale_claim", s.schema],
      ["blocking_cascade", s.schema],
    ],
  );
  assert.match(found[0].message, /^claimed by peer-a, untouched for 1\d\d min$/);
  assert.equal(
    alerts(s.work(), new Date("2026-10-14T09:30:00Z"), 120).some((one) => one.type === "stale_claim"),
    false,
  );
  assert.ok(extra);
});

test("a plan of eight hundred issues is still read in well under a second", () => {
  let tick = Date.parse("2026-10-14T09:00:00Z");
  const store = new WorkStore(join(ROOM_HOME, `graph-test-${(stores += 1)}`), TIMING, () => new Date((tick += 10)));
  store.createMany(
    Array.from({ length: 800 }, (_, i) => ({
      key: `k${i}`,
      title: `issue ${i}`,
      priority: i % 5,
      deps: i > 3 ? [{ id: `k${i - 1 - (i % 3)}` }, { id: `k${Math.floor(i / 2)}` }] : [],
    })),
    "lead",
  );
  const work = store.openWork();
  const started = Date.now();
  const read = triage(work, NOW);
  plan(work, NOW);
  const took = Date.now() - started;
  assert.equal(read.counts.open, 800);
  assert.ok(store.ready().length > 0);
  assert.ok(took < 1000, `triage and plan took ${took} ms`);
});
