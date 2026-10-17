import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Operations } from "../server/operations/index";
import { DOWN, operationsAt } from "./support/operations";
import { OperationsStore } from "../server/operations/store";
import { storeStats } from "../server/sqlite";

shipSql();
let homes = 0;

const A = "/work/alpha";
const B = "/work/beta";

/** An operations district over its own folder, with seats placed in projects, a clock, and a mailbox. */
function rig(options: { dir?: string; policy?: Record<string, unknown>; operators?: string[] } = {}) {
  const state = {
    projects: { a1: A, a2: A, b1: B, hq: null } as Record<string, string | null>,
    tops: { [A]: "a1", [B]: "b1" } as Record<string, string>,
  };
  const lifted: string[] = [];
  const labeled: { ids: string[]; state: Record<string, unknown> }[] = [];
  const labeler = {
    answers: new Map<string, string | null>(),
    on: true,
    open: () => labeler.on,
    take: async (asked: Record<string, unknown>, ids: readonly string[]) => {
      labeled.push({ ids: [...ids], state: asked });
      return ids.map((id) => labeler.answers.get(id) ?? null);
    },
  };
  const { ops, dir, policy, mailed, persisted, at } = operationsAt(`budget-${(homes += 1)}`, {
    start: "2026-10-15T10:00:00.000Z",
    policy: options.policy ?? { budget: {} },
    dir: options.dir,
    operators: options.operators,
    deps: {
      projectOf: (seat) => state.projects[seat] ?? null,
      topSeat: (project) => state.tops[project] ?? null,
      lifted: async (project) => void lifted.push(project),
      labeler,
    },
  });
  const budget = () =>
    (
      ops.act("hq-1", { do: "budget" }) as {
        budget: {
          day: string;
          held: { project: string; reason: string }[];
          projects: { project: string; today: { usd: number; turns: number }; cap: unknown; recent: string[] }[];
        };
      }
    ).budget;
  return { ops, dir, state, policy, mailed, lifted, persisted, labeler, labeled, at, budget };
}

const today = (view: ReturnType<ReturnType<typeof rig>["budget"]>, project: string) =>
  view.projects.find((one) => one.project === project)?.today;

test("a project's spend is the change in its seats' totals between turns, per UTC day, and survives a restart", () => {
  const { ops, dir, budget, policy } = rig();
  ops.opened("a1");
  ops.opened("a2");
  ops.spent("a1", 1.5);
  ops.spent("a1", 2);
  ops.spent("a2", 0.25);
  assert.deepEqual(today(budget(), A), { usd: 2.25, turns: 3 });
  // a seat resumed starts its total again at zero
  ops.spent("a1", 0.4);
  assert.deepEqual(today(budget(), A), { usd: 2.65, turns: 4 });
  // a seat the room never saw begin only gives a first reading to take changes from
  ops.spent("old", 30);
  ops.spent("old", 31);
  assert.deepEqual(today(budget(), "(no project)"), { usd: 1, turns: 2 });
  // a turn with no total, or a total that is no money, counts as a turn and costs nothing
  ops.spent("a2", undefined);
  ops.spent("a2", Number.NaN);
  ops.spent("a2", -3);
  assert.deepEqual(today(budget(), A), { usd: 2.65, turns: 7 });
  ops.close();

  const again = rig({ dir, policy });
  again.ops.spent("a1", 0.9);
  assert.deepEqual(today(again.budget(), A), { usd: 3.15, turns: 8 });
  again.at("2026-10-16T00:00:05.000Z");
  again.ops.spent("a1", 1.0);
  const view = again.budget();
  assert.equal(view.day, "2026-10-16");
  assert.deepEqual(
    view.projects.find((one) => one.project === A),
    {
      project: A,
      today: { usd: 0.1, turns: 1 },
      cap: null,
      recent: ["2026-10-15 $3.15 8 turns"],
    },
  );
  again.ops.close();
});

