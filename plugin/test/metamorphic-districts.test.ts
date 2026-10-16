import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { TurnEvent } from "../server/host";
import { Knowledge } from "../server/knowledge/index";
import { incidentOf } from "../server/operations/lines";
import { alerts, blockerChain, next, plan, triage, type Work } from "../server/tasks/graph";
import { refIssue, WorkStore, type NewIssue } from "../server/tasks/store";

shipSql();

let homes = 0;
const sorted = (items: readonly string[]) => [...items].sort();

/** A knowledge district over folders of its own, with each text kept as one saying of its own turn. */
function recorded(texts: string[]) {
  const home = join(ROOM_HOME, `metamorphic-knowledge-${(homes += 1)}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const project = join(home, "project");
  const knowledge = new Knowledge({
    roomDir: join(home, "room"),
    policy: () => ({ mode: "on", keepDays: 60 }),
    projectOf: () => project,
    projects: () => [project],
    mailAfter: () => [],
    seen: () => null,
    ownedTask: (_agent, task) => task,
    isRoomSeat: () => false,
    decides: () => false,
    briefs: () => false,
    taskOf: () => "T-1",
    rootOf: () => project,
    threadsOf: () => [],
    busyTimeoutMs: 1000,
    log: () => {},
  });
  const add = (more: string[]) =>
    more.forEach((text, i) =>
      knowledge.turnEnded({
        agent: "peer-a",
        parentId: null,
        role: "peer",
        task: "T-1",
        turnId: `turn-${(homes += 1)}-${i}`,
        outcome: "completed",
        events: [{ kind: "say", text } satisfies TurnEvent],
      }),
    );
  add(texts);
  return { knowledge, add };
}

/** What a search finds: the addresses of its hits best first, and whether every word or only some matched. */
function found(knowledge: Knowledge, args: Record<string, unknown>) {
  const answer = knowledge.recall("peer-a", { do: "search", limit: 50, ...args }) as {
    hits: { address: string }[];
    understood: { matched: string }[];
  };
  return { hits: answer.hits.map((hit) => hit.address), matched: sorted(answer.understood.map((one) => one.matched)) };
}

const CORPUS = [
  "The login form fails when the session store is Redis",
  "Switched the session store to Redis and the login tests pass",
  "Redis cache layer added for the login endpoint, login latency fell",
  "Retry the database lock error with a backoff",
  "login",
  "Database lock timeout in the migration, login unaffected",
  "Redis login",
  "Use pnpm, not npm, for the workspace install",
];
const QUERIES = [
  "login redis",
  "session store redis",
  "database lock login",
  "The login Redis",
  "cache layer login endpoint",
  "tests pass login form",
  "login pnpm",
  "nothing matches xyzzy",
  "redis tests cache",
];

/** Word orders and letter cases of a query: the same words. */
function respelt(query: string): string[] {
  const words = query.split(" ");
  const cased = (change: (word: string, index: number) => string) => words.map(change).join(" ");
  return [
    [...words].reverse().join(" "),
    [...words.slice(1), words[0]].join(" "),
    [words[1] ?? "", words[0], ...words.slice(2)].join(" ").trim(),
    sorted(words).join(" "),
    query.toUpperCase(),
    query.toLowerCase(),
    cased((word, i) => (i % 2 ? word.toUpperCase() : word.toLowerCase())),
    cased((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()),
    `${query} ${query}`,
  ];
}

test("a search finds the same entries in the same order whatever the order or case of the words asked", () => {
  const { knowledge } = recorded(CORPUS);
  for (const query of QUERIES) {
    const base = found(knowledge, { q: query });
    for (const other of respelt(query)) assert.deepEqual(found(knowledge, { q: other }), base, `${query} / ${other}`);
  }
  assert.ok(found(knowledge, { q: "login redis" }).hits.length >= 3, "the table asks for something");
  knowledge.close();
});

test("a search by two phrasings finds the same entries whichever phrasing is the question and which the alternative", () => {
  const { knowledge } = recorded(CORPUS);
  for (const [a, b] of [
    ["cache backend", "Redis session"],
    ["login", "database lock"],
    ["pnpm", "Redis"],
  ]) {
    const asked = found(knowledge, { q: a, also: [b] });
    assert.deepEqual(found(knowledge, { q: b, also: [a] }), asked, `${a} / ${b}`);
    assert.ok(asked.hits.length > 0, `${a} / ${b}`);
  }
  knowledge.close();
});

test("entries that share no word with a query leave what it finds as it was, even words that only begin or end alike", () => {
  const { knowledge, add } = recorded(CORPUS);
  const before = QUERIES.map((query) => found(knowledge, { q: query }));
  add([
    "Painted the fence green",
    "Loginfo level raised, redistributed the budget, lockers and the storehouse cleaned out",
    "Quarterly invoice reconciliation finished early with plenty of filler words so that this entry is much longer than all the others in the record",
    "Zebra",
    "Sessionless token and a cachet",
  ]);
  QUERIES.forEach((query, i) => {
    const after = found(knowledge, { q: query });
    assert.deepEqual(sorted(after.hits), sorted(before[i].hits), query);
    assert.deepEqual(after.matched, before[i].matched, query);
  });
  knowledge.close();
});

const ONE_TROUBLE: [string, string][] = [
  [
    "sqlite: the mail store was slow 2 times in the last minute",
    "sqlite: the mail store was slow 17 times in the last minute",
  ],
  ["budget: spend of 0.25 not marked", "budget: spend of 13.7 not marked"],
  [
    "mail: delivery to 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed: refused",
    "mail: delivery to 9b2504e0-4f89-11d3-9a0c-0305e82c3302 failed: refused",
  ],
  [
    "jev: call failed with 8f14e45fceea167a5a36dedd4bea2543 not read",
    "jev: call failed with c4ca4238a0b923820dcc509a6f75849b not read",
  ],
  [
    "knowledge: the turn peer-a:t1 was not kept: database is locked",
    "knowledge: the turn peer-a:t27 was not kept: database is locked",
  ],
  ["turn: summary of seat sw-3k9.2 failed", "turn: summary of seat sw-77x.14 failed"],
  [
    "room: the file ~/.config/room/a.json could not be read",
    "room: the file ~/.config/room/b/c.json could not be read",
  ],
  ["safety: the store at /tmp/x1/db failed", "safety: the store at /var/folders/zz/T/y2/db failed"],
  ["gc: the sweep failed at 2026-10-14T09:00:00.123Z: EACCES", "gc: the sweep failed at 2026-10-15T23:59:59Z: EACCES"],
  ["work: issue 'sw-abc' was not marked", "work: issue 'sw-xyz' was not marked"],
  ["knowledge:   the turn  x1  was not kept:   locked", "knowledge: the turn x2 was not kept: locked"],
  [
    "gc: could not read it at 2026-10-14T09:00:00+02:00: EACCES",
    "gc: could not read it at 2026-10-14T07:00:00Z: EACCES",
  ],
  ["work: write of src/a.ts failed", "work: write of lib/deep/b.ts failed"],
];

const TWO_TROUBLES: [string, string][] = [
  ["mail: delivery to a failed: refused", "knowledge: delivery to a failed: refused"],
  ["mail: delivery failed: refused", "mail: delivery failed: timeout"],
  [
    "knowledge: the turn peer-a:t1 was not kept: database is locked",
    "knowledge: the turn peer-a:t1 was not kept: disk is full",
  ],
  ["gc: could not delete /tmp/a", "gc: could not read /tmp/a"],
  ["sqlite: the mail store was slow", "sqlite: the work store was slow"],
  ["mail: delivery failed after 3 tries", "mail: delivery refused after 3 tries"],
  [
    `mail: ${"the batch of mails to the operator ".repeat(3)}failed: refused`,
    `mail: ${"the batch of mails to the operator ".repeat(3)}failed: timeout`,
  ],
];

test("log lines that differ only in numbers, ids, hashes, paths or times get one incident key", () => {
  for (const [a, b] of ONE_TROUBLE) {
    assert.notEqual(incidentOf(a), null, a);
    assert.equal(incidentOf(a), incidentOf(b), `${a} / ${b}`);
  }
});

test("log lines of different troubles get different incident keys", () => {
  for (const [a, b] of TWO_TROUBLES) {
    assert.notEqual(incidentOf(a), null, a);
    assert.notEqual(incidentOf(a), incidentOf(b), `${a} / ${b}`);
  }
});

const NOW = new Date("2026-10-14T08:00:00Z");
const CLOSE = { minReasonChars: 20, forbidSelfClose: true };
const PLAN: (NewIssue & { key: string })[] = [
  { key: "schema", title: "schema", priority: 1, write_scope: "src/schema.js" },
  { key: "api", title: "api", deps: [{ id: "schema" }], write_scope: "src/api/**" },
  { key: "ui", title: "ui", deps: [{ id: "api" }, { id: "design" }] },
  { key: "report", title: "report", priority: 3, deps: [{ id: "schema" }] },
  { key: "design", title: "design", priority: 0 },
  { key: "docs", title: "docs", priority: 3, write_scope: "README.md, docs/" },
  { key: "lint", title: "lint", priority: 3, write_scope: "docs/style.md" },
  { key: "release", title: "release", deps: [{ id: "ui" }, { id: "report" }, { id: "docs" }] },
  { key: "epic", title: "epic", issue_type: "epic" },
  { key: "one", title: "child one", parent: "epic" },
  { key: "two", title: "child two", parent: "epic", deps: [{ id: "lint" }] },
];

/** The plan in another order, a parent kept before its children: reversed, turned about, and shuffled. */
function orders(): NewIssue[][] {
  let seed = 7;
  const shuffled = [...PLAN].sort(() => ((seed = (seed * 48271) % 2147483647) % 3) - 1);
  return [[...PLAN].reverse(), [...PLAN.slice(4), ...PLAN.slice(0, 4)], shuffled].map((order) =>
    [...order].sort((a, b) => Number(!!a.parent) - Number(!!b.parent)),
  );
}

/** A work store holding the issues made in the order given, a second apart, and the title of each id. */
function made(order: readonly NewIssue[]) {
  let tick = Date.parse("2026-10-14T09:00:00Z");
  const clock = () => new Date((tick += 1000));
  const store = new WorkStore(
    join(ROOM_HOME, `metamorphic-graph-${(homes += 1)}`),
    { busyTimeoutMs: 5000, flushAfterMs: 60_000 },
    clock,
  );
  const titles = new Map(store.createMany(order, "lead").map((issue) => [issue.id, issue.title]));
  return { store, titles };
}

/** Every answer the graph gives of a work, with each issue named by its title, and what ties on id put in a fixed order. */
function read(work: Work, titles: ReadonlyMap<string, string>) {
  const name = (ref: string) => titles.get(refIssue(ref))! + ref.slice(refIssue(ref).length);
  const names = (refs: readonly string[]) => sorted(refs.map(name));
  const seen = triage(work, NOW, 100);
  const planned = plan(work, NOW);
  const pick = next(work, NOW);
  return {
    ready: names([...work.ready]),
    blocked: sorted([...work.blocked].map(([id, refs]) => `${name(id)} <- ${names(refs)}`)),
    counts: seen.counts,
    scored: sorted(
      seen.recommendations.map(
        (one) => `${name(one.id)} ${one.score} ${one.claimable} +${names(one.unblocks)} -${names(one.blocked_by)}`,
      ),
    ),
    heldUp: seen.blockers_to_clear.map((one) => one.holds_up),
    pick: pick && `${pick.score} ${pick.priority}`,
    tracks: sorted(planned.tracks.map((track) => names(track.items.map((item) => item.id)).join("+"))),
    planned: [planned.ready, planned.blocked],
    overlaps: sorted(planned.overlaps.map((one) => `${names([one.a, one.b])} ${one.paths}`)),
    chains: sorted(
      work.issues
        .filter((issue) => issue.status !== "closed")
        .map(
          (issue) =>
            `${name(issue.id)}: ${blockerChain(work, issue.id).map((level) => names(level.map((one) => one.id)))}`,
        ),
    ),
    alerts: sorted(alerts(work, NOW, 120).map((one) => `${one.type} ${name(one.id)}`)),
  };
}

test("the same plan made in another order gives the same ready, blocked and plan answers, up to the issue ids", () => {
  const first = made(PLAN);
  const base = read(first.store.openWork(), first.titles);
  assert.equal(base.counts.open, PLAN.length);
  assert.ok(base.ready.length > 0 && base.blocked.length > 0 && base.tracks.length > 1);
  for (const order of orders()) {
    const again = made(order);
    assert.deepEqual(read(again.store.openWork(), again.titles), base);
    again.store.close();
  }
  first.store.close();
});

/** The work as the graph may be handed it, closed issues and their edges included. */
function everything(store: WorkStore): Work {
  return { ...store.openWork(), issues: store.all(), dependencies: store.dependencies() };
}

const WITH_CLOSED: [title: string, order: NewIssue[]][] = [
  ["old", [...PLAN, { key: "old", title: "old" }]],
  [
    "legacy",
    [
      ...PLAN.map((one) => (one.key === "schema" ? { ...one, deps: [{ id: "legacy" }] } : one)),
      { key: "legacy", title: "legacy" },
    ],
  ],
  ["zero", [...PLAN, { key: "zero", title: "zero", parent: "epic" }]],
];

test("a closed issue changes none of the answers: one nothing joins, a closed blocker, a closed child", () => {
  const first = made(PLAN);
  const base = read(first.store.openWork(), first.titles);
  for (const [title, order] of WITH_CLOSED) {
    const { store, titles } = made(order);
    const id = [...titles].find(([, named]) => named === title)![0];
    store.closeIssue(id, "done in 4f2a91c, npm test 88/88", "lead", CLOSE);
    for (const work of [store.openWork(), everything(store)]) assert.deepEqual(read(work, titles), base, title);
    store.close();
  }
  first.store.close();
});
