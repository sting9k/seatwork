import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import { bash, BRIEF, edit, prompt, say } from "./support/watch";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const { call } = paseoSide;

const runtimes = join(ROOM_HOME, "runtimes");
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  // the watcher mails in these tests; a room as installed only logs what it finds
  installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "pi-peer", "codex-peer", "codex-lens", "claude-lens"], (policy) => void (policy.watcher.mode = "on"));
  chmodSync(ROOM_HOME, 0o755); // as a room home made under the usual umask
  // this room's owner gave the Peer one more model, on Pi
  const table = join(ROOM_HOME, "room", "models.json");
  const models = JSON.parse(readFileSync(table, "utf8"));
  models.peer.tiers.long = { providers: ["pi-peer/m-one"], thinking: "default", use: "the long jobs", never: "—" };
  writeFileSync(table, JSON.stringify(models));
  mkdirSync(runtimes);
  writeFileSync(join(runtimes, "pi"), ""); // no Pi runtime can be built while this file is in the way
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
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

/** The env Paseo launches a session with after the room's hook: on a reopening Paseo itself hands in none. */
async function opened(provider: string, reason: string, env: Record<string, string> = {}): Promise<Record<string, string>> {
  const request = { agentId: `opened-${provider}`, workspaceId: null, provider, cwd: PROJECT, reason, purpose: "interactive", env };
  return ((await call("before agent.session_open", { request })) as { env: Record<string, string> }).env;
}

test("Paseo's Usage screen is offered one account, the watcher's month against the policy's cap, and none for a single session", async () => {
  const { monthlyCapUsd } = JSON.parse(readFileSync(join(ROOM_HOME, "policy.json"), "utf8")).watcher.budget;

  assert.deepEqual((await paseoSide.usage()!.discover({ kind: "global" })).map((account) => account.key), ["decision-model"]);
  assert.deepEqual(await paseoSide.usage()!.discover({ kind: "session", provider: "claude", env: {} }), []);
  const report = await paseoSide.usage()!.fetch({});
  assert.equal(report.status, "available");
  assert.equal(report.balances?.[0].limit, monthlyCapUsd);
});

test("a seat whose runtime cannot be built is refused, and created on its own home once it can", async () => {
  await assert.rejects(async () => call("before agent.create", createRequest("pi-peer")), /pi-peer refused: its runtime could not be built/);
  await assert.rejects(async () => opened("pi-peer", "resume"), "a seat without its home was reopened, on the user's");

  rmSync(join(runtimes, "pi"));
  const created = (await call("before agent.create", createRequest("pi-peer"))) as { env: Record<string, string> };
  const env = await opened("pi-peer", "create", created.env);
  assert.equal(env.PI_CODING_AGENT_DIR, join(runtimes, "pi", "peer"));
  assert.ok(existsSync(join(env.PI_CODING_AGENT_DIR, "settings.json")));
});

test("a Claude seat is created with the policy's launch flags and its role's skills, beside what its creator asked for", async () => {
  const asked = { extraArgs: { debug: null }, additionalDirectories: ["/elsewhere"] };
  const request = { request: { config: { provider: "claude-peer", cwd: PROJECT, title: "[Peer] task", providerOptions: asked }, env: {} } };
  const created = (await call("before agent.create", request)) as { config: { providerOptions: typeof asked } };

  assert.deepEqual(created.config.providerOptions.extraArgs, { debug: null, "setting-sources": "project,local", "strict-mcp-config": null });
  assert.deepEqual(created.config.providerOptions.additionalDirectories, ["/elsewhere", join(ROOM_HOME, "role-skills", "claude", "peer")]);
});