test("a project's spend is kept by role too, with the output tokens of its turns", () => {
  const { ops, budget } = rig();
  ops.opened("a1");
  ops.opened("a2");
  ops.spent("a1", 1.5, "peer", 1200);
  ops.spent("a2", 2, "lead", 400);
  ops.spent("a1", 2, "peer", 800);
  ops.spent("a2", 2.5);
  const row = budget().projects.find((one) => one.project === A) as { today: object; byRole?: object };
  assert.deepEqual(row.today, { usd: 4.5, turns: 4 }, "a turn with no role counts for the project only");
  assert.deepEqual(row.byRole, {
    peer: { usd: 2, turns: 2, outputTokens: 2000 },
    lead: { usd: 2, turns: 1, outputTokens: 400 },
  });
  ops.close();
});

test("the budget reading ranks projects by today's spend and is bounded", () => {
  const { ops, budget, state } = rig();
  state.projects = {
    ...state.projects,
    ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`s${i}`, `/p/${i}`])),
  };
  for (let i = 0; i < 25; i += 1) {
    ops.opened(`s${i}`);
    ops.spent(`s${i}`, i + 1);
  }
  const view = budget() as ReturnType<typeof budget> & { projectsLeftOut?: string };
  assert.equal(view.projects.length, 20, "the reading is bounded");
  assert.equal(view.projects[0].project, "/p/24");
  assert.equal(view.projects.at(-1)?.project, "/p/5");
  assert.match(view.projectsLeftOut ?? "", /^5 more projects/, "and says what it left out");
  ops.close();
});

test("a reading over more days of spend than it holds keeps the newest days of every project and says how many rows it left out", () => {
  const { ops, budget, state, at } = rig();
  const days = ["09", "10", "11", "12", "13", "14", "15"].map((day) => `2026-10-${day}`);
  const projects = 360;
  days.forEach((day, d) => {
    at(`${day}T10:00:00.000Z`);
    for (let i = 0; i < projects; i += 1) {
      state.projects[`s${i}`] = `/many/${i}`;
      if (d === 0) ops.opened(`s${i}`);
      // every project spends i + 1 cents a day, so the dearest today are the highest numbers
      ops.spent(`s${i}`, ((d + 1) * (i + 1)) / 100);
    }
  });
  const view = budget() as ReturnType<typeof budget> & { leftOut?: string };
  assert.equal(view.projects.length, 20);
  assert.equal(view.projects[0].project, "/many/359");
  for (const one of view.projects)
    assert.match(one.recent[0], /^2026-10-14 /, `${one.project} lost its newest day before today`);
  assert.match(view.leftOut ?? "", /^520 rows/);
  ops.close();
});

test("with no cap the room measures and shows, and never holds anything", async () => {
  const { ops, budget, mailed } = rig();
  ops.opened("a1");
  ops.spent("a1", 1_000_000);
  assert.equal(ops.holds("a1"), null);
  assert.equal(ops.holdsProject(A), null);
  assert.deepEqual(budget().held, []);
  await ops.tick();
  assert.deepEqual(
    mailed.filter((one) => /budget|held/i.test(one.subject)),
    [],
  );
  ops.close();
});

const GROUNDS = {
  reason: "Alpha spends most of the room's money and its day ends with nothing to show.",
  evidence: "budget reading: alpha spent 4.80 of its 5.00 dollars by noon on each of the last three days.",
};

/** The operator reads the budget and its log in this turn, as a change needs. */
const readBudget = (ops: Operations) => {
  ops.act("hq-1", { do: "budget" });
  ops.act("hq-1", { do: "log", district: "budget" });
};

test("a project past its cap is held and the others are not; the project's own cap wins over the default", () => {
  const { ops } = rig({ policy: { budget: { default: { dailyUsd: 20 }, projects: { [A]: { dailyUsd: 5 } } } } });
  for (const seat of ["a1", "b1", "hq"]) ops.opened(seat);
  ops.spent("a1", 4.99);
  assert.equal(ops.holds("a1"), null, "just under");
  ops.spent("a1", 5.01);
  assert.match(
    ops.holds("a1") ?? "",
    /^\$5\.01 spent of its \$5\.00 a day; held until 2026-10-16 00:00 UTC or until the cap is raised$/,
  );
  assert.equal(ops.holds("a2"), ops.holds("a1"), "every seat of the project");
  ops.spent("b1", 19.9);
  assert.equal(ops.holds("b1"), null, "the project has no cap of its own: the default holds, 20");
  ops.spent("b1", 20.1);
  assert.match(ops.holds("b1") ?? "", /^\$20\.10 spent of its \$20\.00 a day/);
  ops.spent("hq", 1000);
  assert.equal(ops.holds("hq"), null, "the room's own seats, and seats in no project, are never held");
  assert.equal(ops.holdsProject(A), ops.holds("a1"));
  assert.equal(ops.holdsProject(null), null);
  ops.close();
});

