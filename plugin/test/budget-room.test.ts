import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import contribute from "../index.server";
import { roomProjectDir } from "../server/orchestration/registry";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

const project = (name: string) => {
  const dir = join(PROJECT, "..", name);
  mkdirSync(join(dir, ".seatwork"), { recursive: true });
  writeFileSync(join(dir, ".seatwork", "room.json"), "{}");
  return realpathSync(dir);
};
const capped = project("budget-capped");
const free = project("budget-free");

before(() => {
  installRoom(["claude-hq", "claude-lead", "claude-peer"]);
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.budget = { projects: { [capped]: { dailyUsd: 1 } } };
  writeFileSync(file, JSON.stringify(policy));
  console.log = console.error = () => {};
  mock.timers.enable({ apis: ["setInterval"] });
  dispose = contribute(paseoSide.server);
});

after(async () => {
  mock.timers.reset();
  await dispose();
  Object.assign(console, output);
});

const agents: Record<string, object> = {};
const costs: Record<string, number> = {};
const listed = async () => ({
  entries: Object.entries(agents).flatMap(([id, handle]) => {
    const now = (handle as { current?: () => object }).current?.();
    return now ? [{ agent: { id, updatedAt: new Date().toISOString(), ...now } }] : [];
  }),
});
const context = { paseo: { agents: { ref: (id: string) => agents[id], list: listed } } };

/** A seat the room knows, open on the stand-in app, with the MCP tools it calls. */
async function seat(id: string, provider: string, parent: string | null, title: string, cwd: string) {
  const made = (await call("before agent.create", { request: { config: { provider, cwd, title }, env: {} } })) as {
    env: Record<string, string>;
    config: { mcpServers: { seatwork: { url: string } } };
  };
  await call("before agent.session_open", { request: { env: made.env, reason: "create", agentId: id, provider } });
  const inbox: string[] = [];
  agents[id] = {
    refresh: async () => {},
    current: () => ({ status: "idle", provider, ...(id in costs ? { lastUsage: { totalCostUsd: costs[id] } } : {}) }),
    send: async (text: string) => void inbox.push(text),
  };
  const agent = { id, parentAgentId: parent, provider, cwd, title, workspaceId: null };
  await call("on agent.created", { agent }, context);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(made.config.mcpServers.seatwork.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
    if (result.isError) throw new Error(result.content[0].text);
    return result.content[0].text;
  };
  const endsTurn = (message: string, cost: number) => {
    costs[id] = cost;
    return call(
      "on agent.turn_ended",
      {
        agent,
        turnId: null,
        outcome: { kind: "completed" },
        timeline: [{ type: "assistant_message", text: message }],
      },
      context,
    );
  };
  return { agent, inbox, call: tool, endsTurn };
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

  // the minute: the operator hears of the hold, the project's top seat gets its quiet notice
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