test("a new seat is held to the model table in force, whatever its creator's prompt still says", async () => {
  const create = async (provider: string, model: string | undefined, cwd = PROJECT) =>
    ((await call("before agent.create", { request: { config: { provider, cwd, title: "[Lead] work", model, thinkingOptionId: "low" }, env: {} } })) as { config: { model?: string; thinkingOptionId?: string } }).config;
  const onto = async (provider: string, model: string | undefined, cwd?: string) => (({ model: m, thinkingOptionId: t }) => [m, t])(await create(provider, model, cwd));

  // a role with one model starts on it; a Peer on a model the table lists is left as asked
  assert.deepEqual(await onto("claude-lead", "claude-haiku-5-5"), ["claude-opus-5-5", "high"]);
  assert.deepEqual(await onto("claude-lead", "claude-opus-5-5"), ["claude-opus-5-5", "low"]);
  assert.deepEqual(await onto("claude-peer", "claude-sonnet-5-5"), ["claude-sonnet-5-5", "low"]);
  await assert.rejects(create("claude-peer", "claude-opus-5-5"), /claude-peer\/claude-opus-5-5 refused: the room's table lists for peer only claude-peer\/claude-haiku-5-5, .*Create the seat again/);

  // a project with a table of its own: its differences decide there, and only there
  const shop = join(PROJECT, "..", "shop");
  mkdirSync(join(shop, ".seatwork"), { recursive: true });
  writeFileSync(join(shop, ".seatwork", "room.json"), JSON.stringify({ models: { seats: { lead: { provider: "claude-lead/claude-sonnet-5-5", thinking: "medium" } }, peer: { tiers: { default: null } } } }));
  assert.deepEqual(await onto("claude-lead", "claude-opus-5-5", shop), ["claude-sonnet-5-5", "medium"]);
  await assert.rejects(create("claude-peer", "claude-sonnet-5-5", shop), /project shop lists for peer only .*\.seatwork\/room\.json/);
  assert.deepEqual(await onto("claude-lead", "claude-opus-5-5"), ["claude-opus-5-5", "low"]);
});

/** What a Claude seat starts with so that Claude Code adds nothing of its own. */
const CLAUDE_SWITCHES = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
  CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

test("a seat's session opens with the seat's own environment every time, not only when the seat is created", async () => {
  for (const reason of ["resume", "refresh", "import"]) {
    assert.deepEqual(await opened("pi-peer", reason), { PI_CODING_AGENT_DIR: join(runtimes, "pi", "peer") }, reason);
    assert.deepEqual(await opened("claude-peer", reason), CLAUDE_SWITCHES, reason);
  }
  // an agent that is no seat of the room keeps what it came with
  assert.deepEqual(await opened("claude", "resume", { MINE: "1" }), { MINE: "1" });
});

// the daemon's agents; the plugin keeps the first Paseo client a hook hands it
const agents: Record<string, object> = {};
/** What the daemon lists: every agent it still has that is not archived. */
const listed = async () => ({
  entries: Object.entries(agents).flatMap(([id, handle]) => {
    const now = (handle as { current?: () => { status?: string; archivedAt?: string } | null }).current?.();
    return now && !now.archivedAt ? [{ agent: { id, updatedAt: new Date().toISOString(), ...now } }] : [];
  }),
});
const context = { paseo: { agents: { ref: (id: string) => agents[id], list: listed } } };

// a seat as the daemon reports it: deleted, archived, or not reported at all
const deleted = { refresh: async () => null, current: () => null };
const archived = { refresh: async () => {}, current: () => ({ status: "idle", archivedAt: "2026-10-01T00:00:00Z" }) };
const silent = { refresh: () => Promise.reject(new Error("connection lost")), current: () => null };

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
  inbox: string[];
  prompt: string;
  mail(args: Record<string, unknown>): Promise<string>;
  /** What seatwork_inbox hands this seat. */
  held(): Promise<string>;
  adopt(agentId: string): Promise<string>;
}

async function seat(id: string, provider: string, parentAgentId: string | null, title: string, cwd = PROJECT): Promise<TestSeat> {
  const made = (await call("before agent.create", { request: { config: { provider, cwd, title }, env: {} } })) as {
    env: Record<string, string>;
    config: { systemPrompt: string; mcpServers: { seatwork: { url: string } } };
  };
  await call("before agent.session_open", { request: { env: made.env, reason: "create", agentId: id, provider } });
  const inbox: string[] = [];
  agents[id] = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async (text: string) => void inbox.push(text) };
  const agent = { id, parentAgentId, provider, cwd, title, workspaceId: null };
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
  return { agent, inbox, prompt: made.config.systemPrompt, mail: (args) => tool("seatwork_mail", args), held: () => tool("seatwork_inbox", {}), adopt: (agentId) => tool("seatwork_adopt", { agent_id: agentId }) };
}