test("a cap that is no positive number is no cap", () => {
  const caps = { "/work/zero": 0, "/work/text": "5", "/work/negative": -1, "/work/none": null };
  const { ops, state } = rig({
    policy: {
      budget: {
        projects: Object.fromEntries(Object.entries(caps).map(([project, dailyUsd]) => [project, { dailyUsd }])),
      },
    },
  });
  for (const project of Object.keys(caps)) {
    state.projects[project] = project;
    ops.opened(project);
    ops.spent(project, 500);
    assert.equal(ops.holds(project), null, project);
  }
  ops.close();
});

test("a cap on turns holds a project at its count; both caps may hold and are both said", () => {
  const { ops } = rig({ policy: { budget: { projects: { [A]: { dailyUsd: 100, dailyTurns: 3 } } } } });
  ops.opened("a1");
  ops.spent("a1", 1);
  ops.spent("a1", 2);
  assert.equal(ops.holds("a1"), null);
  ops.spent("a1", 200);
  assert.match(ops.holds("a1") ?? "", /^\$200\.00 spent of its \$100\.00 a day and 3 turns ended of its 3 a day;/);
  ops.close();
});

test("the hold is kept by a restart, ends at the next UTC day, and ends at once when the cap is raised", async () => {
  const first = rig({ policy: { budget: { projects: { [A]: { dailyUsd: 5 } } } } });
  first.ops.opened("a1");
  first.ops.spent("a1", 6);
  first.ops.close();

  const { ops, at, lifted, dir } = rig({ dir: first.dir, policy: first.policy });
  assert.ok(ops.holds("a1"), "a restart keeps the hold");
  at("2026-10-15T23:59:00.000Z");
  assert.ok(ops.holds("a1"));
  at("2026-10-16T00:00:01.000Z");
  assert.equal(ops.holds("a1"), null, "the day ended");
  await ops.tick();
  assert.deepEqual(lifted, [A], "the held seats' mail is started again");
  await ops.tick();
  assert.deepEqual(lifted, [A], "once");
  ops.close();

  const raised = rig({ dir: `${dir}-raised`, policy: { budget: { projects: { [A]: { dailyUsd: 5 } } } } });
  raised.ops.opened("a1");
  raised.ops.spent("a1", 6);
  assert.ok(raised.ops.holds("a1"));
  (raised.policy.budget as { projects: Record<string, { dailyUsd: number }> }).projects[A].dailyUsd = 8;
  assert.equal(raised.ops.holds("a1"), null, "at once");
  await raised.ops.tick();
  assert.deepEqual(raised.lifted, [A]);
  raised.ops.spent("a1", 9);
  assert.ok(raised.ops.holds("a1"), "past the new cap it is held again");
  delete (raised.policy.budget as { projects?: unknown }).projects;
  assert.equal(raised.ops.holds("a1"), null);
  raised.ops.close();
});

test("a cap lowered under what a project spent today holds it at the next minute", async () => {
  const { ops, policy, lifted } = rig({ policy: { budget: { projects: { [A]: { dailyUsd: 50 } } } } });
  ops.opened("a1");
  ops.spent("a1", 6);
  assert.equal(ops.holds("a1"), null);
  (policy.budget as { projects: Record<string, { dailyUsd: number }> }).projects[A].dailyUsd = 5;
  assert.equal(ops.holds("a1"), null, "nothing is read until a turn ends or the minute passes");
  await ops.tick();
  assert.match(ops.holds("a1") ?? "", /^\$6\.00 spent of its \$5\.00 a day/);
  assert.deepEqual(lifted, []);
  ops.close();
});

