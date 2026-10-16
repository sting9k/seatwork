import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import contribute from "../index.server";
import { roomProjectDir } from "../server/orchestration/registry";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-hq", "claude-lead", "claude-peer"]);
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  // a service error is tried again at the next minute's sweep
  policy.room.recovery.delaysSeconds = [0, 0, 0];
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
const context = { paseo: { agents: { ref: (id: string) => agents[id] } } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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
    current: () => ({ status: "idle", provider }),
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
  const fails = (message: string) =>
    call(
      "on agent.turn_ended",
      { agent, turnId: null, outcome: { kind: "failed", error: { message } }, timeline: [] },
      context,
    );
  return { inbox, call: tool, fails };
}

test("a seat whose turn failed on the service is still resumed after the operator read how many wait", async () => {
  const hq = await seat("hq-recovery", "claude-hq", null, "[HQ] room", roomProjectDir());
  const lead = await seat("lead-recovery", "claude-lead", null, "[Lead] stream", PROJECT);
  const peer = await seat("peer-recovery", "claude-peer", "lead-recovery", "[Peer] store", PROJECT);

  await peer.fails("API Error: 529 Overloaded");
  const waiting = async () =>
    (JSON.parse(await hq.call("seatwork_room", { do: "seats" })) as Record<string, unknown>).seats;
  assert.deepEqual(await waiting(), { retrying: 1 });
  assert.deepEqual(await waiting(), { retrying: 1 }, "a reading took the retry it counted");

  mock.timers.tick(60_000);
  for (let waited = 0; peer.inbox.length === 0 && waited < 100; waited += 1) await settle();
  assert.equal(peer.inbox.length, 1);
  assert.match(peer.inbox[0], /subject="RESUME: /);
  assert.deepEqual(lead.inbox, [], "nobody above is told of a failure the room mends");
});
