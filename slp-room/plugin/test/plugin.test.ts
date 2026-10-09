import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";

type Hook = (input: never, context: never) => unknown;

const hooks = new Map<string, Hook>();
const server = {
  before: (name: string, hook: Hook) => void hooks.set(`before ${name}`, hook),
  on: (name: string, hook: Hook) => void hooks.set(`on ${name}`, hook),
};
const call = (name: string, input: unknown, context: unknown = {}) => hooks.get(name)!(input as never, context as never);

const runtimes = join(ROOM_HOME, "runtimes");
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-supervisor", "claude-lead", "claude-peer", "pi-peer"]);
  chmodSync(ROOM_HOME, 0o755); // as a room home made under the usual umask
  mkdirSync(runtimes);
  writeFileSync(join(runtimes, "pi"), ""); // no Pi runtime can be built while this file is in the way
  console.log = console.error = () => {};
  dispose = contribute(server as never);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

function createRequest(provider: string) {
  return { request: { config: { provider, cwd: PROJECT, title: "[Peer] task" }, env: {} } };
}

test("the plugin makes the room home private to its owner", () => {
  assert.equal(statSync(ROOM_HOME).mode & 0o077, 0);
});

test("a seat whose runtime cannot be built is refused, and created on its own home once it can", async () => {
  await assert.rejects(async () => call("before agent.create", createRequest("pi-peer")), /pi-peer/);

  rmSync(join(runtimes, "pi"));
  const created = (await call("before agent.create", createRequest("pi-peer"))) as { env: Record<string, string> };
  assert.equal(created.env.PI_CODING_AGENT_DIR, join(runtimes, "pi", "peer"));
  assert.ok(existsSync(join(created.env.PI_CODING_AGENT_DIR, "settings.json")));
});

// the daemon's agents; the plugin keeps the first Paseo client a hook hands it
const agents: Record<string, object> = {};
const context = { paseo: { agents: { ref: (id: string) => agents[id] } } };

for (const archive of ["works", "fails"] as const) {
  test(`a seat created outside the spawn rules: its creator is told what happened when the archive ${archive}`, async () => {
    const parent = `lead-${archive}`;
    const child = `second-lead-${archive}`;
    const toParent: string[] = [];
    agents[parent] = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async (text: string) => void toParent.push(text) };
    agents[child] = {
      archive: async () => {
        if (archive === "fails") throw new Error("daemon busy");
      },
    };
    const created = (id: string, parentAgentId: string | null) => ({ agent: { id, parentAgentId, provider: "claude-lead", cwd: PROJECT, title: "[Lead] stream", workspaceId: null } });

    await call("on agent.created", created(parent, null), context);
    await call("on agent.created", created(child, parent), context); // a Lead may not create a Lead

    assert.equal(toParent.length, 1);
    const [notice] = toParent;
    assert.match(notice, /SPAWN REFUSED/);
    if (archive === "works") {
      assert.match(notice, /The room archived it/);
      assert.match(notice, /may have started/); // Paseo sends the first prompt without waiting for this hook
    } else {
      assert.match(notice, /could not archive it/);
      assert.match(notice, /daemon busy/);
      assert.doesNotMatch(notice, /The room archived it/);
    }
  });
}

/* ---------- seats that talk: created through the plugin's hooks, mailing through its MCP server ---------- */

interface TestSeat {
  agent: { id: string; parentAgentId: string | null; provider: string; cwd: string; title: string; workspaceId: null };
  /** Every prompt the room started this seat with. */
  inbox: string[];
  prompt: string;
  mail(args: Record<string, unknown>): Promise<string>;
}

async function seat(id: string, provider: string, parentAgentId: string | null, title: string): Promise<TestSeat> {
  const made = (await call("before agent.create", { request: { config: { provider, cwd: PROJECT, title }, env: {} } })) as {
    env: Record<string, string>;
    config: { systemPrompt: string; mcpServers: { slp: { url: string } } };
  };
  await call("before agent.session_open", { request: { env: made.env, reason: "create", agentId: id } });
  const inbox: string[] = [];
  agents[id] = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async (text: string) => void inbox.push(text) };
  const agent = { id, parentAgentId, provider, cwd: PROJECT, title, workspaceId: null };
  await call("on agent.created", { agent }, context);
  const mail = async (args: Record<string, unknown>) => {
    const response = await fetch(made.config.mcpServers.slp.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slp_mail", arguments: args } }),
    });
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
    if (result.isError) throw new Error(result.content[0].text);
    return result.content[0].text;
  };
  return { agent, inbox, prompt: made.config.systemPrompt, mail };
}

function turnEnds(who: TestSeat, finalMessage: string, outcome: object = { kind: "completed" }) {
  return call("on agent.turn_ended", { agent: who.agent, turnId: null, outcome, timeline: finalMessage ? [{ type: "assistant_message", text: finalMessage }] : [] }, context);
}