test("a hold is one INCIDENT for the operators and one quiet mail for the project's top seat, even across a restart", async () => {
  const first = rig({ policy: { budget: { projects: { [A]: { dailyUsd: 5 } } } } });
  first.ops.opened("a1");
  first.ops.spent("a1", 6);
  first.ops.close();
  // the process stopped before the minute that tells of the hold
  const { ops, mailed, at } = rig({ dir: first.dir, policy: first.policy });
  await ops.tick();
  const incident = mailed.filter((one) => one.to === "hq-1");
  assert.equal(incident.length, 1);
  assert.match(incident[0].subject, /^INCIDENT: 1 in budget$/);
  assert.match(incident[0].body, new RegExp(`\\[budget\\] budget: ${A} is over its daily cap`));
  const notice = mailed.filter((one) => one.to === "a1");
  assert.equal(notice.length, 1);
  assert.equal(notice[0].quiet, true, "it starts no turn of its own");
  assert.match(notice[0].key ?? "", /^budget:/);
  assert.match(notice[0].subject, /^BUDGET: this project is held/);
  assert.match(notice[0].body, /\$6\.00 spent of its \$5\.00 a day/);
  at("2026-10-15T10:10:00.000Z");
  await ops.tick();
  await ops.tick();
  assert.equal(mailed.length, 2, "told once");
  ops.close();
  const restarted = rig({ dir: first.dir, policy: first.policy });
  await restarted.ops.tick();
  assert.equal(restarted.mailed.length, 0, "a hold already told is not told again by the next process");
  restarted.ops.close();
});

test("a second project held the same day is an incident of its own, told when the operators are next told", async () => {
  const { ops, mailed, at } = rig({ policy: { budget: { default: { dailyUsd: 5 } } } });
  ops.opened("a1");
  ops.opened("b1");
  ops.spent("a1", 6);
  await ops.tick();
  ops.spent("b1", 7);
  await ops.tick();
  assert.deepEqual(
    mailed.map((one) => one.to),
    ["a1", "hq-1", "b1"],
  );
  at("2026-10-15T10:16:00.000Z");
  await ops.tick();
  const second = mailed.at(-1)!;
  assert.equal(second.to, "hq-1");
  assert.match(second.body, new RegExp(`${B} is over its daily cap`));
  assert.doesNotMatch(second.body, new RegExp(`${A} is over`));
  ops.close();
});

test("the operator may lower a cap and never raise one: not by a value, not by undoing its own change", () => {
  const { ops, policy, persisted } = rig({
    policy: {
      budget: {
        default: { dailyUsd: 20 },
        projects: { [A]: { dailyUsd: 5 }, "/work/my.app": { dailyUsd: 9 }, "/work/beta/": { dailyUsd: 8 } },
      },
    },
  });
  ops.opened("a1");
  ops.spent("a1", 1);
  const tune = (path: string, value: unknown, more: object = {}) =>
    ops.act("hq-1", { do: "tune", path, value, ...GROUNDS, ...more });
  assert.throws(() => tune(`budget.projects[${A}].dailyUsd`, 3), /read budget in this turn first/);
  readBudget(ops);
  const key = `budget.projects[${A}].dailyUsd`;
  assert.throws(() => tune(key, 8), /you may only lower it/);
  assert.throws(() => tune(key, 5), /you may only lower it/);
  assert.throws(() => tune(key, 0.5), /from 1 to 10000/);
  assert.throws(() => tune(`budget.projects[/work/unknown].dailyUsd`, 3), /no project \/work\/unknown/);
  assert.throws(() => tune("budget.projects.dailyUsd", 3), /not one the room tunes on its own/);
  const done = tune(key, 3);
  assert.deepEqual((policy.budget as { projects: Record<string, unknown> }).projects[A], { dailyUsd: 3 });
  assert.deepEqual(persisted, [[key, 3]]);
  assert.match(String(done.line), /budget\.projects\[\/work\/alpha\]\.dailyUsd: 5 -> 3/);
  assert.throws(() => tune(key, 4), /you may only lower it/);
  assert.throws(
    () => ops.act("hq-1", { do: "revert", id: done.id, ...GROUNDS }),
    /only the person raises .*undoing a change would raise it/,
  );
  // a project with a dot in its folder name is addressed whole
  tune("budget.projects[/work/my.app].dailyUsd", 4);
  assert.deepEqual((policy.budget as { projects: Record<string, unknown> }).projects["/work/my.app"], { dailyUsd: 4 });
  // a folder the owner spelled another way is changed under the owner's key, never beside it under a second one
  assert.throws(() => tune("budget.projects[/work/beta].dailyUsd", 9), /is 8: you may only lower it/);
  tune("budget.projects[/work/beta].dailyUsd", 6);
  assert.deepEqual(Object.keys((policy.budget as { projects: object }).projects), [A, "/work/my.app", "/work/beta/"]);
  assert.deepEqual(persisted.at(-1), ["budget.projects[/work/beta/].dailyUsd", 6]);
  assert.deepEqual(
    (ops.act("hq-1", { do: "policy" }).tunable as Record<string, { value: unknown }>)["budget.default.dailyTurns"]
      .value,
    null,
  );
  tune("budget.default.dailyTurns", 400);
  assert.throws(() => tune("budget.default.dailyTurns", 500), /you may only lower it/);
  tune("budget.default.dailyUsd", 15);
  ops.close();
});

