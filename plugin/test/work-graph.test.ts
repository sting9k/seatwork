import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { alerts, blockerChain, next, plan, triage, unreadScopes } from "../server/tasks/graph";
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
  s.store.create({ title: "export", deps: [{ id: s.schema }] }, "lead");
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
});

test("pairs whose overlap no path can tell are the ones put to the model, and none past the most it may ask", () => {
  let tick = Date.parse("2026-10-14T09:00:00Z");
  const store = new WorkStore(join(ROOM_HOME, `graph-test-${(stores += 1)}`), TIMING, () => new Date((tick += 1000)));
  const make = (title: string, write_scope: string) => store.create({ title, write_scope }, "lead").id;
  const login = make("login", "the login module and its session handling");
  const api = make("api", "src/api/**");
  const docs = make("docs", "docs/");
  make("unscoped", "");
  const work = store.openWork();
  const pairs = unreadScopes(work, plan(work, NOW), 10);
  assert.deepEqual(
    pairs.map(({ a, b }) => [a, b].sort().join(" ")).sort(),
    [
      [api, login],
      [docs, login],
    ]
      .map((pair) => pair.sort().join(" "))
      .sort(),
  );
  assert.deepEqual(unreadScopes(work, plan(work, NOW), 1), [], "more pairs than may be asked: none is asked");
  store.close();
});

test("triage and plan grow with the issues, not with their square: six times the issues, far less than thirty-six times the work", () => {
  const store = new WorkStore(join(ROOM_HOME, `graph-test-${(stores += 1)}`), TIMING, () => NOW);
  const shape = store.create({ title: "shape" }, "lead");
  store.close();
  /** A chain of `count` issues in memory, each held by the one before it. */
  const chain = (count: number) => {
    const ids = Array.from({ length: count }, (_, i) => `sw-${i}`);
    return {
      issues: ids.map((id, i) => ({ ...shape, id, title: `issue ${i}`, priority: i % 5 })),
      dependencies: ids.slice(1).map((id, i) => ({ issue_id: id, depends_on_id: ids[i], type: "blocks" as const })),
      ready: new Set([ids[0]]),
      blocked: new Map(ids.slice(1).map((id, i) => [id, [ids[i]]])),
    };
  };
  const [small, large] = [chain(1000), chain(6000)];
  const once = (work: ReturnType<typeof chain>) => {
    const started = performance.now();
    triage(work, NOW);
    plan(work, NOW);
    return performance.now() - started;
  };
  // warmed first, then taken in turns, the fastest of each: a busy machine slows one reading, not the ratio
  once(small);
  once(large);
  let [fastSmall, fastLarge] = [Infinity, Infinity];
  for (let i = 0; i < 5; i += 1) {
    fastSmall = Math.min(fastSmall, once(small));
    fastLarge = Math.min(fastLarge, once(large));
  }
  assert.ok(
    fastLarge < Math.max(fastSmall, 5) * 24,
    `1000 issues: ${fastSmall.toFixed(0)} ms, 6000 issues: ${fastLarge.toFixed(0)} ms`,
  );
});

test("the graph takes readiness from the store: a deferred issue is no pick, and the counts agree with the ready list", () => {
  const s = sample();
  s.store.update(s.docs, { defer_until: "2099-01-01T00:00:00.000Z" }, "lead");
  const work = s.work();
  const seen = triage(work, NOW);
  assert.equal(seen.counts.ready, s.store.ready().length);
  assert.ok(!seen.recommendations.some((one) => one.id === s.docs));
  assert.notEqual(next(work, NOW)?.id, s.docs);
});

test("write scopes collide however a path is written: ./, a line number, a glob over the folder; words of prose are no paths", () => {
  let tick = Date.parse("2026-10-14T09:00:00Z");
  const store = new WorkStore(join(ROOM_HOME, `graph-test-${(stores += 1)}`), TIMING, () => new Date((tick += 1000)));
  const scoped = (write_scope: string) => store.create({ title: write_scope, write_scope }, "lead").id;
  const dotted = scoped("./src/a.ts");
  const lined = scoped("src/a.ts:12");
  const globbed = scoped("src/*.ts");
  const prose = scoped("e.g. the v22.1 notes");
  const pairs = plan(store.openWork(), NOW).overlaps.map((pair) => [pair.a, pair.b].sort().join(" "));
  for (const [a, b] of [
    [dotted, lined],
    [dotted, globbed],
    [lined, globbed],
  ])
    assert.ok(pairs.includes([a, b].sort().join(" ")), `${a} and ${b}`);
  assert.ok(!pairs.some((pair) => pair.includes(prose)));
});

test("the pairs whose scopes no path can tell are found in time with the issues, not with all their pairs", () => {
  const store = new WorkStore(join(ROOM_HOME, `graph-test-${(stores += 1)}`), TIMING, () => NOW);
  const shape = store.create({ title: "shape" }, "lead");
  store.close();
  /** `count` planned issues with a path each, and one whose scope is prose. */
  const planned = (count: number) => {
    const issues = Array.from({ length: count }, (_, i) => ({
      ...shape,
      id: `sw-${i}`,
      write_scope: i === count >> 1 ? "the login module" : `src/file${i}.ts`,
    }));
    const work = { issues, dependencies: [], ready: new Set<string>(), blocked: new Map() };
    const tracks = [
      {
        track: "track-1",
        items: issues.map(({ id }) => ({ id, title: id, priority: 2, status: "open", unblocks: [] })),
      },
    ];
    return () => {
      const started = performance.now();
      const found = unreadScopes(work, { tracks, ready: count, blocked: 0, overlaps: [] }, count);
      assert.equal(found.length, count - 1, "the prose one pairs with every other");
      return performance.now() - started;
    };
  };
  const [small, large] = [planned(1500), planned(6000)];
  small();
  large();
  let [fastSmall, fastLarge] = [Infinity, Infinity];
  for (let i = 0; i < 5; i += 1) {
    fastSmall = Math.min(fastSmall, small());
    fastLarge = Math.min(fastLarge, large());
  }
  assert.ok(
    fastLarge < Math.max(fastSmall, 2) * 9,
    `1500 issues: ${fastSmall.toFixed(1)} ms, 6000 issues: ${fastLarge.toFixed(1)} ms`,
  );
});
