import { installRoom, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";

/** A room set up with its own seat alone: every district must run with no worker seat. */

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
const agents: Record<string, object> = {};
const listed = async () => ({
  entries: Object.keys(agents).map((id) => ({ agent: { id, status: "idle", updatedAt: new Date().toISOString() } })),
});
const context = {
  paseo: {
    agents: { ref: (id: string) => agents[id], list: listed },
    projects: { list: async () => ({ projects: [] }) },
  },
};
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-hq"]);
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

/** Starts a seat through the app's hooks and returns a caller of its tools. */
async function open(id: string, provider: string, title: string, cwd: string) {
  const made = (await call("before agent.create", { request: { config: { provider, cwd, title }, env: {} } })) as {
    env: Record<string, string>;
    config: { mcpServers: { seatwork: { url: string } } };
  };
  await call("before agent.session_open", { request: { env: made.env, reason: "create", agentId: id, provider } });
  agents[id] = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async () => {} };
  const agent = { id, parentAgentId: null, provider, cwd, title, workspaceId: null };
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
  return { agent, tool };
}

test("with its own seat alone the room starts, the seat runs it, records the room's decisions, and lists projects", async () => {
  const hq = await open("hq-alone", "claude-hq", "HQ", join(ROOM_HOME, "hq-seatwork"));
  const health = JSON.parse(await hq.tool("seatwork_room", { do: "health" }));
  assert.deepEqual(health.readings, ["jev", "knowledge", "skills", "mail", "safety", "seats", "host", "budget"]);
  for (const reading of health.readings) assert.ok(JSON.parse(await hq.tool("seatwork_room", { do: reading })));
  await call("on agent.turn_started", { agent: hq.agent, turnId: "t1" }, context);
  const decided = JSON.parse(
    await hq.tool("seatwork_knowledge", {
      do: "decide",
      scope: "room",
      topic: "jev spend",
      statement: "Keep the decision model under five dollars a month.",
    }),
  );
  assert.equal(decided.state, "pending");
  await call(
    "on agent.turn_ended",
    {
      agent: hq.agent,
      turnId: "t1",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "giữ Jev dưới 5 đô một tháng" },
        { type: "assistant_message", text: "Recorded." },
      ],
    },
    context,
  );
  const list = JSON.parse(await hq.tool("seatwork_knowledge", { do: "list" }));
  assert.match(list.inForce[0], /jev-spend: Keep the decision model under five dollars a month/);
  assert.match(await hq.tool("seatwork_projects", {}), /\S/);
});

test("a worker seat the room has not set up is refused at its start, and the room goes on", async () => {
  await assert.rejects(
    () => open("lead-none", "claude-lead", "[Lead] x", join(ROOM_HOME, "hq-seatwork")),
    /not a seat the room has set up/,
  );
  const hq = await open("hq-again", "claude-hq", "HQ", join(ROOM_HOME, "hq-seatwork"));
  assert.ok(JSON.parse(await hq.tool("seatwork_room", { do: "policy" })).tunable);
});