test("a project held to the default's cap cannot be given a cap above it", () => {
  const { ops, policy } = rig({
    policy: { budget: { default: { dailyUsd: 20 }, projects: { [B]: { dailyTurns: 90 } } } },
  });
  ops.opened("a1");
  ops.spent("a1", 1);
  readBudget(ops);
  const tune = (project: string, value: number) =>
    ops.act("hq-1", { do: "tune", path: `budget.projects[${project}].dailyUsd`, value, ...GROUNDS });
  assert.throws(() => tune(A, 50), /is 20: you may only lower it/);
  assert.throws(() => tune(A, 20), /is 20: you may only lower it/);
  tune(A, 15);
  assert.deepEqual((policy.budget as { projects: Record<string, unknown> }).projects[A], { dailyUsd: 15 });
  // a project whose own cap names no dollars has none to raise
  tune(B, 50);
  ops.close();
});

test("the policy listing shows each project's cap under the key that tunes it", () => {
  const { ops } = rig({ policy: { budget: { projects: { [A]: { dailyUsd: 5 }, [B]: { dailyTurns: 90 } } } } });
  const tunable = ops.act("hq-1", { do: "policy" }).tunable as Record<string, { value: unknown; lowerOnly?: boolean }>;
  assert.deepEqual(tunable["budget.projects[*].dailyUsd"].value, { [A]: 5 });
  assert.deepEqual(tunable["budget.projects[*].dailyTurns"].value, { [B]: 90 });
  assert.equal(tunable["budget.projects[*].dailyUsd"].lowerOnly, true);
  ops.close();
});

test("the retention of the spend rows: days past the keep, a seat's total unseen for as long, and a hold long past go", () => {
  const dir = join(ROOM_HOME, "budget-expire");
  rmSync(dir, { recursive: true, force: true });
  let now = new Date("2026-09-01T10:00:00.000Z");
  const store = new OperationsStore(dir, 1000, () => now);
  store.spend("/p/a", "2026-09-01", "s1", 1);
  store.spend("/p/a", "2026-09-30", "s2", 1);
  store.addHold({ project: "/p/a", day: "2026-09-01", since: now.toISOString(), reason: "r" });
  now = new Date("2026-09-30T10:00:00.000Z");
  store.spend("/p/a", "2026-09-30", "s2", 2);
  assert.equal(store.expireSpend("2026-09-10", "2026-09-10T00:00:00.000Z"), 1 + 1 + 1);
  assert.deepEqual(
    store.spendFrom("2000-01-01").rows.map((row) => [row.day, row.usd]),
    [["2026-09-30", 1]],
  );
  assert.equal(store.holdRows().length, 0);
  store.close();
});

test("every statement of the spend ledger and the skill loads reads by an index", () => {
  const dir = join(ROOM_HOME, "budget-plans");
  rmSync(dir, { recursive: true, force: true });
  const store = new OperationsStore(dir, 1000);
  store.baseline("s1");
  store.spend("/p/a", "2026-10-15", "s1", 2, "peer", 900);
  store.spendOn("2026-10-15");
  store.spendByRole("2026-10-15", ["/p/a"]);
  store.spendFrom("2026-10-09");
  store.knowsProject("/p/a");
  store.addHold({ project: "/p/a", day: "2026-10-15", since: "2026-10-15T00:00:00.000Z", reason: "r" });
  store.holdRows();
  store.toldHold("/p/a");
  store.dropHold("/p/a");
  store.dropSeat("s1");
  store.skillsLoaded("2026-10-15", "peer", ["test-audit", "blast-radius"]);
  store.skillLoads("2026-10-09");
  store.expireSpend("2026-09-01", "2026-09-01T00:00:00.000Z");
  const whole = [
    "SELECT project, day, usd, turns FROM spend WHERE day >=",
    "SELECT project, day, since, reason, told FROM holds",
  ];
  const scans = store
    .plans()
    .filter(({ plan }) => /\bSCAN (spend|spend_seats|spend_roles|holds|skill_loads)\b(?! USING)/.test(plan))
    .filter(({ sql }) => !whole.some((known) => sql.includes(known)));
  assert.deepEqual(scans, []);
  store.close();
});

