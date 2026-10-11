import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import { bash, BRIEF, edit, prompt, say } from "./support/watch";
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
  // the watcher mails in these tests; a room as installed only logs what it finds
  installRoom(["claude-supervisor", "claude-lead", "claude-peer", "pi-peer"], (policy) => void (policy.watcher.mode = "on"));
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
  /** What slp_inbox hands this seat. */
  held(): Promise<string>;
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
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(made.config.mcpServers.slp.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const { result } = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
    if (result.isError) throw new Error(result.content[0].text);
    return result.content[0].text;
  };
  return { agent, inbox, prompt: made.config.systemPrompt, mail: (args) => tool("slp_mail", args), held: () => tool("slp_inbox", {}) };
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

/** What the daemon would hand the watcher for this seat's turn. */
function hasTimeline(who: TestSeat, entries: object[]) {
  Object.assign(agents[who.agent.id], { timeline: { refetch: async () => ({ entries, agent: { pendingPermissions: [] } }) } });
}

test("what the watcher saw in a Peer's turn reaches its Lead in the same prompt as the Peer's report", async () => {
  const lead = await seat("lead-watch", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-watch", "claude-peer", lead.agent.id, "[Peer] hours");
  hasTimeline(peer, [prompt(BRIEF), edit(join(PROJECT, "src/billing.js")), bash("npm test"), say("CANDIDATE: hours added")]);

  await call("on agent.turn_started", { agent: peer.agent, turnId: "turn-1" }, context);
  await turnEnds(peer, "CANDIDATE: hours added");

  assert.equal(lead.inbox.length, 1, "the notice and the report each started a turn of the Lead");
  assert.match(lead.inbox[0], /from room re: OBSERVATION: peer \[Peer\] hours changed src\/billing\.js; its write scope is src\/duration\.js, test\/\*\*/);
  assert.match(lead.inbox[0], /re: CANDIDATE from peer/);
});

test("a notice about a turn that sends no report of its own still reaches the Lead", async () => {
  const lead = await seat("lead-alone", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-alone", "claude-peer", lead.agent.id, "[Peer] hours");
  hasTimeline(peer, [prompt(BRIEF), edit(join(PROJECT, "src/billing.js")), say("ACK")]);

  await turnEnds(peer, "ACK");

  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /OBSERVATION: peer \[Peer\] hours changed src\/billing\.js/);
});

test("a Lead is told at once when the Peer it created starts on a brief that lacks its last line", async () => {
  const lead = await seat("lead-brief", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-brief", "claude-peer", lead.agent.id, "[Peer] hours");
  hasTimeline(peer, [prompt(BRIEF.replace(/\nReply with slp_mail to: owner/, ""))]);

  await call("on agent.turn_started", { agent: peer.agent, turnId: "turn-1" }, context);
  for (let waited = 0; lead.inbox.length === 0 && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /from room re: OBSERVATION: peer \[Peer\] hours was briefed without these template lines: Reply with slp_mail to: owner/);
  assert.match(lead.inbox[0], /REVISED BRIEF/);
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

test("a Lead's first STATUS starts its Supervisor's turn; a later one waits, and a report that asks something takes its place", async () => {
  const supervisor = await seat("supervisor-status", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-status", "claude-lead", supervisor.agent.id, "[Lead] stream");

  await turnEnds(lead, "STATUS\nthe plan is written and one Peer runs\nRECAP: planned → Peer launched");
  assert.equal(supervisor.inbox.length, 1, "the first report carries the plan: the Supervisor reads it at once");

  await turnEnds(lead, "STATUS\nthe first lens reported; waiting for the second\nRECAP: read one lens → waiting");
  await turnEnds(lead, "STATUS\nboth lenses reported; the Peer repairs\nRECAP: rejected → Peer repairing");
  assert.equal(supervisor.inbox.length, 1, "a progress report started the Supervisor's turn");

  await turnEnds(lead, "DECISION_NEEDED\ncallers may run at the same time; the brief does not say\nRECAP: found a gap → decision needed");
  assert.equal(supervisor.inbox.length, 2);
  assert.match(supervisor.inbox[1], /re: DECISION_NEEDED from lead/);
  assert.doesNotMatch(supervisor.inbox[1], /lens reported|lenses reported/, "a progress report older than the report beside it was delivered");
});

test("of a Lead's waiting STATUS reports the inbox hands out the newest only", async () => {
  const supervisor = await seat("supervisor-inbox", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-inbox", "claude-lead", supervisor.agent.id, "[Lead] stream");

  await turnEnds(lead, "STATUS\nthe plan is written\nRECAP: planned → Peer launched");
  await turnEnds(lead, "STATUS\nthe first lens reported\nRECAP: read one lens → waiting");
  await turnEnds(lead, "STATUS\nboth lenses reported\nRECAP: rejected → Peer repairing");

  const held = await supervisor.held();
  assert.match(held, /both lenses reported/);
  assert.doesNotMatch(held, /the first lens reported/);
  assert.equal(await supervisor.held(), "inbox empty");
});

test("a HOLD that asks nothing of a Peer whose candidate is under review waits for the verdict; one that answers a challenge reaches the Peer at once", async () => {
  const lead = await seat("lead-hold", "claude-lead", null, "[Lead] stream");
  const waiting = await seat("peer-hold", "claude-peer", lead.agent.id, "[Peer] task");
  const stopped = await seat("peer-stopped", "claude-peer", lead.agent.id, "[Peer] other task");

  await turnEnds(waiting, "CANDIDATE\nsha abc123\nRECAP: added the unit → abc123");
  await lead.mail({ reply_to: mailId(lead.inbox[0]), subject: "HOLD abc123: inspected, with two lenses", body: "abc123 received; the tree stays frozen. Nothing to do now.", needs: "nothing", priority: "fyi" });
  assert.deepEqual(waiting.inbox, [], "a receipt started a turn of a Peer that has nothing to do");

  await lead.mail({ to: waiting.agent.id, subject: "REJECT abc123: one repair", body: "REJECT abc123: the unit is not printed back.", needs: "reply" });
  assert.equal(waiting.inbox.length, 1);
  assert.match(waiting.inbox[0], /DIGEST — 2 messages/);
  assert.match(waiting.inbox[0], /re: HOLD abc123/);

  await turnEnds(stopped, "REOPEN_REQUEST\nthe contract line is false on this input\nRECAP: ran the input → asked to reopen");
  await lead.mail({ reply_to: mailId(lead.inbox[1]), subject: "HOLD: candidate stands", body: "HOLD: candidate stands. The line holds for the inputs the outcome names.", needs: "nothing" });
  assert.equal(stopped.inbox.length, 1, "a Peer stopped on its challenge did not get the answer");
  assert.match(stopped.inbox[0], /BLOCKING from owner re: HOLD: candidate stands/);
});

test("a Supervisor's prompt names no path of the room's own files", async () => {
  const supervisor = await seat("supervisor-header", "claude-supervisor", null, "[Supervisor] project");
  assert.ok(!supervisor.prompt.includes(ROOM_HOME), "the seat header points a project seat at the room home, where the other roles' files live");
});