function turnEnds(who: TestSeat, finalMessage: string, outcome: object = { kind: "completed" }) {
  return call("on agent.turn_ended", { agent: who.agent, turnId: null, outcome, timeline: finalMessage ? [{ type: "assistant_message", text: finalMessage }] : [] }, context);
}

const mailId = (envelope: string) => /SEATWORK MAIL #(\S+)/.exec(envelope)![1];

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

test("what the room kept for a turn does not outlive the runtime that closed in it", async () => {
  const supervisor = await seat("supervisor-closed", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-closed", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const peer = await seat("peer-closed", "claude-peer", lead.agent.id, "[Peer] task");
  const closes = (who: TestSeat) => call("on agent.closed", { agent: who.agent }, context);

  // the Peer asked in mid-turn, then its runtime closed: Paseo sends that turn no end
  await peer.mail({ to: "owner", subject: "QUESTION: which unit", body: "QUESTION\nseconds or minutes?", needs: "decision" });
  await closes(peer);
  await turnEnds(peer, "QUESTION\nand which rounding?\nRECAP: asked the Owner → waiting");
  assert.equal(lead.inbox.length, 2, "a question from the reopened Peer was taken for the one it had mailed before");

  // a turn started by mail that asked nothing closes the same way
  await turnEnds(lead, "DONE\noutcome accepted on the integrated state\nRECAP: closed the workstream → accepted");
  await supervisor.mail({ to: lead.agent.id, subject: "ACCEPT: closed at abc123", body: "ACCEPT. Nothing is needed back.", needs: "nothing", priority: "fyi" });
  await closes(lead);
  await turnEnds(lead, "DONE\nthe Owner asked for the sha: abc123\nRECAP: answered → abc123");
  assert.equal(supervisor.inbox.length, 2, "a DONE in a turn no mail started was held back as an echo");
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
  hasTimeline(peer, [prompt(BRIEF.replace(/\nReply with seatwork_mail to: owner/, ""))]);

  await call("on agent.turn_started", { agent: peer.agent, turnId: "turn-1" }, context);
  for (let waited = 0; lead.inbox.length === 0 && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /from room re: OBSERVATION: peer \[Peer\] hours was briefed without these template lines: Reply with seatwork_mail to: owner/);
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

test("mail to a seat that is archived, or that the daemon no longer has, is refused and nothing is sent", async () => {
  for (const [state, gone] of Object.entries({ archived, deleted })) {
    const lead = await seat(`lead-to-${state}`, "claude-lead", null, "[Lead] stream");
    const peer = await seat(`peer-${state}`, "claude-peer", lead.agent.id, "[Peer] task");
    agents[peer.agent.id] = gone;

    await assert.rejects(lead.mail({ to: peer.agent.id, subject: "ANSWER: seconds", body: "ANSWER\nseconds", needs: "reply" }), /refused: peer-\S+ is archived or gone; nothing was sent/, state);
    assert.deepEqual(lead.inbox, [], `${state}: the mail was taken, then came back as undeliverable`);
  }
});

test("a seat is handed over when its owner is gone or the new owner is in its chain; from then on it reports to the new owner", async () => {
  const cases = [
    // what the daemon says of the old owner (null: alive), whether both Leads share a Supervisor, the refusal
    { name: "deleted", owner: deleted, shared: false, refused: null },
    { name: "archived", owner: archived, shared: false, refused: null },
    { name: "alive", owner: null, shared: false, refused: /still reports to a live seat/ },
    // a daemon that does not answer proves nothing about the owner
    { name: "silent", owner: silent, shared: false, refused: /still reports to a live seat/ },
    { name: "shared", owner: null, shared: true, refused: null },
  ];
  for (const { name, owner, shared, refused } of cases) {
    const above = shared ? (await seat(`supervisor-adopt-${name}`, "claude-supervisor", null, "[Supervisor] project")).agent.id : null;
    const old = await seat(`lead-old-${name}`, "claude-lead", above, "[Lead] stream");
    const successor = await seat(`lead-new-${name}`, "claude-lead", above, "[Lead] stream, continued");
    const peer = await seat(`peer-adopt-${name}`, "claude-peer", old.agent.id, "[Peer] task");
    if (owner) agents[old.agent.id] = owner;

    if (refused) {
      await assert.rejects(successor.adopt(peer.agent.id), refused, name);
      await assert.rejects(successor.mail({ to: peer.agent.id, subject: "ANSWER: seconds", body: "ANSWER\nseconds", needs: "nothing" }), /may write to its parent/, name);
      continue;
    }
    await successor.adopt(peer.agent.id);
    assert.match(peer.inbox[0], /OWNER CHANGED/, name);
    await peer.mail({ to: "owner", subject: "QUESTION: which unit", body: "QUESTION\nseconds or minutes?", needs: "decision" });
    assert.equal(successor.inbox.length, 1, name);
    assert.match(successor.inbox[0], /re: QUESTION: which unit/, name);
    assert.deepEqual(old.inbox, [], name);
  }
});

test("a seat that is gone is not handed over, and no seat is handed to a role that may not own it", async () => {
  const old = await seat("lead-old-gone", "claude-lead", null, "[Lead] stream");
  const successor = await seat("lead-new-gone", "claude-lead", null, "[Lead] stream, continued");
  const peer = await seat("peer-adopt-gone", "claude-peer", old.agent.id, "[Peer] task");
  const sibling = await seat("peer-sibling", "claude-peer", old.agent.id, "[Peer] other task");
  agents[old.agent.id] = archived;

  await assert.rejects(sibling.adopt(peer.agent.id), /a peer may own only nothing, not this peer/);

  agents[peer.agent.id] = deleted;
  await assert.rejects(successor.adopt(peer.agent.id), /peer-adopt-gone is archived or gone/);
});

test("what a turn leaves for the Owner is listed for the app until that seat works again or is gone, across a closed runtime and a plugin restart; a seat with a seat above it is not the Owner's", async () => {
  const supervisor = await seat("supervisor-owed", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-owed", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const waiting = async () => {
    const { waiting } = (await call("rpc room.waiting", {}, context)) as { waiting: { agentId: string; what: string }[] };
    return waiting.filter((item) => item.agentId.endsWith("-owed")).map((item) => `${item.agentId} ${item.what}`);
  };
  const starts = () => call("on agent.turn_started", { agent: supervisor.agent, turnId: "next" }, context);

  // a Lead's question goes to its Supervisor by mail
  await turnEnds(lead, "DECISION_NEEDED\ncallers may run at the same time; the brief does not say");
  assert.deepEqual(await waiting(), []);

  const cases: [message: string, outcome: object | undefined, listed: string | null][] = [
    ["DECISION_NEEDED\nkeep or break the old behavior?", undefined, "DECISION_NEEDED"],
    ["BLOCKED\nthe deploy key is missing", undefined, "BLOCKED"],
    ["STATUS\none workstream waits\nWAITING ON YOU: which region goes first", undefined, "WAITING ON YOU"],
    ["", { kind: "failed", error: { message: "the process exited" } }, "FAILED"],
    ["STATUS\none Lead is BLOCKED on a review; I answered it\nWORKING\n- Lead stream: repairing", undefined, null],
    ["DONE\nthe hours unit is accepted\nDONE: hours unit usable", undefined, null],
  ];
  for (const [message, outcome, listed] of cases) {
    await turnEnds(supervisor, message, outcome);
    assert.deepEqual(await waiting(), listed ? [`supervisor-owed ${listed}`] : [], message || "a failed turn");
    await starts();
    assert.deepEqual(await waiting(), [], "the seat is at work again, and still listed");
  }

  // a runtime that closes answers nothing: a daemon restart closes every seat
  await turnEnds(supervisor, "DECISION_NEEDED\nkeep or break the old behavior?");
  await call("on agent.closed", { agent: supervisor.agent }, context);
  assert.deepEqual(await waiting(), ["supervisor-owed DECISION_NEEDED"]);
  // nor does a plugin that starts again
  const again = fakeServer();
  const stop = contribute(again.server);
  const afterRestart = (await again.call("rpc room.waiting", {}, context)) as { waiting: { agentId: string }[] };
  await stop();
  assert.ok(afterRestart.waiting.some((item) => item.agentId === "supervisor-owed"), "a plugin restart forgot what waits on the Owner");

  await call("on agent.archived", { agent: supervisor.agent, archivedAt: "2026-10-12T00:00:00Z" }, context);
  assert.deepEqual(await waiting(), [], "an archived seat");
  await turnEnds(supervisor, "DECISION_NEEDED\nkeep or break the old behavior?");
  agents[supervisor.agent.id] = deleted;
  assert.deepEqual(await waiting(), [], "a seat the daemon no longer has");
});

test("the Room screen is given the seats that still exist, project by project with HQ first, and what waits on the Owner", async () => {
  const beta = join(ROOM_HOME, "project-beta");
  mkdirSync(beta);
  const registry = join(ROOM_HOME, "projects.json");
  writeFileSync(registry, JSON.stringify({ projects: [{ name: "alpha", cwd: PROJECT }, { name: "beta", cwd: beta }, { name: "gamma", cwd: join(ROOM_HOME, "project-gamma") }] }));
  try {
    const hq = await seat("hq-screen", "claude-hq", null, "HQ Supervisor", join(ROOM_HOME, "hq-seatwork"));
    const supervisor = await seat("supervisor-screen", "claude-supervisor", hq.agent.id, "[Supervisor] alpha");
    const lead = await seat("lead-screen", "claude-lead", supervisor.agent.id, "[Lead] stream");
    const peer = await seat("peer-screen", "claude-peer", lead.agent.id, "[Peer] hours");
    const gone = await seat("peer-screen-archived", "claude-peer", lead.agent.id, "[Peer] old task");
    await seat("supervisor-screen-beta", "claude-supervisor", null, "[Supervisor] beta", beta);
    agents[gone.agent.id] = archived;
    // the Lead is in a turn, so the Peer's report waits for it
    Object.assign(agents[lead.agent.id], { current: () => ({ status: "running" }) });
    await turnEnds(peer, "CANDIDATE\nsha abc123\nRECAP: added the unit → abc123");
    await turnEnds(supervisor, "DECISION_NEEDED\nkeep or break the old behavior?");

    const room = (await call("rpc room.status", {}, context)) as {
      waiting: { agentId: string; what: string; project: string }[];
      projects: { name: string; seats: { agentId: string; status: string; held: number; depth: number }[] }[];
    };
    const mine = (row: { agentId: string }) => row.agentId.includes("-screen");

    // one line per seat: indented by its depth, then its state and the mail held for it
    assert.deepEqual(
      room.projects.map((project) => [project.name, ...project.seats.filter(mine).map((row) => `${"  ".repeat(row.depth)}${row.agentId} ${row.status} ${row.held}`)]),
      [
        ["HQ", "hq-screen idle 0"],
        ["alpha", "supervisor-screen idle 0", "  lead-screen running 1", "    peer-screen idle 0"],
        ["beta", "supervisor-screen-beta idle 0"],
        ["gamma"], // registered, with no seat open
      ],
    );
    assert.deepEqual(room.waiting.filter(mine).map((item) => `${item.project} ${item.agentId} ${item.what}`), ["alpha supervisor-screen DECISION_NEEDED"]);
  } finally {
    rmSync(registry);
  }
});

test("a Supervisor's prompt names no path of the room's own files", async () => {
  const supervisor = await seat("supervisor-header", "claude-supervisor", null, "[Supervisor] project");
  assert.ok(!supervisor.prompt.includes(ROOM_HOME), "the seat header points a project seat at the room home, where the other roles' files live");
});