test("the digest groups the day's incidents by what they were read as, and a budget hold is never put to the model", async () => {
  const { ops, mailed, labeler, labeled, at } = rig({ policy: { budget: { projects: { [A]: { dailyUsd: 5 } } } } });
  at("2026-10-15T12:00:00.000Z");
  ops.opened("a1");
  ops.spent("a1", 6);
  ops.log(DOWN);
  labeler.answers.set("i1", "outside");
  await ops.tick();
  assert.deepEqual(labeled[0].ids, ["i1"], "the hold is not asked");
  at("2026-10-16T10:00:01.000Z");
  await ops.tick();
  const digest = mailed.find((one) => one.subject.startsWith("DIGEST"))!;
  assert.match(
    digest.body,
    /Incidents:\nAn outside service is down or refusing:\n#1 \[mail\] [^\n]*\nNot read:\n#2 \[budget\] /,
  );
  assert.match(digest.body, /\nbudget: \{"day":"2026-10-16"/);
  ops.close();
});

test("a seat's last total is forgotten with the seat, and a cap never reaches a seat whose project cannot be read", () => {
  const { ops, state, budget } = rig({ policy: { budget: { default: { dailyUsd: 1 } } } });
  ops.opened("a1");
  ops.spent("a1", 0.5);
  ops.forget("a1");
  ops.spent("a1", 40);
  assert.deepEqual(today(budget(), A), { usd: 0.5, turns: 2 }, "a total with nothing before it is a first reading");
  ops.spent("a1", 41);
  assert.ok(ops.holds("a1"), "past the default cap");
  state.projects = new Proxy(state.projects, {
    get() {
      throw new Error("the registry is unreadable");
    },
  });
  assert.equal(ops.holds("a1"), null, "a project that cannot be read holds nothing");
  ops.close();
});

test("a key that would reach the prototype of the policy is no key", () => {
  const policy = JSON.parse('{"budget":{"projects":{"__proto__":{"dailyUsd":9}}}}') as Record<string, unknown>;
  const { ops } = rig({ policy });
  readBudget(ops);
  assert.throws(
    () => ops.act("hq-1", { do: "tune", path: "budget.projects[__proto__].dailyUsd", value: 3, ...GROUNDS }),
    /is no key/,
  );
  assert.equal(({} as Record<string, unknown>).dailyUsd, undefined);
  ops.close();
});

test("what a turn end, a delivery check, the reading and the minute cost in statements does not grow with the spend kept", async () => {
  const calls = (dir: string) => storeStats().find((one) => one.file === join(dir, "operations.db"))!.calls;
  const measure = async (projects: number) => {
    const { ops, state, dir, at } = rig({ policy: { budget: { default: { dailyUsd: 1000 } } } });
    for (const day of ["2026-10-13", "2026-10-14", "2026-10-15"]) {
      at(`${day}T10:00:00.000Z`);
      for (let i = 0; i < projects; i += 1) {
        state.projects[`s${i}`] = `/p/${i}`;
        ops.opened(`s${i}`);
        ops.spent(`s${i}`, 2 * (i + 1) + (day === "2026-10-15" ? 1 : 0));
      }
    }
    state.projects.x = A;
    ops.opened("x");
    const used: number[] = [];
    const count = async (work: () => unknown) => {
      const before = calls(dir);
      await work();
      used.push(calls(dir) - before);
    };
    await count(() => ops.spent("x", 1));
    await count(() => ops.holds("x"));
    await count(() => ops.act("hq-1", { do: "budget" }));
    await count(() => ops.tick());
    ops.close();
    return used;
  };
  const small = await measure(3);
  const large = await measure(300);
  assert.deepEqual(large, small);
  assert.equal(small[1], 0, "a delivery check reads no store");
});
