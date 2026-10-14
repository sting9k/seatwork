import { installRoom, PROJECT } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, mock, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-lead", "claude-peer"]);
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
    current: () => ({ status: "idle" }),
    send: async (text: string) => void inbox.push(text),
  };
  await call(
    "on agent.created",
    { agent: { id, parentAgentId: parent, provider, cwd, title, workspaceId: null } },
    context,
  );
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
  return { inbox, call: tool };
}

test("a minute after a seat vanishes from the app's list, its claimed issue is open again and its Owner is told; a seat still listed keeps its claim", async () => {
  const project = join(PROJECT, "..", "lease-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  writeFileSync(join(project, ".seatwork", "room.json"), "{}");
  const lead = await seat("lead-lease", "claude-lead", null, "[Lead] store", project);
  const gone = await seat("peer-lease-gone", "claude-peer", "lead-lease", "[Peer] schema", project);
  const here = await seat("peer-lease-here", "claude-peer", "lead-lease", "[Peer] views", project);
  const issue = async (title: string) =>
    (JSON.parse(await lead.call("seatwork_work", { do: "create", title })) as { id: string }).id;
  const [first, second] = [await issue("schema"), await issue("views")];
  await gone.call("seatwork_work", { do: "claim", id: first });
  await here.call("seatwork_work", { do: "claim", id: second });

  // the time passes for both claims; the seat that is listed will be pushed on, the other will not
  const db = new DatabaseSync(join(project, ".seatwork", ".work", "work.db"));
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec("UPDATE issues SET lease_until = '2000-01-01T00:00:00.000Z'");
  delete agents["peer-lease-gone"];

  mock.timers.tick(60_000);
  for (let waited = 0; lead.inbox.length === 0 && waited < 200; waited += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));

  const rows = db.prepare("SELECT id, status, assignee, lease_until FROM issues").all() as {
    id: string;
    status: string;
    assignee: string | null;
    lease_until: string | null;
  }[];
  db.close();
  const row = (id: string) => rows.find((one) => one.id === id)!;
  assert.deepEqual([row(first).status, row(first).assignee, row(first).lease_until], ["open", null, null]);
  assert.deepEqual([row(second).status, row(second).assignee], ["in_progress", "peer-lease-here"]);
  assert.ok(Date.parse(row(second).lease_until!) > Date.now(), "the listed seat's lease was pushed on");
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="LEASE: 1 claimed issue went back to the board"/);
  assert.ok(lead.inbox[0].includes(first));
  assert.ok(!lead.inbox[0].includes(second));
  assert.match(await lead.call("seatwork_work", { do: "show", id: first }), /peer-lease-gone is gone/);
});
