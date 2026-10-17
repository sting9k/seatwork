import { deferred, PROJECT, ROOM_HOME } from "./support/room";
import { BRIEF, prompt } from "./support/timeline";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { incidentOf } from "../server/operations/lines";
import { loadPolicy } from "../server/policy";
import { rolePrompt } from "../server/orchestration/seats";
import { test } from "node:test";
import { repoWith } from "./support/git";
import { earnLevel3 } from "./support/council";
import { pluginRoom, withPlugin } from "./support/plugin";
import { SafetyStore } from "../server/safety/store";
import type { TestSeat } from "./support/seats";
import { DatabaseSync } from "node:sqlite";

const runtimes = join(ROOM_HOME, "runtimes");

const { call, agents, context, seat } = pluginRoom(
  ["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "pi-peer", "codex-peer", "opencode-peer"],
  {
    before: () => {
      chmodSync(ROOM_HOME, 0o755); // as a room home made under the usual umask
      // this room's owner gave the Peer one more model, on Pi and OpenCode
      const table = join(ROOM_HOME, "room", "models.json");
      const models = JSON.parse(readFileSync(table, "utf8"));
      models.peer.tiers.long = {
        providers: ["pi-peer/m-one", "opencode-peer/m-one"],
        thinking: "default",
        use: "the long jobs",
        never: "—",
      };
      writeFileSync(table, JSON.stringify(models));
      mkdirSync(runtimes);
      writeFileSync(join(runtimes, "pi"), ""); // no Pi runtime can be built while this file is in the way
    },
  },
);

function createRequest(provider: string) {
  return { request: { config: { provider, cwd: PROJECT, title: "[Peer] task" }, env: {} } };
}

test("the plugin makes the room home private to its owner", () => {
  assert.equal(statSync(ROOM_HOME).mode & 0o077, 0);
});

/** The env Paseo launches a session with after the room's hook: on a reopening Paseo itself hands in none. */
async function opened(
  provider: string,
  reason: string,
  env: Record<string, string> = {},
): Promise<Record<string, string>> {
  const request = {
    agentId: `opened-${provider}`,
    workspaceId: null,
    provider,
    cwd: PROJECT,
    reason,
    purpose: "interactive",
    env,
  };
  return ((await call("before agent.session_open", { request })) as { env: Record<string, string> }).env;
}

test("a seat whose runtime cannot be built is refused, and created on its own home once it can", async () => {
  await assert.rejects(
    async () => call("before agent.create", createRequest("pi-peer")),
    /pi-peer refused: its runtime could not be built/,
  );
  await assert.rejects(async () => opened("pi-peer", "resume"), "a seat without its home was reopened, on the user's");

  rmSync(join(runtimes, "pi"));
  const created = (await call("before agent.create", createRequest("pi-peer"))) as { env: Record<string, string> };
  const env = await opened("pi-peer", "create", created.env);
  assert.equal(env.PI_CODING_AGENT_DIR, join(runtimes, "pi", "peer"));
  assert.ok(existsSync(join(env.PI_CODING_AGENT_DIR, "settings.json")));
});

test("a Claude seat is created with the policy's launch flags and its role's skills, beside what its creator asked for", async () => {
  const asked = { extraArgs: { debug: null }, additionalDirectories: ["/elsewhere"] };
  const request = {
    request: {
      config: { provider: "claude-peer", cwd: PROJECT, title: "[Peer] task", providerOptions: asked },
      env: {},
    },
  };
  const created = (await call("before agent.create", request)) as { config: { providerOptions: typeof asked } };

  assert.deepEqual(created.config.providerOptions.extraArgs, {
    debug: null,
    "setting-sources": "project,local",
    "strict-mcp-config": null,
    tools: "Bash,Edit,Glob,Grep,Read,Skill,Write,WebFetch,WebSearch",
    "plugin-dir": join(ROOM_HOME, "safety", "claude"),
  });
  assert.deepEqual(created.config.providerOptions.additionalDirectories, [
    "/elsewhere",
    join(ROOM_HOME, "role-skills", "claude", "peer"),
  ]);
});

test("every agent starts in its harness's mode from the room's table, whatever mode its creator asked for: room seats and the owner's own agents alike", async () => {
  const modeOf = async (provider: string, modeId?: string) =>
    (
      (await call("before agent.create", {
        request: { config: { provider, cwd: PROJECT, title: "[Peer] task", ...(modeId ? { modeId } : {}) }, env: {} },
      })) as { config: { modeId?: string } } | undefined
    )?.config.modeId;
  assert.deepEqual(
    [
      await modeOf("claude-peer", "default"),
      await modeOf("codex-peer"),
      await modeOf("opencode-peer", "plan"),
      await modeOf("claude", "plan"),
      await modeOf("codex", "auto-review"),
      await modeOf("opencode"),
    ],
    ["bypassPermissions", "full-access", "build", "bypassPermissions", "full-access", "build"],
  );
  assert.equal(await modeOf("pi"), undefined, "a harness with no modes is given none");
  assert.equal(
    await modeOf("copilot", "agent"),
    "agent",
    "a provider of no harness the room knows keeps the mode asked",
  );
});

test("an OpenCode seat is created with the policy's permissions and its role's skills only, over what its creator asked for", async () => {
  const request = {
    request: {
      config: {
        provider: "opencode-peer",
        model: "m-one",
        cwd: PROJECT,
        title: "[Peer] task",
        providerOptions: { permission: { webfetch: "allow", task: "allow" } },
      },
      env: {},
    },
  };
  const created = (await call("before agent.create", request)) as {
    config: { providerOptions: { permission: Record<string, unknown> } };
  };
  const { permission } = created.config.providerOptions;
  assert.equal(permission.webfetch, "allow");
  assert.equal(permission.task, "deny", "the room's denial holds over the creator's");
  assert.equal(permission.question, "deny");
  assert.deepEqual(permission.skill, { "*": "deny", "blast-radius": "allow", "test-audit": "allow" });
});

test("a new seat is held to the model table in force, whatever its creator's prompt still says", async () => {
  const create = async (provider: string, model: string | undefined, cwd = PROJECT) =>
    (
      (await call("before agent.create", {
        request: { config: { provider, cwd, title: "[Lead] work", model, thinkingOptionId: "low" }, env: {} },
      })) as { config: { model?: string; thinkingOptionId?: string } }
    ).config;
  const onto = async (provider: string, model: string | undefined, cwd?: string) =>
    (({ model: m, thinkingOptionId: t }) => [m, t])(await create(provider, model, cwd));

  assert.deepEqual(await onto("claude-lead", "claude-haiku-5-5"), ["claude-opus-5-5", "high"]);
  assert.deepEqual(await onto("claude-lead", "claude-opus-5-5"), ["claude-opus-5-5", "low"]);
  assert.deepEqual(await onto("claude-peer", "claude-sonnet-5-5"), ["claude-sonnet-5-5", "low"]);
  await assert.rejects(
    create("claude-peer", "claude-opus-4-8"),
    /claude-peer\/claude-opus-4-8 refused: the room's table lists for peer only claude-peer\/claude-haiku-5-5, .*Create the seat again/,
  );

  const shop = join(PROJECT, "..", "shop");
  mkdirSync(join(shop, ".seatwork"), { recursive: true });
  writeFileSync(
    join(shop, ".seatwork", "room.json"),
    JSON.stringify({
      models: {
        seats: { lead: { provider: "claude-lead/claude-sonnet-5-5", thinking: "medium" } },
        peer: { tiers: { default: null } },
      },
    }),
  );
  assert.deepEqual(await onto("claude-lead", "claude-opus-5-5", shop), ["claude-sonnet-5-5", "medium"]);
  await assert.rejects(
    create("claude-peer", "claude-sonnet-5-5", shop),
    /project shop lists for peer only .*\.seatwork\/room\.json/,
  );
  assert.deepEqual(await onto("claude-lead", "claude-opus-5-5"), ["claude-opus-5-5", "low"]);
});

const CLAUDE_SWITCHES = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
  CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
  CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

test("a seat's session opens with the seat's own environment every time, not only when the seat is created", async () => {
  const tmp = (provider: string) => ({ TMPDIR: join(ROOM_HOME, "tmp", `opened-${provider}`.slice(0, 8)) });
  const guard = (provider: string) => ({ SEATWORK_GATE_SEAT: `opened-${provider}` });
  const withoutUrl = (env: Record<string, string>) => {
    assert.match(env.SEATWORK_GATE_URL, /^http:\/\/127\.0\.0\.1:\d+\/gate\/[\w-]+$/);
    const { SEATWORK_GATE_URL: _url, ...rest } = env;
    return rest;
  };
  for (const reason of ["resume", "refresh", "import"]) {
    assert.deepEqual(
      withoutUrl(await opened("pi-peer", reason)),
      { PI_CODING_AGENT_DIR: join(runtimes, "pi", "peer"), ...tmp("pi-peer"), ...guard("pi-peer") },
      reason,
    );
    assert.deepEqual(
      withoutUrl(await opened("claude-peer", reason)),
      {
        ...CLAUDE_SWITCHES,
        ...tmp("claude-peer"),
        ...guard("claude-peer"),
        ROOM_SKILLS_DIR: join(ROOM_HOME, "role-skills", "claude", "peer", ".claude", "skills"),
      },
      reason,
    );
  }
  assert.ok(existsSync(tmp("claude-peer").TMPDIR));
  assert.deepEqual(await opened("claude", "resume", { MINE: "1" }), { MINE: "1" });
});

const deleted = { refresh: async () => null, current: () => null };
const archived = { refresh: async () => {}, current: () => ({ status: "idle", archivedAt: "2026-10-01T00:00:00Z" }) };
const silent = { refresh: () => Promise.reject(new Error("connection lost")), current: () => null };

for (const archive of ["works", "fails"] as const) {
  test(`a seat created outside the spawn rules: its creator is told what happened when the archive ${archive}`, async () => {
    const parent = `lead-${archive}`;
    const child = `second-lead-${archive}`;
    const toParent: string[] = [];
    agents[parent] = {
      refresh: async () => {},
      current: () => ({ status: "idle" }),
      send: async (text: string) => void toParent.push(text),
    };
    agents[child] = {
      archive: async () => {
        if (archive === "fails") throw new Error("daemon busy");
      },
    };
    const created = (id: string, parentAgentId: string | null) => ({
      agent: { id, parentAgentId, provider: "claude-lead", cwd: PROJECT, title: "[Lead] stream", workspaceId: null },
    });

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

const completed = { kind: "completed" };

/** A turn that starts, and one that ends as the app reports it: with the seat's whole timeline. */
const startTurn = (who: { agent: object }, turnId: string) =>
  call("on agent.turn_started", { agent: who.agent, turnId }, context);
const endTurn = (
  who: { agent: object },
  timeline: object[],
  turnId: string | null = null,
  outcome: object = completed,
) => call("on agent.turn_ended", { agent: who.agent, turnId, outcome, timeline }, context);

function turnEnds(who: TestSeat, finalMessage: string, outcome: object = completed) {
  return endTurn(who, finalMessage ? [{ type: "assistant_message", text: finalMessage }] : [], null, outcome);
}

/** A writing Peer's hand-in as its Lead gets it: when the room returns it for a pass with fresh eyes, the Peer hands in again. */
async function handsIn(who: TestSeat, message: string) {
  await turnEnds(who, message);
  if (!/subject="HAND-IN RETURNED/.test(who.inbox.at(-1) ?? "")) return;
  who.inbox.pop();
  await turnEnds(who, message);
}

const mailId = (envelope: string) => /<mail id="(\d+)"/.exec(envelope)![1];
/** How many mails one prompt brought. */
const mails = (prompt: string | undefined) => prompt?.match(/^<mail /gm)?.length ?? 0;

test("a Peer's own REVIEW mail reaches its Lead once, and only when the Peer's turn has ended", async () => {
  const lead = await seat("lead-report", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-report", "claude-peer", lead.agent.id, "[Peer:review] candidate");

  await peer.mail({
    to: "owner",
    subject: "REVIEW: abc123 PASS",
    body: "REVIEW\nVerdict: ACCEPTABLE",
    needs: "nothing",
  });
  assert.deepEqual(lead.inbox, [], "the Lead was started while the Peer was still in its turn");

  await turnEnds(peer, "REVIEW\nVerdict: ACCEPTABLE\nRECAP: reviewed abc123 → acceptable");
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="REVIEW: abc123 PASS/);
  assert.equal(mails(lead.inbox[0]), 1, "the Lead got the same report twice");
});

test("a report a seat mailed itself still reaches its Owner when the turn is cut short", async () => {
  const lead = await seat("lead-cut", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-cut", "claude-peer", lead.agent.id, "[Peer] task");

  await peer.mail({ to: "owner", subject: "CANDIDATE: hours unit", body: "CANDIDATE\nsha abc123", needs: "reply" });
  await turnEnds(peer, "", { kind: "canceled", reason: "archived" });

  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="CANDIDATE: hours unit/);
});

test("a seat that mailed its signal to its Owner is not reported a second time when its turn ends", async () => {
  const lead = await seat("lead-once", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-once", "claude-peer", lead.agent.id, "[Peer] task");

  await peer.mail({
    to: "owner",
    subject: "QUESTION: which unit",
    body: "QUESTION\nseconds or minutes?",
    needs: "decision",
  });
  assert.equal(lead.inbox.length, 1, "a question asked mid-work goes out at once");

  const said: string[] = [];
  const quiet = console.log;
  console.log = (line: unknown) => void said.push(String(line).replace(/^seatwork: /, ""));
  try {
    await turnEnds(peer, "QUESTION\nseconds or minutes?\nRECAP: asked the Owner → waiting");
  } finally {
    console.log = quiet;
  }
  assert.equal(lead.inbox.length, 1);
  assert.deepEqual(
    said.filter((line) => incidentOf(line) !== null),
    [],
    "what the room logs of it is no trouble",
  );
});

test("what the room kept for a turn does not outlive the runtime that closed in it", async () => {
  const supervisor = await seat("supervisor-closed", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-closed", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const peer = await seat("peer-closed", "claude-peer", lead.agent.id, "[Peer] task");
  const closes = (who: TestSeat) => call("on agent.closed", { agent: who.agent }, context);

  // the Peer asked in mid-turn, then its runtime closed: Paseo sends that turn no end
  await peer.mail({
    to: "owner",
    subject: "QUESTION: which unit",
    body: "QUESTION\nseconds or minutes?",
    needs: "decision",
  });
  await closes(peer);
  await turnEnds(peer, "QUESTION\nand which rounding?\nRECAP: asked the Owner → waiting");
  assert.equal(lead.inbox.length, 2, "a question from the reopened Peer was taken for the one it had mailed before");

  await turnEnds(lead, "DONE\noutcome accepted on the integrated state\nRECAP: closed the workstream → accepted");
  await supervisor.mail({
    to: lead.agent.id,
    subject: "ACCEPT: closed at abc123",
    body: "ACCEPT. Nothing is needed back.",
    needs: "nothing",
    priority: "fyi",
  });
  await closes(lead);
  await turnEnds(lead, "DONE\nthe Owner asked for the sha: abc123\nRECAP: answered → abc123");
  assert.equal(supervisor.inbox.length, 2, "a DONE in a turn no mail started was held back as an echo");
});

/** The history the daemon holds for this seat. */
function hasTimeline(who: TestSeat, entries: object[]) {
  Object.assign(agents[who.agent.id], {
    timeline: { refetch: async () => ({ entries, agent: { pendingPermissions: [] } }) },
  });
}

test("a DONE repeated after a mail that asked nothing does not start the Owner's turn again, and is not lost", async () => {
  const supervisor = await seat("supervisor-echo", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-echo", "claude-lead", supervisor.agent.id, "[Lead] stream");

  await turnEnds(lead, "DONE\noutcome accepted on the integrated state\nRECAP: closed the workstream → accepted");
  assert.equal(supervisor.inbox.length, 1);

  await supervisor.mail({
    to: lead.agent.id,
    subject: "ACCEPT: closed at abc123",
    body: "ACCEPT. Nothing is needed back.",
    needs: "nothing",
    priority: "fyi",
  });
  assert.equal(lead.inbox.length, 1);
  await turnEnds(lead, "DONE\nthe Owner accepted; nothing further\nRECAP: read the acceptance → closed");
  assert.equal(supervisor.inbox.length, 1, "the Supervisor was started for a DONE it already had");

  await turnEnds(
    lead,
    "DECISION_NEEDED\na caller outside the repository depends on the old behavior\nRECAP: found a caller → decision needed",
  );
  assert.equal(supervisor.inbox.length, 2);
  assert.equal(mails(supervisor.inbox[1]), 2);
});

test("a Peer's ACK does not start its Lead's turn; the Lead reads it with its next mail", async () => {
  const lead = await seat("lead-ack", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-ack", "claude-peer", lead.agent.id, "[Peer] task");

  await handsIn(peer, "CANDIDATE\nsha abc123\nRECAP: added the unit → abc123");
  assert.equal(lead.inbox.length, 1);
  await lead.mail({
    reply_to: mailId(lead.inbox[0]),
    subject: "ACCEPT abc123: contract holds",
    body: "ACCEPT abc123: contract holds; write ownership released.",
    needs: "nothing",
  });
  assert.equal(peer.inbox.length, 1);

  await peer.mail({ reply_to: mailId(peer.inbox[0]), subject: "ACK", body: "ACK", needs: "nothing" });
  await turnEnds(peer, "ACK");
  assert.equal(lead.inbox.length, 1, "an acknowledgement started the Lead's turn");

  await turnEnds(peer, "BLOCKED\nthe tree changed under me\nRECAP: saw foreign edits → stopped");
  assert.equal(lead.inbox.length, 2);
  assert.equal(mails(lead.inbox[1]), 2);
  assert.match(lead.inbox[1], /subject="ACK/);
});

test("a Lead's first STATUS starts its Supervisor's turn; a later one waits, and a report that asks something takes its place", async () => {
  const supervisor = await seat("supervisor-status", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-status", "claude-lead", supervisor.agent.id, "[Lead] stream");

  await turnEnds(lead, "STATUS\nthe plan is written and one Peer runs\nRECAP: planned → Peer launched");
  assert.equal(supervisor.inbox.length, 1, "the first report carries the plan: the Supervisor reads it at once");

  await turnEnds(lead, "STATUS\nthe first lens reported; waiting for the second\nRECAP: read one lens → waiting");
  await turnEnds(lead, "STATUS\nboth lenses reported; the Peer repairs\nRECAP: rejected → Peer repairing");
  assert.equal(supervisor.inbox.length, 1, "a progress report started the Supervisor's turn");

  await turnEnds(
    lead,
    "DECISION_NEEDED\ncallers may run at the same time; the brief does not say\nRECAP: found a gap → decision needed",
  );
  assert.equal(supervisor.inbox.length, 2);
  assert.match(supervisor.inbox[1], /subject="DECISION_NEEDED from lead/);
  assert.doesNotMatch(
    supervisor.inbox[1],
    /lens reported|lenses reported/,
    "a progress report older than the report beside it was delivered",
  );
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

  await handsIn(waiting, "CANDIDATE\nsha abc123\nRECAP: added the unit → abc123");
  await lead.mail({
    reply_to: mailId(lead.inbox[0]),
    subject: "HOLD abc123: inspected, with two lenses",
    body: "abc123 received; the tree stays frozen. Nothing to do now.",
    needs: "nothing",
    priority: "fyi",
  });
  assert.deepEqual(waiting.inbox, [], "a receipt started a turn of a Peer that has nothing to do");
  const unsaid = await seat("peer-hold-unsaid", "claude-peer", lead.agent.id, "[Peer] third task");
  await handsIn(unsaid, "CANDIDATE\nsha def456\nRECAP: added the label → def456");
  await lead.mail({
    to: unsaid.agent.id,
    subject: "HOLD def456: inspected",
    body: "def456 received; the tree stays frozen. Nothing to do now.",
  });
  assert.deepEqual(unsaid.inbox, [], "a receipt that names no needs asks nothing either");

  await lead.mail({
    to: waiting.agent.id,
    subject: "REJECT abc123: one repair",
    body: "REJECT abc123: the unit is not printed back.",
    needs: "reply",
  });
  assert.equal(waiting.inbox.length, 1);
  assert.equal(mails(waiting.inbox[0]), 2);
  assert.match(waiting.inbox[0], /subject="HOLD abc123/);

  await turnEnds(
    stopped,
    "REOPEN_REQUEST\nthe contract line is false on this input\nRECAP: ran the input → asked to reopen",
  );
  await lead.mail({
    reply_to: mailId(lead.inbox.at(-1)!),
    subject: "HOLD: candidate stands",
    body: "HOLD: candidate stands. The line holds for the inputs the outcome names.",
    needs: "nothing",
  });
  assert.equal(stopped.inbox.length, 1, "a Peer stopped on its challenge did not get the answer");
  assert.match(stopped.inbox[0], /from="owner" subject="HOLD: candidate stands/);
});

test("mail to a seat that is archived, or that the daemon no longer has, is refused and nothing is sent", async () => {
  for (const [state, gone] of Object.entries({ archived, deleted })) {
    const lead = await seat(`lead-to-${state}`, "claude-lead", null, "[Lead] stream");
    const peer = await seat(`peer-${state}`, "claude-peer", lead.agent.id, "[Peer] task");
    agents[peer.agent.id] = gone;

    await assert.rejects(
      lead.mail({ to: peer.agent.id, subject: "ANSWER: seconds", body: "ANSWER\nseconds", needs: "reply" }),
      /"code":"RECIPIENT_GONE","message":"peer-\S+ is archived or gone; nothing was sent"/,
      state,
    );
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
    const above = shared
      ? (await seat(`supervisor-adopt-${name}`, "claude-supervisor", null, "[Supervisor] project")).agent.id
      : null;
    const old = await seat(`lead-old-${name}`, "claude-lead", above, "[Lead] stream");
    const successor = await seat(`lead-new-${name}`, "claude-lead", above, "[Lead] stream, continued");
    const peer = await seat(`peer-adopt-${name}`, "claude-peer", old.agent.id, "[Peer] task");
    if (owner) agents[old.agent.id] = owner;

    if (refused) {
      await assert.rejects(successor.adopt(peer.agent.id), refused, name);
      await assert.rejects(
        successor.mail({ to: peer.agent.id, subject: "ANSWER: seconds", body: "ANSWER\nseconds", needs: "nothing" }),
        /may write to its parent/,
        name,
      );
      continue;
    }
    await successor.adopt(peer.agent.id);
    assert.match(peer.inbox[0], /OWNER CHANGED/, name);
    await peer.mail({
      to: "owner",
      subject: "QUESTION: which unit",
      body: "QUESTION\nseconds or minutes?",
      needs: "decision",
    });
    assert.equal(successor.inbox.length, 1, name);
    assert.match(successor.inbox[0], /subject="QUESTION: which unit/, name);
    assert.deepEqual(old.inbox, [], name);
  }
});

test("a seat that is gone is not handed over, and no seat is handed to a role that may not own it", async () => {
  const old = await seat("lead-old-gone", "claude-lead", null, "[Lead] stream");
  const successor = await seat("lead-new-gone", "claude-lead", null, "[Lead] stream, continued");
  const peer = await seat("peer-adopt-gone", "claude-peer", old.agent.id, "[Peer] task");
  const sibling = await seat("peer-sibling", "claude-peer", old.agent.id, "[Peer] other task");
  agents[old.agent.id] = archived;

  await assert.rejects(sibling.adopt(peer.agent.id), /seatwork_adopt refused: a peer seat creates no seats/);

  agents[peer.agent.id] = deleted;
  await assert.rejects(successor.adopt(peer.agent.id), /peer-adopt-gone is archived or gone/);
});

test("what a turn leaves for the Owner is listed for the app until that seat works again or is gone, across a closed runtime and a plugin restart; a seat with a seat above it is not the Owner's", async () => {
  const supervisor = await seat("supervisor-owed", "claude-supervisor", null, "[Supervisor] project");
  const lead = await seat("lead-owed", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const waiting = async () => {
    const { waiting } = (await call("rpc room.waiting", {}, context)) as {
      waiting: { agentId: string; what: string }[];
    };
    return waiting.filter((item) => item.agentId.endsWith("-owed")).map((item) => `${item.agentId} ${item.what}`);
  };
  const starts = () => startTurn(supervisor, "next");

  await turnEnds(lead, "DECISION_NEEDED\ncallers may run at the same time; the brief does not say");
  assert.deepEqual(await waiting(), []);

  const cases: [message: string, outcome: object | undefined, listed: string | null][] = [
    ["DECISION_NEEDED\nkeep or break the old behavior?", undefined, "DECISION_NEEDED"],
    ["BLOCKED\nthe deploy key is missing", undefined, "BLOCKED"],
    ["STATUS\none workstream waits\nWAITING ON YOU: which region goes first", undefined, "WAITING ON YOU"],
    ["", { kind: "failed", error: { message: "Not logged in · run /login" } }, "FAILED"],
    // a failure of the service is the room's to try again first: nothing waits on the Owner
    ["", { kind: "failed", error: { message: "API Error: 529 Overloaded" } }, null],
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
  const afterRestart = await withPlugin(
    async (again) => (await again.call("rpc room.waiting", {}, context)) as { waiting: { agentId: string }[] },
  );
  assert.ok(
    afterRestart.waiting.some((item) => item.agentId === "supervisor-owed"),
    "a plugin restart forgot what waits on the Owner",
  );

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
  writeFileSync(
    registry,
    JSON.stringify({
      projects: [
        { name: "alpha", cwd: PROJECT },
        { name: "beta", cwd: beta },
        { name: "gamma", cwd: join(ROOM_HOME, "project-gamma") },
      ],
    }),
  );
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
    await handsIn(peer, "CANDIDATE\nsha abc123\nRECAP: added the unit → abc123");
    await turnEnds(supervisor, "DECISION_NEEDED\nkeep or break the old behavior?");

    const room = (await call("rpc room.status", {}, context)) as {
      waiting: { agentId: string; what: string; project: string }[];
      projects: { name: string; seats: { agentId: string; status: string; held: number; depth: number }[] }[];
    };
    const mine = (row: { agentId: string }) => row.agentId.includes("-screen");

    assert.deepEqual(
      room.projects.map((project) => [
        project.name,
        ...project.seats.filter(mine).map((row) => `${"  ".repeat(row.depth)}${row.agentId} ${row.status} ${row.held}`),
      ]),
      [
        ["HQ", "hq-screen idle 0"],
        ["alpha", "supervisor-screen idle 0", "  lead-screen running 1", "    peer-screen idle 0"],
        ["beta", "supervisor-screen-beta idle 0"],
        ["gamma"], // registered, with no seat open
      ],
    );
    assert.deepEqual(
      room.waiting.filter(mine).map((item) => `${item.project} ${item.agentId} ${item.what}`),
      ["alpha supervisor-screen DECISION_NEEDED"],
    );
  } finally {
    rmSync(registry);
  }
});

test("a Supervisor's prompt names no path of the room's own files", async () => {
  const supervisor = await seat("supervisor-header", "claude-supervisor", null, "[Supervisor] project");
  assert.ok(
    !supervisor.prompt.includes(ROOM_HOME),
    "the seat header points a project seat at the room home, where the other roles' files live",
  );
});

test("a mail whose subject opens with no signal of the room is not sent; one too long to show whole is cut where its file takes over", async () => {
  const lead = await seat("lead-form", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-form", "claude-peer", lead.agent.id, "[Peer] task");
  await assert.rejects(
    lead.mail({
      to: peer.agent.id,
      subject: "STAGE RULE for your long files",
      body: "Run them last.",
      needs: "nothing",
    }),
    /"code":"NO_SIGNAL".*a change to what a seat must do is a REVISED BRIEF.*"subject_opens_with":\["CANDIDATE",/,
  );
  assert.deepEqual([lead.inbox.length, peer.inbox.length], [0, 0]);
  await peer.mail({ subject: "QUESTION: which unit", body: "x".repeat(6001), needs: "reply" });
  assert.match(lead.inbox[0], /x{6000}\n\[cut at 6000 of 6001 characters; the whole mail is in \S+\.md\]\n<\/mail>$/);
  await lead.mail({
    to: peer.agent.id,
    subject: "revised brief: run them last",
    body: "Run them last.",
    needs: "nothing",
  });
  assert.equal(peer.inbox.length, 1);
});

test("a seat's prompt opens with its agent CLI's system prompt, filled in, and a project seat's names nothing above its Owner", async () => {
  const lead = await seat("lead-shared", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-shared", "claude-peer", lead.agent.id, "[Peer:review] abc123");
  const shared = (prompt: string) => prompt.slice(0, prompt.indexOf("\n\n---\n\n# Seat: "));
  assert.match(shared(peer.prompt), /^# The room\n[\s\S]*\n## This runtime: Claude Code\n/);
  assert.equal(shared(lead.prompt), shared(peer.prompt));
  assert.match(peer.prompt, /\n\n---\n\n# Seat: peer \(specialization: review\)\n\n# Peer\n/);
  assert.match(shared(peer.prompt), /\n## The law\n[\s\S]*\*\*Accept on a run, not a report\.\*\*/);
  assert.doesNotMatch(peer.prompt, /\bHQ\b|\bHuman\b|\{\{/);
  for (const harness of ["codex", "pi", "opencode"] as const) {
    const prompt = rolePrompt("peer", { harness, params: loadPolicy().room.params });
    assert.match(shared(prompt), /^# The room\n[\s\S]*\n## This runtime: /);
    assert.doesNotMatch(prompt, /\{\{|Claude Code/);
  }
});

test("a task's rounds are counted by what happened: a revised brief that answers a candidate is a rejection, and the Lead reads the count under the next candidate", async () => {
  const lead = await seat("lead-rounds", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-rounds", "claude-peer", lead.agent.id, "[Peer] task");
  const sendsBack = (subject: string) =>
    lead.mail({ to: peer.agent.id, subject, body: "Repair it.", needs: "nothing" });
  await handsIn(peer, "CANDIDATE abc1\nfirst try");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[room\]/);
  assert.doesNotMatch(await sendsBack("REVISED BRIEF (REJECT abc1: six repairs) round 2"), /rejection/);
  // a second revised brief with no candidate in between changes the task and sends nothing back
  await sendsBack("REVISED BRIEF: one line decided by the Owner");
  await handsIn(peer, "CANDIDATE abc2\nsecond try");
  assert.match(
    lead.inbox.at(-1)!,
    /note="[^"]*\[room\] Second candidate of this task: one rejection [^"]* goes to a new Peer /,
  );
  assert.doesNotMatch(await sendsBack("REJECT abc2: the cost of small ingests"), /rejection/);
  await handsIn(peer, "CANDIDATE abc3\nthird try");
  assert.match(lead.inbox.at(-1)!, /\[room\] Candidate 3 of this task: 2 rejections .* your Owner's call/);
  assert.match(
    await sendsBack("REVISED BRIEF (abc3 not accepted) round 4"),
    /^\{"sent":\d+,"to":\["peer peer-rounds"\].*"note":"This is rejection 3 of this Peer's task since its last ACCEPT: .*your Owner's call.*DECISION_NEEDED/,
  );
  await handsIn(peer, "CANDIDATE abc4\nfourth try");
  await lead.mail({ to: peer.agent.id, subject: "ACCEPT abc4: holds", body: "Released.", needs: "nothing" });
  await handsIn(peer, "CANDIDATE def1\nnext task");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[room\]/);
});

test("a seat whose context has grown past the rotation line is named to the seat above, with its size, under its report", async () => {
  const supervisor = await seat("sup-rotate", "claude-supervisor", null, "[Supervisor] law");
  const lead = await seat("lead-rotate", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const peer = await seat("peer-rotate", "claude-peer", lead.agent.id, "[Peer] task");
  const holds = (who: TestSeat, tokens: number) =>
    Object.assign(agents[who.agent.id], {
      current: () => ({ status: "idle", lastUsage: { contextWindowUsedTokens: tokens } }),
    });
  holds(peer, 199_000);
  await handsIn(peer, "CANDIDATE abc1\nsmall");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[room\]/);
  holds(peer, 268_400);
  await turnEnds(peer, "QUESTION\nwhich of the two?");
  assert.match(
    lead.inbox.at(-1)!,
    /note="[^"]*\[room\] This Peer holds 268K tokens of context [^"]* goes to a new Peer\.">\n/,
  );
  holds(lead, 346_000);
  await turnEnds(lead, "DECISION_NEEDED\nthe limit or the proof");
  assert.match(supervisor.inbox.at(-1)!, /\[room\] This Lead holds 346K tokens of context .*seatwork_rotate/);
});

test("a STOP from above ends the running turn of its seat and of every seat at work under it; it goes down only", async () => {
  const supervisor = await seat("sup-stop", "claude-supervisor", null, "[Supervisor] law");
  const lead = await seat("lead-stop", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const writer = await seat("peer-stop-a", "claude-peer", lead.agent.id, "[Peer] store");
  const resting = await seat("peer-stop-b", "claude-peer", lead.agent.id, "[Peer] bench");
  const how: Record<string, unknown[]> = {};
  const inTurn = (who: TestSeat, now: object) =>
    Object.assign(agents[who.agent.id], {
      current: () => now,
      send: async (text: string, options: { activeTurnBehavior?: string }) => {
        who.inbox.push(text);
        (how[who.agent.id] ??= []).push(options.activeTurnBehavior);
      },
    });
  inTurn(lead, { status: "running" });
  inTurn(writer, { status: "running" });
  // a Claude seat in its turn gets ordinary mail when that turn ends
  await supervisor.mail({ to: lead.agent.id, subject: "FYI: the Owner is back", body: "No change.", needs: "nothing" });
  assert.equal(lead.inbox.length, 0);

  const answer = await supervisor.mail({
    to: lead.agent.id,
    subject: "STOP: the Owner ended the run",
    body: "Commit nothing more. Reply with the state of each task.",
    needs: "reply",
  });
  assert.match(answer, /"state":"its running turn was ended".*"ended_with_it":\["peer \[Peer\] store"\]\}$/);
  assert.deepEqual(how[lead.agent.id], ["interrupt"]);
  assert.match(lead.inbox[0], /from="owner" subject="STOP: the Owner ended the run/);
  assert.deepEqual(how[writer.agent.id], ["interrupt"]);
  assert.match(
    writer.inbox[0],
    /from="room" subject="STOP: the work above you was stopped[\s\S]*"STOP: the Owner ended the run"/,
  );
  assert.equal(resting.inbox.length, 0);

  await assert.rejects(
    writer.mail({ to: "owner", subject: "STOP: this plan is wrong", body: "See the trace.", needs: "decision" }),
    /"code":"STOP_GOES_DOWN"/,
  );
});

test("seatwork_seats shows an orchestrating seat every open seat under it: its state, its context, its cost, its last signal, its rounds and what it owes", async () => {
  const lead = await seat("lead-view", "claude-lead", null, "[Lead] stream");
  const writer = await seat("peer-view-a", "claude-peer", lead.agent.id, "[Peer] store");
  const scout = await seat("peer-view-b", "claude-peer", lead.agent.id, "[Peer] scout-01");
  const gone = await seat("peer-view-c", "claude-peer", lead.agent.id, "[Peer] bench");
  await handsIn(writer, "CANDIDATE abc1\nfirst try");
  await lead.mail({ to: writer.agent.id, subject: "REJECT abc1: two repairs", body: "Repair.", needs: "nothing" });
  await lead.mail({ to: writer.agent.id, subject: "QUESTION: which fixture?", body: "Name it.", needs: "reply" });
  Object.assign(agents[writer.agent.id], {
    current: () => ({ status: "running", lastUsage: { contextWindowUsedTokens: 267_241, totalCostUsd: 6.133 } }),
  });
  Object.assign(agents[scout.agent.id], { current: () => ({ status: "idle", pendingPermissions: [{}] }) });
  Object.assign(agents[gone.agent.id], { current: () => ({ status: "idle", archivedAt: "2026-10-13T12:00:00Z" }) });

  const view = await lead.call("seatwork_seats", {});
  const [head, ...lines] = view.split("\n");
  assert.equal(head, "2 open seats under you, 1 at work.");
  assert.equal(
    lines[0],
    "- peer [Peer] store · peer-view-a · at work · context 267K tokens, past the rotation line: seatwork_rotate moves its work to a fresh seat · $6.13 · last turn ended with CANDIDATE · 1 rejection since its last ACCEPT · owes an answer, the oldest for 0 min",
  );
  assert.equal(lines[1], "- peer [Peer] scout-01 · peer-view-b · waiting for a permission");
  assert.equal(lines.length, 2);
  await assert.rejects(writer.call("seatwork_seats", {}), /seatwork_seats refused: a peer seat creates no seats/);
});

test("the reviewers a Lead launched in one turn report together: the Lead is woken once, by the last of them", async () => {
  const lead = await seat("lead-gate", "claude-lead", null, "[Lead] stream");
  const lens = await seat("lens-gate", "codex-peer", lead.agent.id, "[Peer:search] abc1: correctness");
  const review = await seat("peer-gate-r", "claude-peer", lead.agent.id, "[Peer:review] abc1");
  const scout = await seat("peer-gate-s", "claude-peer", lead.agent.id, "[Peer] scout-01 closure");
  const writer = await seat("peer-gate-w", "claude-peer", lead.agent.id, "[Peer] store");
  await turnEnds(lens, "REVIEW\nACCEPTABLE: holds");
  await turnEnds(review, "REVIEW\nNOT YET: one case");
  assert.equal(lead.inbox.length, 0);
  await turnEnds(scout, "REVIEW\ntwo findings");
  assert.equal(lead.inbox.length, 1);
  assert.equal(mails(lead.inbox[0]), 3);
  assert.match(
    lead.inbox[0],
    /subject="REVIEW from peer \[Peer:search\] abc1: correctness"[^>]*note="[^"]*; held for the 2 others of its review round">\n/,
  );
  assert.match(
    lead.inbox[0],
    /subject="REVIEW from peer \[Peer\] scout-01 closure"[^>]*note="the seat ended its turn with REVIEW">\n/,
  );

  // a writer is no reviewer: its candidate waits for nobody
  await handsIn(writer, "CANDIDATE abc2\ndone");
  assert.equal(lead.inbox.length, 2);
});

test("a Supervisor's view of its Lead counts the reports held for the Lead's round, apart from the mail waiting for it", async () => {
  const supervisor = await seat("sup-held", "claude-supervisor", null, "[Supervisor] held");
  const lead = await seat("lead-held", "claude-lead", supervisor.agent.id, "[Lead] held");
  const first = await seat("peer-held-a", "claude-peer", lead.agent.id, "[Peer:review] abc1: correctness");
  await seat("peer-held-b", "claude-peer", lead.agent.id, "[Peer:review] abc1: compatibility");
  await turnEnds(first, "REVIEW\nACCEPTABLE: holds");
  assert.equal(lead.inbox.length, 0, "held for the other reviewer");
  const view = await supervisor.call("seatwork_seats", {});
  const line = view.split("\n").find((one) => one.includes("lead-held"))!;
  assert.match(line, / · 1 report held for a round, due in \d+ min$/);
  assert.doesNotMatch(line, /mails? held for it/, "a held report is not mail waiting for the seat");
});

test("the last answer of a round says when answers to one question came from one model family", async () => {
  const brief = (angle: string) =>
    [
      "Outcome: decide the store's layout before any code.",
      "Write scope: none, the seat reads only",
      "Non-goals: no change to the CLI or its flags",
      "Acceptance evidence: a REVIEW with a position and its reasons",
      "Question: one log with offsets, or one file per record?",
      angle,
    ].join("\n");
  const answers = (who: TestSeat, angle: string) =>
    endTurn(who, [
      { type: "user_message", text: brief(angle) },
      { type: "assistant_message", text: "REVIEW\nposition: one log" },
    ]);
  const lead = await seat("lead-family", "claude-lead", null, "[Lead] stream");
  const lenses = [
    await seat("family-a", "claude-peer", lead.agent.id, "[Peer:review] layout"),
    await seat("family-b", "claude-peer", lead.agent.id, "[Peer:review] layout"),
    await seat("family-c", "codex-peer", lead.agent.id, "[Peer:review] layout"),
  ];
  for (const [i, lens] of lenses.entries())
    await answers(lens, `Angle: ${["independent", "premise", "specialist"][i]}`);
  assert.equal(lead.inbox.length, 1);
  assert.match(
    lead.inbox[0],
    /; 2 answers to one question in this round came from one model family: their agreement is weak evidence/,
  );

  const other = await seat("lead-family-2", "claude-lead", null, "[Lead] stream");
  const mixed = [
    await seat("family-d", "claude-peer", other.agent.id, "[Peer:review] layout"),
    await seat("family-e", "codex-peer", other.agent.id, "[Peer:review] layout"),
  ];
  await answers(mixed[0], "Angle: independent");
  assert.equal(other.inbox.length, 0);
  await answers(mixed[1], "Angle: premise");
  assert.equal(other.inbox.length, 1);
  assert.doesNotMatch(other.inbox[0], /model family/);
});

test("a control of a writer's tests is built for its Owner and the seats beside it, and for no other seat", async () => {
  const lead = await seat("lead-control", "claude-lead", null, "[Lead] stream");
  const writer = await seat("peer-control-w", "claude-peer", lead.agent.id, "[Peer] store");
  const reviewer = await seat("peer-control-r", "claude-peer", lead.agent.id, "[Peer:review] store");
  const other = await seat("lead-control-2", "claude-lead", null, "[Lead] other");
  const stranger = await seat("peer-control-x", "claude-peer", other.agent.id, "[Peer] other");
  for (const who of [lead, reviewer])
    assert.match(await who.call("seatwork_safety", { action: "control", seat: writer.agent.id }), /control|no start/i);
  for (const who of [stranger, other])
    assert.match(
      await who
        .call("seatwork_safety", { action: "control", seat: writer.agent.id })
        .catch((error: Error) => error.message),
      /give the `seat` of a writer under you, or beside you under one Owner/,
    );
});

test("a reviewer archived before its report holds its round back no longer", async () => {
  const lead = await seat("lead-gate2", "claude-lead", null, "[Lead] stream");
  const first = await seat("lens-gate2-a", "codex-peer", lead.agent.id, "[Peer:review] abc1: correctness");
  const second = await seat("lens-gate2-b", "claude-peer", lead.agent.id, "[Peer:review] abc1: compatibility");
  await turnEnds(first, "REVIEW\nACCEPTABLE");
  assert.equal(lead.inbox.length, 0);
  await call("on agent.archived", { agent: second.agent, archivedAt: new Date().toISOString() }, context);
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="REVIEW from peer \[Peer:review\] abc1: correctness/);
});

test("a turn that fails on the model service is not reported: the room resumes the seat, and tells the Owner when its tries are used or the account is refused", async () => {
  const lead = await seat("lead-recover", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-recover", "claude-peer", lead.agent.id, "[Peer] store");
  const other = await seat("peer-recover-b", "claude-peer", lead.agent.id, "[Peer] bench");
  const fails = (who: TestSeat, message: string) => turnEnds(who, "", { kind: "failed", error: { message } });

  await fails(peer, "API Error: 529 Overloaded");
  assert.equal(lead.inbox.length, 0);
  assert.match(
    await lead.call("seatwork_seats", {}),
    /- peer \[Peer\] store · peer-recover · its last turn failed on a service error; the room resumes it at \d\d:\d\d, try 1 of 3\n/,
  );
  await fails(peer, "API Error: 529 Overloaded");
  await fails(peer, "socket hang up");
  assert.equal(lead.inbox.length, 0);
  await fails(peer, "socket hang up");
  assert.equal(lead.inbox.length, 1);
  assert.match(
    lead.inbox[0],
    /from="peer peer-rec[^"]*" subject="FAILED: socket hang up"[^>]*note="the seat's turn failed, and again after the room's 3 tries; its work is stopped: a mail to it starts it again, or archive it and brief a new seat">\n/,
  );

  // a quota is waited out; an account the service refuses is the Owner's at once
  await fails(other, "You've hit your usage limit · resets in 40 minutes");
  assert.equal(lead.inbox.length, 1);
  assert.match(
    await lead.call("seatwork_seats", {}),
    /peer-recover-b · out of quota; the room resumes it at \d\d:\d\d/,
  );
  await fails(other, "Invalid API key");
  assert.equal(lead.inbox.length, 2);
  assert.match(
    lead.inbox[1],
    /subject="FAILED: Invalid API key"[^>]*note="the seat's turn failed; its work is stopped: a mail to it starts it again, or archive it and brief a new seat">\n/,
  );
});

test("seatwork_rotate replaces a seat with a fresh one: its handoff and brief start the successor, its seats and task go over, it is archived", async () => {
  const supervisor = await seat("sup-rot", "claude-supervisor", null, "[Supervisor] law");
  const lead = await seat("lead-rot", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const peer = await seat("peer-rot", "claude-peer", lead.agent.id, "[Peer] store");
  const created: { config: object; parent?: string; title?: string; prompt?: string; cwd: string }[] = [];
  let successor: TestSeat | undefined;
  let archived = false;
  Object.assign(context.paseo.agents, {
    create: async (options: (typeof created)[number]) => {
      created.push(options);
      successor = await seat("lead-rot-2", "claude-lead", options.parent ?? null, options.title ?? "");
      return { id: successor.agent.id };
    },
  });
  const state = { status: "idle", provider: "claude-lead", model: "claude-opus-5-5", cwd: PROJECT };
  Object.assign(agents[lead.agent.id], {
    current: () => ({
      ...state,
      thinkingOptionId: "medium",
      ...(archived ? { archivedAt: "x" } : {}),
    }),
    archive: async () => void (archived = true),
  });
  hasTimeline(lead, [prompt(BRIEF)]);

  await assert.rejects(
    peer.call("seatwork_rotate", { agent_id: lead.agent.id }),
    /seatwork_rotate refused: a peer seat creates no seats/,
  );
  assert.match(
    await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id, why: "346K tokens of context" }),
    /^asked lead lead-rot for its handoff\. When it answers, the room starts its successor/,
  );
  assert.match(lead.inbox[0], /from="room" subject="HANDOFF: [\s\S]*\(346K tokens of context\)[\s\S]*\nBLOCKERS: /);

  await turnEnds(
    lead,
    "HANDOFF\n**CURRENT TASK:** the store's fourth round\nPROGRESS: done 2ea3368; to do: mixed-state reads\nKEY DECISIONS: a log with offset indexes\nACTIVE FILES: src/store.js, uncommitted\nBLOCKERS: none",
  );
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].config, {
    provider: "claude-lead/claude-opus-5-5",
    thinkingOptionId: "medium",
  });
  assert.deepEqual(
    [created[0].parent, created[0].title, created[0].cwd],
    [supervisor.agent.id, "[Lead] stream (2)", PROJECT],
  );
  assert.match(
    created[0].prompt!,
    /## The brief in force\n[\s\S]*Outcome: [\s\S]*## The handoff \(kept at [^\n]*\.seatwork\/handoffs\/[^\n]*\)\n\*\*CURRENT TASK:\*\* the store's fourth round\n[\s\S]*trust the tree/,
  );
  assert.match(
    created[0].prompt!,
    /## The mail threads it was in[^\n]*\n- m\d+: 1 mail, the last #\d+ "HANDOFF: write your handoff[^"]*" from room\. The thread: [^\n]*threads\/m\d+\.md\n/,
  );
  assert.deepEqual(
    readdirSync(join(PROJECT, ".seatwork", "handoffs")).filter((name) => name.endsWith(".md")).length,
    1,
  );
  assert.equal(archived, true);
  // the old seat's reply is in the handoff file, not in its Owner's mail; the notice waits for the next mail
  assert.equal(supervisor.inbox.length, 0);
  assert.match(await supervisor.held(), /ROTATED: lead \[Lead\] stream continues in a fresh seat[\s\S]*\(lead-rot-2\)/);
  assert.match(peer.inbox[0], /OWNER CHANGED: your Owner continues in a fresh seat/);
  await peer.mail({ to: "owner", subject: "QUESTION: which unit", body: "seconds or minutes?", needs: "decision" });
  assert.match(successor!.inbox.at(-1)!, /subject="QUESTION: which unit/);
});

test("a seat that answers a handoff request with no handoff stays as it is, and whoever asked is told", async () => {
  const supervisor = await seat("sup-rot2", "claude-supervisor", null, "[Supervisor] law");
  const lead = await seat("lead-rot2", "claude-lead", supervisor.agent.id, "[Lead] stream");
  let started = 0;
  Object.assign(context.paseo.agents, { create: async () => void (started += 1) });
  await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id });
  assert.match(
    await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id }),
    /was already asked for its handoff/,
  );
  await turnEnds(lead, "STATUS\nI am in the middle of the review; nothing to hand over yet");
  assert.equal(started, 0);
  // whoever asked is told, and the seat's own report goes up as any other
  assert.equal(supervisor.inbox.length, 2);
  assert.match(
    supervisor.inbox[0],
    /subject="ROTATION FAILED: lead \[Lead\] stream stays as it is[\s\S]*its reply was no handoff/,
  );
  assert.match(supervisor.inbox[1], /subject="STATUS: lead \[Lead\] stream/);
});

test("a writing Peer's candidate goes back to it once for a pass with fresh eyes; the next hand-in goes up, and each repair owes the pass again", async () => {
  const lead = await seat("lead-eyes", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-eyes", "claude-peer", lead.agent.id, "[Peer] store");
  const scout = await seat("peer-eyes-s", "claude-peer", lead.agent.id, "[Peer] scout-01 closure");

  await turnEnds(peer, "CANDIDATE abc1\nthe store holds");
  assert.equal(lead.inbox.length, 0);
  assert.match(
    peer.inbox[0],
    /from="room" subject="HAND-IN RETURNED: [^>]*needs="reply"[\s\S]*a check made weaker than it was[\s\S]*`Fresh eyes: /,
  );
  await turnEnds(peer, "CANDIDATE abc2\nFresh eyes: one off-by-one in the index, fixed");
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="CANDIDATE from peer[\s\S]*Fresh eyes: one off-by-one/);
  assert.equal(peer.inbox.length, 1);

  await lead.mail({ to: peer.agent.id, subject: "REJECT abc2: one repair", body: "Repair it.", needs: "reply" });
  await turnEnds(peer, "CANDIDATE abc3\nrepaired");
  assert.equal(lead.inbox.length, 1);
  assert.match(peer.inbox.at(-1)!, /HAND-IN RETURNED/);

  // a question is no hand-in, a reviewer writes no candidate, and a turn cut short is not sent back
  await turnEnds(peer, "QUESTION\nwhich unit?");
  assert.equal(lead.inbox.length, 2);
  await turnEnds(scout, "REVIEW\ntwo findings");
  assert.equal(lead.inbox.length, 3);
});

/** A git repository beside the project with `files` committed: where a seat starts. */
const gitRepo = (name: string, files: Record<string, string>): string => repoWith(join(PROJECT, "..", name), files);

test("a focused test sends the candidate back until acknowledged, and its reason rides up with it", async () => {
  const repo = gitRepo("guarded", { "test/a.test.ts": 'test("a", () => expect(1).toBe(1));\n' });
  const lead = await seat("lead-guard", "claude-lead", null, "[Lead] stream", repo);
  const peer = await seat("peer-guard", "claude-peer", lead.agent.id, "[Peer] guarded", repo);
  // the guard notes the seat's starting commit beside its creation
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeFileSync(join(repo, "test", "a.test.ts"), 'test.only("a", () => expect(1).toBe(1));\n');
  await turnEnds(peer, "CANDIDATE g1\nthe store holds");
  assert.match(peer.inbox.at(-1)!, /HAND-IN RETURNED: one pass with fresh eyes/);
  await turnEnds(peer, "CANDIDATE g2\nFresh eyes: checked again");
  assert.equal(lead.inbox.filter((m) => /CANDIDATE/.test(m)).length, 0);
  const returned = peer.inbox.at(-1)!;
  assert.match(
    returned,
    /HAND-IN RETURNED: 1 finding\(s\) from the room's check[\s\S]*test-focused at test\/a\.test\.ts:1/,
  );
  const id = /- ([0-9a-f]{12}) test-focused/.exec(returned)![1];
  assert.match(
    await peer.call("seatwork_safety", {
      action: "ack",
      id,
      reason: "the other suites wait on an upstream fix, issue sw-12",
    }),
    /Acknowledged/,
  );
  await turnEnds(peer, "CANDIDATE g3\nkept the focus on purpose");
  assert.match(
    lead.inbox.at(-1)!,
    /CANDIDATE from peer[\s\S]*acknowledged by the seat: test-focused test\/a\.test\.ts:1 \(the other suites wait/,
  );
});

test("the council reads a seat's ended turn from the app's timeline and logs each member's reading", async () => {
  const lead = await seat("lead-council", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-council", "claude-peer", lead.agent.id, "[Peer] hours");
  const tool = (callId: string, name: string, detail: object) => ({
    type: "tool_call",
    callId,
    name,
    status: "completed",
    error: null,
    detail,
  });
  await startTurn(peer, "turn-c");
  await endTurn(
    peer,
    [
      tool("1", "Edit", { type: "edit", filePath: join(PROJECT, "src/cli.js") }),
      tool("2", "Bash", { type: "shell", command: "git status", exitCode: 0, output: "" }),
      { type: "assistant_message", text: "CANDIDATE: hours added\nAll tests pass." },
    ],
    "turn-c",
  );
  const db = new DatabaseSync(join(ROOM_HOME, "safety", "safety.db"));
  const rows = db
    .prepare("SELECT id, member, zone FROM council_readings WHERE seat = ? ORDER BY member")
    .all(peer.agent.id) as { id: number; member: string; zone: string }[];
  db.close();
  assert.deepEqual(
    rows.map((row) => `${row.member}:${row.zone}`),
    ["claims:found", "report:clear", "scope:skipped", "stuck:clear"],
  );

  // the seat above says whether a finding was right; the seat itself cannot
  const id = rows[0].id;
  const label = {
    action: "label",
    id: `#${id}`,
    value: "right",
    reason: "it never ran the suite after editing cli.js",
  };
  assert.match(await peer.call("seatwork_safety", label), /not under you/);
  assert.match(await lead.call("seatwork_safety", label), new RegExp(`finding #${id} was right`));
  assert.match(
    await lead.call("seatwork_safety", { action: "council" }),
    /claims: \d+ readings, \d+ found, 0 unsure, 0 shown; labelled 1 right, 0 wrong/,
  );
});

test("a council member that has earned the level that sends work back asks the room's own seat, whose ruling returns the candidate", async () => {
  const repo = gitRepo("chair-repo", {
    "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n",
    "test/sum.test.ts":
      'test("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n  expect(sum(2, 2)).toBe(4);\n  expect(sum(3, 3)).toBe(6);\n});\n',
  });
  const hq = await seat("hq-chair", "claude-hq", null, "[HQ] the room", join(ROOM_HOME, "hq-seatwork"));
  const lead = await seat("lead-chair", "claude-lead", null, "[Lead] stream", repo);
  const peer = await seat("peer-chair", "claude-peer", lead.agent.id, "[Peer] chair", repo);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // the Lead has said sixty of gaming's findings on this Peer were right: the level that sends work back
  const readings = new SafetyStore(join(ROOM_HOME, "safety"), 1000);
  await earnLevel3(
    readings,
    "gaming",
    (reading) =>
      lead.call("seatwork_safety", {
        action: "label",
        id: `#${reading}`,
        value: "right",
        reason: "the tests were bent",
      }),
    () => peer.agent.id,
  );
  readings.close();

  // the Peer bends its tests: the room's own check returns the hand-in, the Peer keeps the finding on purpose
  writeFileSync(join(repo, "src", "sum.ts"), "export const sum = (a: number, b: number) => a + b + 0;\n");
  writeFileSync(join(repo, "test", "sum.test.ts"), 'test("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n});\n');
  let id: string | undefined;
  for (let tries = 0; tries < 3 && !id; tries += 1) {
    await turnEnds(peer, "CANDIDATE: sum fixed");
    id = /- ([0-9a-f]{12}) assertions-removed/.exec(peer.inbox.at(-1) ?? "")?.[1];
  }
  assert.ok(id, "the room's check returns the hand-in");
  await peer.call("seatwork_safety", {
    action: "ack",
    id,
    reason: "the checks removed covered a case that no longer exists",
  });
  await turnEnds(peer, "CANDIDATE: sum fixed");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const appeal = hq.inbox.find((text) => /subject="APPEAL #\d+: gaming on \[Peer\] chair's candidate"/.test(text));
  assert.ok(appeal, `the room's own seat is asked: ${hq.inbox.join("\n").slice(0, 400)}`);
  assert.match(appeal, /2 assertion\(s\) removed/);
  const number = /APPEAL #(\d+)/.exec(appeal)![1];
  const ruling = {
    action: "rule",
    id: number,
    send_back: true,
    reason: "Two checks went while the code changed, and the outcome does not call for it.",
  };
  assert.equal(await lead.call("seatwork_safety", ruling), "Only the room's own seat rules on appeals.");
  assert.match(
    await hq.call("seatwork_safety", { ...ruling, send_back: "yes" }).catch((e: Error) => e.message),
    /`send_back` true or false/,
  );
  peer.inbox.length = 0;
  lead.inbox.length = 0;
  assert.match(await hq.call("seatwork_safety", ruling), /Sent back: \[Peer\] chair is told/);
  assert.match(peer.inbox.join("\n"), /subject="HAND-IN RETURNED: the chair sent your candidate back \(gaming\)"/);
  assert.match(peer.inbox.join("\n"), /The chair's reason: Two checks went/);
  assert.match(lead.inbox.join("\n"), /subject="COUNCIL: the chair sent \[Peer\] chair's hand-in back"/);
});

test("a seat's ended turn is kept in the record: another seat finds it and reads around it", async () => {
  const lead = await seat("lead-record", "claude-lead", null, "[Lead] record");
  const peer = await seat("peer-record", "claude-peer", lead.agent.id, "[Peer] record");
  await startTurn(peer, "turn-r");
  await endTurn(
    peer,
    [
      { type: "user_message", text: "Fix the flaky session refresh" },
      {
        type: "tool_call",
        callId: "1",
        name: "Skill",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: "debugging" },
      },
      {
        type: "tool_call",
        callId: "2",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test", exitCode: 1, output: "session refresh: timeout" },
      },
      { type: "assistant_message", text: "The refresh timer raced the logout; fixed with a lock." },
    ],
    "turn-r",
  );
  const found = JSON.parse(
    await lead.call("seatwork_knowledge", { do: "search", q: "refresh race", also: ["session timeout"] }),
  );
  assert.ok(found.hits.length >= 2, JSON.stringify(found));
  const failed = found.hits.find((hit: { kind: string }) => hit.kind === "shell");
  assert.equal(failed.exitCode, 1);
  const around = JSON.parse(
    await lead.call("seatwork_knowledge", { do: "expand", address: failed.address, around: 1 }),
  );
  assert.deepEqual(
    around.entries.map((entry: { kind: string }) => entry.kind),
    ["tool", "shell", "say"],
  );
  assert.equal(around.entries[0].text, "Skill debugging");
  const refused = await lead.call("seatwork_knowledge", { do: "search" }).then(
    () => "",
    (error: Error) => error.message,
  );
  assert.equal(JSON.parse(refused).error.code, "BAD_REQUEST");
});

test("the app hands a seat's whole timeline at each turn's end, and the room keeps only the turn that ended", async () => {
  const lead = await seat("lead-whole", "claude-lead", null, "[Lead] whole");
  const peer = await seat("peer-whole", "claude-peer", lead.agent.id, "[Peer] whole");
  const said = (text: string) => ({ type: "assistant_message", text });
  const asked = (text: string) => ({ type: "user_message", text });
  const first = [asked("Add the hours flag"), said("Hours flag added to the duration parser.")];
  const second = [
    ...first,
    asked("Now the minutes flag"),
    said("Started on minutes."),
    asked("Also keep the old flag working"),
    said("Minutes flag added; the old flag still parses."),
  ];
  for (const [turnId, timeline] of [
    ["turn-w1", first],
    ["turn-w2", second],
  ] as const) {
    await startTurn(peer, turnId);
    await endTurn(peer, timeline, turnId);
  }
  const kept = async (turn: string) =>
    JSON.parse(
      await lead.call("seatwork_knowledge", { do: "expand", address: `turn:${peer.agent.id}:${turn}#0`, around: 20 }),
    ).entries.map((entry: { text: string }) => entry.text);
  assert.deepEqual(await kept("turn-w1"), ["Add the hours flag", "Hours flag added to the duration parser."]);
  assert.deepEqual(
    await kept("turn-w2"),
    [
      "Now the minutes flag",
      "Started on minutes.",
      "Also keep the old flag working",
      "Minutes flag added; the old flag still parses.",
    ],
    "the earlier turn is not kept again, and words typed into the running turn stay with it",
  );
});

test("a turn that ends with no words of the seat's own sends up its outcome, never the prompt that opened it", async () => {
  const lead = await seat("lead-silent", "claude-lead", null, "[Lead] silent");
  const peer = await seat("peer-silent", "claude-peer", lead.agent.id, "[Peer] silent");
  const prompt = { type: "user_message", text: "BLOCKED if the parser tests fail; end with DONE once they pass" };
  await startTurn(peer, "turn-silent");
  await endTurn(peer, [prompt], "turn-silent");
  const report = lead.inbox.at(-1) ?? "";
  assert.match(report, /no final message; outcome completed/);
  assert.doesNotMatch(report, /subject="(BLOCKED|DONE)/, "the brief's protocol words are not the seat's report");
  const own = { id: "users-own-agent", parentAgentId: null, provider: "claude", cwd: PROJECT, title: "mine" };
  await startTurn({ agent: own }, "turn-own");
  await endTurn({ agent: own }, [prompt], "turn-own");
  const found = JSON.parse(await lead.call("seatwork_knowledge", { do: "search", q: "parser tests", agent: own.id }));
  assert.deepEqual(found.hits, [], "an agent of the user's own is none of the room's business");
});

test("a person's decision reaches every seat: a new seat starts with it, a working seat is told its change by the guard", async () => {
  const project = join(PROJECT, "..", "decisions-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  writeFileSync(join(project, ".seatwork", "room.json"), "{}");
  const sup = await seat("sup-decide", "claude-supervisor", null, "[Supervisor] decide", project);
  const lead = await seat("lead-decide", "claude-lead", null, "[Lead] decide", project);
  const ownerSays = async (words: string, turnId: string, args: Record<string, unknown>) => {
    await startTurn(sup, turnId);
    const answer = JSON.parse(
      await sup.call("seatwork_knowledge", { do: "decide", scope: "project", project: "decisions-project", ...args }),
    );
    await endTurn(
      sup,
      [
        { type: "user_message", text: words },
        { type: "assistant_message", text: "Noted." },
      ],
      turnId,
    );
    return answer;
  };
  const asked = await ownerSays("dùng pnpm thôi, đừng dùng npm", "sup-t1", {
    topic: "package manager",
    statement: "Use pnpm for every install; never npm.",
  });
  assert.equal(asked.state, "pending");
  const peer = await seat("peer-decide", "claude-peer", lead.agent.id, "[Peer] install", project);
  assert.match(
    peer.prompt,
    /## Decisions in force[\s\S]*package-manager: Use pnpm for every install; never npm\. \(since/,
  );

  const hook = (command: string) => peer.hook("Bash", { command }, project);
  assert.equal(await hook("ls"), "", "a seat that holds every decision is told nothing");
  await ownerSays("thôi chuyển qua yarn", "sup-t2", {
    topic: "package manager",
    statement: "Use yarn for every install; pnpm and npm are out.",
    replaces_version: 1,
  });
  const told = JSON.parse(await hook("ls"));
  assert.match(told.hookSpecificOutput.additionalContext, /Decision changed: \[project\] package-manager: Use yarn/);
  assert.equal(await hook("ls"), "", "told once");
});

test("the work store through the room's tools: a Lead writes a plan, a Peer takes what is ready, only the Owner closes, and a seat that is gone holds nothing", async () => {
  // a project of the room, by its marker; a seat in a worktree under it shares the one store
  const project = join(PROJECT, "..", "work-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  mkdirSync(join(project, ".worktrees", "store"), { recursive: true });
  writeFileSync(join(project, ".seatwork", "room.json"), "{}");
  const lead = await seat("lead-work", "claude-lead", null, "[Lead] stream", project);
  const peer = await seat(
    "peer-work-a",
    "claude-peer",
    lead.agent.id,
    "[Peer] schema",
    join(project, ".worktrees", "store"),
  );
  const other = await seat("peer-work-b", "claude-peer", lead.agent.id, "[Peer] api", project);
  const does = async (who: TestSeat, tool: string, args: Record<string, unknown>) =>
    JSON.parse(await who.call(tool, args));
  const refusalOf = async (who: TestSeat, args: Record<string, unknown>) =>
    JSON.parse(
      await who.call("seatwork_work", args).then(
        () => "{}",
        (error: Error) => error.message,
      ),
    ).error;
  const refused = async (who: TestSeat, args: Record<string, unknown>) => (await refusalOf(who, args))?.code;

  const made = await does(lead, "seatwork_work", {
    do: "create",
    issues: [
      { key: "schema", title: "schema", priority: 1, write_scope: "src/schema.js" },
      { key: "api", title: "api", deps: ["schema"], write_scope: "src/api/" },
      { key: "docs", title: "docs", priority: 3, write_scope: "docs/" },
    ],
  });
  const [schema, api, docs] = made.map((issue: { id: string }) => issue.id);
  assert.deepEqual(
    (await does(peer, "seatwork_work", { do: "ready" })).map((issue: { id: string }) => issue.id),
    [schema, docs],
  );
  assert.equal((await does(peer, "seatwork_graph", { view: "next" })).id, schema);

  assert.equal((await does(peer, "seatwork_work", { do: "claim", id: schema })).assignee, peer.agent.id);
  assert.equal(await refused(other, { do: "claim", id: schema }), "ALREADY_ASSIGNED");
  assert.equal(await refused(other, { do: "claim", id: api }), "BLOCKED");
  // a refusal names the call to make instead, and a word outside an enum the one it likely meant
  assert.deepEqual((await refusalOf(other, { do: "claim", id: schema })).next, {
    tool: "seatwork_work",
    args: { do: "ready" },
  });
  assert.deepEqual((await refusalOf(other, { do: "claim", id: api })).next, {
    tool: "seatwork_work",
    args: { do: "show", id: schema },
  });
  assert.deepEqual(await refusalOf(other, { do: "Claimm", id: api }), {
    code: "INVALID_ARGUMENT",
    message:
      '`do` is one of create, show, comments, list, ready, claim, update, note, comment, depend, undepend, close, reopen; "Claimm" is none of them',
    retryable: false,
    fix: { do: "claim" },
  });
  await does(peer, "seatwork_work", { do: "note", id: schema, text: "tables written, migration next" });
  assert.deepEqual(
    await refusalOf(peer, { do: "close", id: schema, reason: "done in 4f2a91c, npm test 88/88" }).then((one) => [
      one.code,
      one.next,
    ]),
    ["POLICY_VIOLATION", { tool: "seatwork_mail", args: { to: "owner" } }],
  );
  assert.equal(await refused(lead, { do: "close", id: schema, reason: "ok" }), "POLICY_VIOLATION");
  const closed = await does(lead, "seatwork_work", {
    do: "close",
    id: schema,
    reason: "done in 4f2a91c, npm test 88/88",
  });
  assert.deepEqual(
    closed.unblocked.map((issue: { id: string }) => issue.id),
    [api],
  );

  const triaged = await does(lead, "seatwork_graph", { view: "triage" });
  assert.deepEqual(triaged.counts, { open: 2, ready: 2, blocked: 0, in_progress: 0 });
  assert.equal((await does(lead, "seatwork_graph", { view: "plan" })).tracks.length, 2);

  // the store never learns of a seat's end by itself: the room frees what the seat held
  await does(other, "seatwork_work", { do: "claim", id: api });
  await call("on agent.archived", { agent: other.agent, archivedAt: new Date().toISOString() }, context);
  const freed = await does(lead, "seatwork_work", { do: "show", id: api });
  assert.deepEqual([freed.assignee, freed.status], [null, "open"]);
  assert.ok(existsSync(join(project, ".seatwork", ".work", "work.db")));
  assert.equal(existsSync(join(project, ".worktrees", "store", ".seatwork")), false);
});

test("a seat is listed the tools its role may call, and is refused one it calls anyway", async () => {
  const defined = JSON.parse(readFileSync(join(__dirname, "..", "shared", "tools.json"), "utf8")).tools as Record<
    string,
    { callers: "any" | "spawners" | "room" }
  >;
  const of = (...callers: string[]) => Object.keys(defined).filter((name) => callers.includes(defined[name].callers));
  const hq = await seat("hq-tools", "claude-hq", null, "HQ Supervisor", join(ROOM_HOME, "hq-seatwork"));
  const lead = await seat("lead-tools", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-tools", "claude-peer", lead.agent.id, "[Peer] task");
  assert.deepEqual(await peer.listed(), of("any"));
  assert.deepEqual(await lead.listed(), of("any", "spawners"));
  assert.deepEqual(await hq.listed(), of("any", "spawners", "room"));
  for (const [name, { callers }] of Object.entries(defined)) {
    const answer = await peer.call(name, {}).catch((error: Error) => error.message);
    const why =
      callers === "room"
        ? "it belongs to the seats at home in the room, and a peer seat is not one"
        : callers === "spawners"
          ? "a peer seat creates no seats, so none is under it"
          : null;
    if (why) assert.match(answer, new RegExp(`^${name} refused: ${why}$`), name);
    else assert.doesNotMatch(answer, /refused: (it belongs to|a peer seat creates)/, name);
  }
  assert.doesNotMatch(await lead.call("seatwork_seats", {}).catch((error: Error) => error.message), /refused/);
});

test("the mail tool finds its recipient by itself, by the start of an id, by a title, or as the team; a wrong name is answered with the right ones", async () => {
  const lead = await seat("lead-address", "claude-lead", null, "[Lead] billing");
  const peer = await seat("peer-address-one", "claude-peer", lead.agent.id, "[Peer] hours unit");
  const other = await seat("peer-address-two", "claude-peer", lead.agent.id, "[Peer] days unit");
  const note = { subject: "INSTRUCTION: start", body: "Go.", needs: "nothing" };

  // a seat with no seat under it has one place to write to
  assert.match(
    await peer.mail({ subject: "QUESTION: which unit", body: "Seconds or minutes?", needs: "decision" }),
    /^\{"sent":\d+,"to":\["owner"\],"thread":"m\d+","state":"delivered"\}$/,
  );
  assert.match(lead.inbox[0], /from="peer peer-add: hours unit" subject="QUESTION: which unit" needs="decision"/);
  await assert.rejects(
    lead.mail(note),
    /"code":"NO_RECIPIENT".*"fix":\{"to":\["peer-address-one \(peer peer-add: hours unit\)","peer-address-two \(peer peer-add: days unit\)"\]\}/,
  );
  await lead.mail({ ...note, to: "days unit" });
  await lead.mail({ ...note, to: "peer-address-o", subject: "INSTRUCTION: start too" });
  assert.deepEqual([peer.inbox.length, other.inbox.length], [1, 1]);
  await assert.rejects(lead.mail({ ...note, to: "peer-address" }), /"code":"AMBIGUOUS_RECIPIENT".*names 2 seats/);
  await assert.rejects(
    lead.mail({ ...note, to: "nobody" }),
    /"code":"UNKNOWN_RECIPIENT".*"fix":\{"to":\["peer-address-one /,
  );

  assert.match(
    await lead.mail({
      to: "team",
      subject: "FYI: main moved",
      body: "Rebase before your next commit.",
      needs: "nothing",
    }),
    /"to":\["peer peer-address-one","peer peer-address-two"\],"thread":"m\d+","state":"read with the recipient's next mail"/,
  );
  assert.deepEqual([peer.inbox.length, other.inbox.length], [1, 1]);
  assert.match(await other.held(), /subject="FYI: main moved" needs="nothing" thread="m\d+" as="team">\nRebase before/);
  await assert.rejects(
    lead.mail({ to: "team", subject: "QUESTION: who is free?", body: "Say so.", needs: "reply" }),
    /"code":"TEAM_ASKS_NOTHING"/,
  );

  const ask = mailId(lead.inbox[0]);
  assert.match(await lead.call("seatwork_inbox", { view: "owed" }), new RegExp(`^you owe: #${ask} `));
  const answer = { reply_to: `#${ask}`, subject: "ANSWER: seconds", body: "Seconds.", needs: "nothing" };
  const sent = JSON.parse(await lead.mail(answer)) as { sent: number; thread: string };
  assert.equal(sent.thread, `m${ask}`);
  assert.deepEqual(JSON.parse(await lead.mail(answer)), {
    sent: sent.sent,
    thread: sent.thread,
    replayed: true,
    state: "delivered",
  });
  assert.equal(await lead.call("seatwork_inbox", { view: "owed" }), "nothing is owed");
  assert.match(
    await peer.call("seatwork_inbox", { thread: sent.thread }),
    new RegExp(
      `^#${ask} [^\\n]* QUESTION: which unit · needs decision, answered by #${sent.sent} [^\\n]*\\n#${sent.sent} [^\\n]* owner · ANSWER: seconds `,
    ),
  );
  assert.match(await peer.call("seatwork_inbox", { q: "seconds", signal: "ANSWER" }), new RegExp(`^#${sent.sent} `));
  await assert.rejects(peer.call("seatwork_inbox", { view: "everything" }), /"code":"INVALID_ARGUMENT"/);
});

test("a repair that goes to a new Peer keeps its task's count, and a seat in a worktree outside the project shares the project's mail and work", async () => {
  const project = join(PROJECT, "..", "rounds-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  writeFileSync(join(project, ".seatwork", "room.json"), "{}");
  const outside = (name: string) => {
    const dir = join(PROJECT, "..", "paseo-worktrees", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const lead = await seat("lead-task", "claude-lead", null, "[Lead] stream", project);
  const first = await seat("peer-task-a", "claude-peer", lead.agent.id, "[Peer] store", outside("a"));
  const task = JSON.parse(await lead.call("seatwork_work", { do: "create", title: "store" })) as { id: string };
  await first.call("seatwork_work", { do: "claim", id: task.id });
  const sendsBack = (to: TestSeat, subject: string) =>
    lead.mail({ to: to.agent.id, subject, body: "Repair it.", needs: "nothing" });
  await handsIn(first, "CANDIDATE abc1\nfirst try");
  await sendsBack(first, "REJECT abc1: two repairs");
  await handsIn(first, "CANDIDATE abc2\nsecond try");
  await sendsBack(first, "REJECT abc2: still one");
  const second = await seat("peer-task-b", "claude-peer", lead.agent.id, "[Peer] store, fresh", outside("b"));
  await lead.call("seatwork_work", { do: "update", id: task.id, assignee: second.agent.id });
  await handsIn(second, "CANDIDATE abc3\nthird try");
  assert.match(lead.inbox.at(-1)!, /\[room\] Candidate 3 of this task: 2 rejections .* your Owner's call/);
  assert.ok(existsSync(join(project, ".seatwork", ".mail", "mail.db")), "the worktree seats' mail is the project's");
});

test("a seat being replaced takes no mail: what comes in while its successor starts is the successor's", async () => {
  const supervisor = await seat("sup-window", "claude-supervisor", null, "[Supervisor] law");
  const lead = await seat("lead-window", "claude-lead", supervisor.agent.id, "[Lead] stream");
  const peer = await seat("peer-window", "claude-peer", lead.agent.id, "[Peer] store");
  const starting = deferred();
  let successor: TestSeat | undefined;
  Object.assign(context.paseo.agents, {
    create: async (options: { parent?: string; title?: string }) => {
      await starting.promise;
      successor = await seat("lead-window-2", "claude-lead", options.parent ?? null, options.title ?? "");
      return { id: successor.agent.id };
    },
  });
  Object.assign(agents[lead.agent.id], {
    current: () => ({ status: "idle", provider: "claude-lead", model: "claude-opus-5-5", cwd: PROJECT }),
    archive: async () => {},
  });
  hasTimeline(lead, [prompt(BRIEF)]);
  await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id });
  const ended = turnEnds(lead, "HANDOFF\nCURRENT TASK: the store\nPROGRESS: done 2ea3368\nBLOCKERS: none");
  await new Promise((done) => setTimeout(done, 20));
  const before = lead.inbox.length;
  await peer.mail({ to: "owner", subject: "QUESTION: which unit", body: "seconds or minutes?", needs: "decision" });
  assert.equal(lead.inbox.length, before, "the old seat is woken by nothing while it is replaced");
  starting.resolve();
  await ended;
  assert.match(successor!.inbox.join("\n"), /subject="QUESTION: which unit"/);
});

test("a STOP goes to one seat and is sent every time; the team is no target for it", async () => {
  const lead = await seat("lead-stop-team", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-stop-team", "claude-peer", lead.agent.id, "[Peer] store");
  await assert.rejects(
    lead.mail({ to: "team", subject: "STOP: everything", body: "Stop.", needs: "nothing" }),
    /"code":"STOP_GOES_DOWN"/,
  );
  const stop = { to: peer.agent.id, subject: "STOP: the plan is wrong", body: "Stop where you are.", needs: "nothing" };
  const first = JSON.parse(await lead.mail(stop)) as { sent: number; replayed?: boolean };
  const again = JSON.parse(await lead.mail(stop)) as { sent: number; replayed?: boolean };
  assert.notEqual(again.sent, first.sent);
  assert.equal(again.replayed, undefined);
});

test("the seat asked for its handoff is archived first: whoever asked is told, and nothing is started", async () => {
  const supervisor = await seat("sup-gone", "claude-supervisor", null, "[Supervisor] law");
  const lead = await seat("lead-gone", "claude-lead", supervisor.agent.id, "[Lead] stream");
  await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id });
  await call("on agent.archived", { agent: lead.agent, archivedAt: new Date().toISOString() }, context);
  assert.match(
    supervisor.inbox.at(-1) ?? (await supervisor.held()),
    /subject="ROTATION FAILED: \[Lead\] stream was archived before its handoff"/,
  );
});

test("the room's own seat runs the room through its tool", async () => {
  const hq = await seat("hq-ops", "claude-hq", null, "HQ Supervisor", join(ROOM_HOME, "hq-seatwork"));
  const lead = await seat("lead-ops", "claude-lead", null, "[Lead] ops", PROJECT);
  const peer = await seat("peer-ops", "claude-peer", lead.agent.id, "[Peer] ops", PROJECT);
  await endTurn(peer, [
    { type: "tool_call", name: "Skill", status: "completed", detail: { type: "plain_text", label: "test-audit" } },
    { type: "assistant_message", text: "STATUS: read the tests" },
  ]);
  const { skills } = JSON.parse(await hq.call("seatwork_room", { do: "skills" }));
  assert.deepEqual(
    skills.loads.filter((one: { skill: string }) => one.skill === "test-audit"),
    [{ role: "peer", skill: "test-audit", loads: 1 }],
  );
  assert.deepEqual(skills.never.peer, ["blast-radius"]);
  const policy = JSON.parse(await hq.call("seatwork_room", { do: "policy" }));
  assert.equal(policy.tunable["knowledge.keepDays"].value, 60);
  const refused = await hq
    .call("seatwork_room", { do: "tune", path: "knowledge.keepDays", value: 30 })
    .catch((error: Error) => error.message);
  assert.deepEqual(JSON.parse(refused).error, {
    code: "BAD_REQUEST",
    message: "read knowledge in this turn first",
    retryable: false,
    next: { tool: "seatwork_room", args: { do: "knowledge" } },
  });
  const skill = {
    do: "skill",
    action: "add",
    role: "peer",
    name: "flaky-retry",
    files: {
      "SKILL.md": "---\nname: flaky-retry\ndescription: A test that passes only on a retry.\n---\nFind the race.\n",
    },
    source: { license: "own" },
    reason: "Peers retried a flaky test three times in one task",
  };
  assert.deepEqual(JSON.parse(await hq.call("seatwork_room", skill)).done, {
    added: "peer/flaky-retry",
    files: ["SKILL.md"],
  });
  assert.match(
    await hq.call("seatwork_room", { ...skill, name: "test-audit" }).catch((error: Error) => error.message),
    /"code":"BAD_REQUEST".*the room ships a skill named test-audit/,
  );
  assert.match(await lead.call("seatwork_room", { do: "skill" }).catch((error: Error) => error.message), /refused/);
});
