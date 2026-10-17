import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Knowledge } from "../server/knowledge/index";
import { TaskKeys } from "../server/orchestration/task-keys";

shipSql();

let homes = 0;

/** A district over its own folders, and task keys that tell it about a first claim; `held` is what each seat holds in progress. */
function room() {
  const home = join(ROOM_HOME, `task-key-decisions-${(homes += 1)}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const project = join(home, "project");
  const held: Record<string, string[]> = {};
  const told: string[] = [];
  const lines: string[] = [];
  let knowledge!: Knowledge;
  const keys = new TaskKeys(
    join(home, "keys.json"),
    (line) => lines.push(line),
    (seat, from, to) => {
      told.push(`${seat}:${from}>${to}`);
      knowledge.taskClaimed(seat, from, to);
    },
  );
  knowledge = new Knowledge({
    roomDir: join(home, "room"),
    policy: () => ({ mode: "on", keepDays: 60 }),
    projectOf: () => project,
    projects: () => [project],
    mailAfter: () => [],
    seen: () => null,
    ownedTask: (agent, task) => (task === keys.of(agent, held[agent] ?? []) ? task : null),
    isRoomSeat: () => false,
    decides: () => false,
    briefs: (agent) => agent.startsWith("lead"),
    taskOf: (agent) => keys.of(agent, held[agent] ?? []),
    rootOf: () => project,
    threadsOf: () => [],
    judge: null,
    busyTimeoutMs: 1000,
    log: (line) => lines.push(line),
  });
  const decide = (agent: string, topic: string, statement: string, more: object = {}) =>
    knowledge.act(agent, { do: "decide", scope: "task", topic, statement, ...more }) as Promise<
      Record<string, unknown>
    >;
  const inForce = (agent: string) => (knowledge.recall(agent, { do: "list" }) as { inForce: string[] }).inForce;
  const claims = (agent: string, issue: string) => {
    held[agent] = [issue];
    return keys.of(agent, held[agent]);
  };
  return { knowledge, keys, decide, inForce, claims, told, lines, project };
}

test("a task's key is told of once, at a seat's first claim, whether its key was its own id or the head of its chain", () => {
  const { keys, claims, told } = room();
  assert.equal(keys.of("lead-1", []), "lead-1");
  assert.equal(claims("lead-1", "sw-a"), "sw-a");
  assert.equal(keys.of("lead-1", ["sw-a"]), "sw-a");
  assert.equal(claims("lead-1", "sw-b"), "sw-b", "a claim of another issue moves the key");
  keys.succeed("lead-0", "lead-9");
  assert.equal(claims("lead-9", "sw-c"), "sw-c");
  keys.of("lead-9", []);
  assert.deepEqual(told, ["lead-1:lead-1>sw-a", "lead-9:lead-0>sw-c"], "never a move from one issue to another");
});

test("what a Lead recorded as a task's decision before its first claim is the claimed issue's, and the Lead is not told it again as news", async () => {
  const { knowledge, decide, inForce, claims } = room();
  await decide("lead-1", "store engine", "Keep the store in SQLite.");
  assert.match(inForce("lead-1")[0], /^- \[task lead-1\] store-engine: Keep the store in SQLite\./);
  const before = knowledge.noticesFor("lead-1");
  before?.told();

  claims("lead-1", "sw-a");
  assert.match(inForce("lead-1")[0], /^- \[task sw-a\] store-engine: Keep the store in SQLite\./);
  assert.equal(knowledge.noticesFor("lead-1"), null, "nothing changed for the seat: no new decision, none gone");

  const plans = knowledge
    .storeOf(null)
    .plans()
    .filter(({ sql }) => sql.includes("SET scope_key") || sql.includes("UPDATE OR REPLACE shown"));
  assert.equal(plans.length, 2);
  assert.ok(
    plans.every(({ plan }) => !/\bSCAN\b/.test(plan)),
    "the move reads by index",
  );

  await decide("lead-1", "index kind", "Use a covering index for the lookup.");
  assert.equal(inForce("lead-1").length, 2);
  assert.ok(inForce("lead-1").every((line) => line.includes("[task sw-a]")));
});

test("a later claim of another issue leaves the first issue's decisions where they are; another seat's are not touched", async () => {
  const { decide, inForce, claims } = room();
  await decide("lead-1", "store engine", "Keep the store in SQLite.");
  await decide("lead-2", "cache layer", "Do not add a cache layer yet.");
  claims("lead-1", "sw-a");
  claims("lead-1", "sw-b");
  assert.deepEqual(inForce("lead-1"), [], "the decision is sw-a's, and the seat works on sw-b now");
  claims("lead-2", "sw-z");
  assert.match(inForce("lead-2")[0], /\[task sw-z\] cache-layer/);
});

test("a topic the issue already has in force stays with the issue; the seat's own version on that topic does not replace it", async () => {
  const { decide, inForce, claims, keys } = room();
  await decide("lead-1", "store engine", "Keep the store in SQLite.");
  await decide("lead-1", "test runner", "Run the tests with node only.");
  // the issue's own decisions were recorded by the Lead of a team above it, under the issue's key
  keys.of("lead-up", ["sw-a"]);
  await decide("lead-up", "store engine", "Keep the store in Postgres.");
  claims("lead-1", "sw-a");
  assert.deepEqual(
    inForce("lead-1")
      .map((line) => line.replace(/ \(since.*$/, ""))
      .sort(),
    [
      "- [task sw-a] store-engine: Keep the store in Postgres.",
      "- [task sw-a] test-runner: Run the tests with node only.",
    ],
    "the issue's version of a topic stands, the seat's other decisions follow it",
  );
});

test("a decision replaced before the claim moves with its history: withdrawing the new one gives the old back under the issue", async () => {
  const { knowledge, decide, inForce, claims } = room();
  await decide("lead-1", "slow tests", "Run the slow tests on every push.");
  await decide("lead-1", "slow tests", "Run the slow tests twice a day.", { replaces_version: 1 });
  claims("lead-1", "sw-a");
  assert.match(inForce("lead-1")[0], /\[task sw-a\] slow-tests: Run the slow tests twice a day\./);
  const withdrawn = (await knowledge.act("lead-1", {
    do: "withdraw",
    scope: "task",
    topic: "slow tests",
    reason: "The twice a day schedule was a mistake.",
    replaces_version: 2,
  })) as Record<string, unknown>;
  assert.match(String(withdrawn.line), /In force again: Run the slow tests on every push\./);
  assert.match(inForce("lead-1")[0], /\[task sw-a\] slow-tests: Run the slow tests on every push\./);
});

test("a move that fails is logged and the key still moves", () => {
  const home = join(ROOM_HOME, `task-key-decisions-fail-${(homes += 1)}`);
  mkdirSync(home, { recursive: true });
  const lines: string[] = [];
  const keys = new TaskKeys(
    join(home, "keys.json"),
    (line) => lines.push(line),
    () => {
      throw new Error("database is locked");
    },
  );
  assert.equal(keys.of("lead-1", ["sw-a"]), "sw-a");
  assert.equal(keys.of("lead-1", []), "sw-a");
  assert.match(lines.join("\n"), /what lead-1 recorded under lead-1 did not follow it to sw-a: database is locked/);
});