const mailId = (envelope: string) => /SLP MAIL #(\S+)/.exec(envelope)![1];

test("a Peer's own REVIEW mail reaches its Lead once, and only when the Peer's turn has ended", async () => {
  const lead = await seat("lead-report", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-report", "claude-peer", lead.agent.id, "[Peer:review] candidate");

  await peer.mail({ to: "owner", subject: "REVIEW: abc123 PASS", body: "REVIEW\nVerdict: ACCEPTABLE", needs: "nothing" });
  assert.deepEqual(lead.inbox, [], "the Lead was started while the Peer was still in its turn");

  await turnEnds(peer, "REVIEW\nVerdict: ACCEPTABLE\nRECAP: reviewed abc123 → acceptable");
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /re: REVIEW: abc123 PASS/);
  assert.doesNotMatch(lead.inbox[0], /DIGEST/, "the Lead got the same report twice");
});

test("a report a seat mailed itself still reaches its Owner when the turn is cut short", async () => {
  const lead = await seat("lead-cut", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-cut", "claude-peer", lead.agent.id, "[Peer] task");

  await peer.mail({ to: "owner", subject: "CANDIDATE: hours unit", body: "CANDIDATE\nsha abc123", needs: "reply" });
  await turnEnds(peer, "", { kind: "canceled", reason: "archived" });

  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /re: CANDIDATE: hours unit/);
});

test("a seat that mailed its signal to its Owner is not reported a second time when its turn ends", async () => {
  const lead = await seat("lead-once", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-once", "claude-peer", lead.agent.id, "[Peer] task");

  await peer.mail({ to: "owner", subject: "QUESTION: which unit", body: "QUESTION\nseconds or minutes?", needs: "decision" });
  assert.equal(lead.inbox.length, 1, "a question asked mid-work goes out at once");

  await turnEnds(peer, "QUESTION\nseconds or minutes?\nRECAP: asked the Owner → waiting");
  assert.equal(lead.inbox.length, 1);
});

test("a DONE repeated after a mail that asked nothing does not start the Owner's turn again, and is not lost", async () => {
  const supervisor = await seat("supervisor-echo", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-echo", "claude-lead", supervisor.agent.id, "[Lead] stream");

  await turnEnds(lead, "DONE\noutcome accepted on the integrated state\nRECAP: closed the workstream → accepted");
  assert.equal(supervisor.inbox.length, 1);

  await supervisor.mail({ to: lead.agent.id, subject: "ACCEPT: closed at abc123", body: "ACCEPT. Nothing is needed back.", needs: "nothing", priority: "fyi" });
  assert.equal(lead.inbox.length, 1);
  await turnEnds(lead, "DONE\nthe Owner accepted; nothing further\nRECAP: read the acceptance → closed");
  assert.equal(supervisor.inbox.length, 1, "the Supervisor was started for a DONE it already had");

  await turnEnds(lead, "DECISION_NEEDED\na caller outside the repository depends on the old behavior\nRECAP: found a caller → decision needed");
  assert.equal(supervisor.inbox.length, 2);
  assert.match(supervisor.inbox[1], /DIGEST — 2 messages/);
});

test("a Peer's ACK does not start its Lead's turn; the Lead reads it with its next mail", async () => {
  const lead = await seat("lead-ack", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-ack", "claude-peer", lead.agent.id, "[Peer] task");

  await turnEnds(peer, "CANDIDATE\nsha abc123\nRECAP: added the unit → abc123");
  assert.equal(lead.inbox.length, 1);
  await lead.mail({ reply_to: mailId(lead.inbox[0]), subject: "ACCEPT abc123: contract holds", body: "ACCEPT abc123: contract holds; write ownership released.", needs: "nothing" });
  assert.equal(peer.inbox.length, 1);

  await peer.mail({ reply_to: mailId(peer.inbox[0]), subject: "ACK", body: "ACK", needs: "nothing" });
  await turnEnds(peer, "ACK");
  assert.equal(lead.inbox.length, 1, "an acknowledgement started the Lead's turn");

  await turnEnds(peer, "BLOCKED\nthe tree changed under me\nRECAP: saw foreign edits → stopped");
  assert.equal(lead.inbox.length, 2);
  assert.match(lead.inbox[1], /DIGEST — 2 messages/);
  assert.match(lead.inbox[1], /re: ACK/);
});

test("a Supervisor's prompt names no path of the room's own files", async () => {
  const supervisor = await seat("supervisor-header", "claude-supervisor", null, "[Supervisor] project");
  assert.ok(!supervisor.prompt.includes(ROOM_HOME), "the seat header points a project seat at the room home, where the other roles' files live");
});
