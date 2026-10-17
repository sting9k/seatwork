import { PROJECT } from "./support/room";
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { roomProjectDir } from "../server/orchestration/registry";
import { git } from "./support/git";
import { editPolicy, pluginRoom } from "./support/plugin";
import { projectFolder } from "./support/seats";

const project = (name: string) => realpathSync(projectFolder(name));
const capped = project("budget-capped");
const free = project("budget-free");

const {
  call,
  agents,
  context,
  seat: open,
  turnEnds,
} = pluginRoom(["claude-hq", "claude-lead", "claude-peer"], {
  // the owner's spelling of the folder, not the registry's: a trailing slash, the path before its links
  policy: (policy) =>
    void (policy.budget = { projects: { [`${join(PROJECT, "..", "budget-capped")}/`]: { dailyUsd: 1 } } }),
  timers: "minute",
});

const costs: Record<string, number> = {};

/** A seat the room knows, whose turns the app reports with what they cost so far. */
async function seat(id: string, provider: string, parent: string | null, title: string, cwd: string) {
  const one = await open(id, provider, parent, title, cwd);
  Object.assign(agents[id], {
    current: () => ({ status: "idle", provider, ...(id in costs ? { lastUsage: { totalCostUsd: costs[id] } } : {}) }),
  });
  const endsTurn = (message: string, cost: number) => {
    costs[id] = cost;
    return turnEnds(one, message);
  };
  return { ...one, endsTurn };
}

const createRequest = (provider: string, cwd: string) => ({
  request: { config: { provider, cwd, title: "[Peer] more" }, env: {} },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a project past its cap takes no mail and no new seat; the room's operator is told once, and the others work on", async () => {
  const hq = await seat("hq-budget", "claude-hq", null, "[HQ] room", roomProjectDir());
  const lead = await seat("lead-budget", "claude-lead", null, "[Lead] capped", capped);
  const peer = await seat("peer-budget", "claude-peer", "lead-budget", "[Peer] capped", capped);
  const elsewhere = await seat("peer-budget-free", "claude-peer", null, "[Peer] free", free);

  // the first turn of a new seat counts whole; the report it sends up waits behind the hold the turn's cost caused
  await peer.endsTurn("DONE: a first pass.", 1.4);
  assert.deepEqual(lead.inbox, [], "the Lead's mail waits");
  await elsewhere.endsTurn("DONE: elsewhere.", 30);

  const view = JSON.parse(await hq.call("seatwork_room", { do: "budget" })) as {
    budget: { held: { project: string }[]; projects: { project: string; today: { usd: number; turns: number } }[] };
  };
  assert.deepEqual(
    view.budget.held.map((one) => one.project),
    [capped],
  );
  assert.deepEqual(view.budget.projects.find((one) => one.project === capped)?.today, { usd: 1.4, turns: 1 });
  assert.deepEqual(view.budget.projects.find((one) => one.project === free)?.today, { usd: 30, turns: 1 });

  await assert.rejects(
    async () => call("before agent.create", createRequest("claude-peer", capped), context),
    /claude-peer refused: .*budget-capped is held by the room's budget: \$1\.40 spent of its \$1\.00 a day/,
  );
  await call("before agent.create", createRequest("claude-peer", free), context);

  mock.timers.tick(60_000);
  for (let waited = 0; hq.inbox.length === 0 && waited < 100; waited += 1) await settle();
  assert.equal(hq.inbox.length, 1);
  assert.match(hq.inbox[0], /subject="INCIDENT: \d in budget[^"]*"/);
  assert.match(hq.inbox[0], /\[budget\] budget: .*budget-capped is over its daily cap/);
  assert.deepEqual(lead.inbox, [], "the notice is held behind the hold with the rest");
  mock.timers.tick(60_000);
  await settle();
  assert.equal(hq.inbox.length, 1, "once");
});

test("a worktree of a held project outside its folder starts no seat; a cap the owner raises in the policy file lifts the hold with no restart", async () => {
  git(capped, "init", "-q");
  writeFileSync(join(capped, "README.md"), "capped\n");
  git(capped, "add", "README.md");
  git(capped, "commit", "-qm", "base");
  const outside = join(PROJECT, "..", "budget-capped-wt");
  git(capped, "worktree", "add", "-q", outside);
  await assert.rejects(
    async () => call("before agent.create", createRequest("claude-peer", outside), context),
    /claude-peer refused: .*budget-capped is held by the room's budget/,
  );

  editPolicy((policy) => void (policy.budget.projects = { [capped]: { dailyUsd: 10 } }));
  mock.timers.tick(60_000);
  await settle();
  await call("before agent.create", createRequest("claude-peer", capped), context);
  await call("before agent.create", createRequest("claude-peer", outside), context);
});
