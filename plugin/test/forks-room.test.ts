import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
const realFetch = globalThis.fetch;
let dispose: () => Promise<void>;

/** What the decision model is made to say for each fork, and every question it was put. */
const says: Partial<Record<string, string>> = {};
const asked: { fork: string; labels: string[]; state: Record<string, unknown> }[] = [];

/** The fork a question belongs to, read from the labels it offers. */
const forkOf = (labels: string[]): string =>
  labels.includes("milestone")
    ? "rotate"
    : labels.includes("unclear")
      ? "gaps"
      : labels.includes("person")
        ? "escalate"
        : labels.includes("none")
          ? "duplicate"
          : "tier";

/** The model's wire, in the room's own process: the label a test set is answered sure, any other question split. */
async function jev(url: unknown, init?: RequestInit): Promise<Response> {
  if (!String(url).includes("openrouter.ai")) return realFetch(url as string, init);
  const body = JSON.parse(String(init?.body)) as {
    state: Record<string, unknown>;
    questions: Record<string, { criteria: Record<string, unknown> }>;
  };
  const answers = Object.fromEntries(
    Object.entries(body.questions).map(([id, question]) => {
      const labels = Object.keys(question.criteria);
      const fork = forkOf(labels);
      asked.push({ fork, labels, state: body.state });
      const pick = says[fork] && labels.includes(says[fork]) ? says[fork]! : null;
      const rest = pick ? 0.03 / (labels.length - 1) : 1 / labels.length;
      const probabilities = Object.fromEntries(labels.map((label) => [label, label === pick ? 0.97 : rest]));
      return [id, { type: "choice", choice: pick ?? labels[0], probabilities, confidence: pick ? 0.97 : rest }];
    }),
  );
  return new Response(JSON.stringify({ model: "m", answers, usage: { input_tokens: 100, cost: 0.00001 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

before(() => {
  installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "claude-lens"]);
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.jev.forks = ["tier", "gaps", "escalate", "duplicate", "rotate"];
  policy.knowledge.gate = false;
  policy.safety.council.mode = "off";
  writeFileSync(file, JSON.stringify(policy));
  mkdirSync(join(ROOM_HOME, "jev"), { recursive: true });
  writeFileSync(join(ROOM_HOME, "jev", "openrouter.key"), "test-key\n");
  globalThis.fetch = jev as typeof fetch;
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  globalThis.fetch = realFetch;
  Object.assign(console, output);
});

const agents: Record<string, object> = {};
const context = { paseo: { agents: { ref: (id: string) => agents[id], list: async () => ({ entries: [] }) } } };

interface TestSeat {
  agent: { id: string; parentAgentId: string | null; provider: string; cwd: string; title: string; workspaceId: null };
  inbox: string[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  mail(args: Record<string, unknown>): Promise<string>;
}

async function seat(
  id: string,
  provider: string,
  parent: string | null,
  title: string,
  cwd = PROJECT,
): Promise<TestSeat> {
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
  return { agent, inbox, call: tool, mail: (args) => tool("seatwork_mail", args) };
}

const turnEnds = (who: TestSeat, text: string) =>
  call(
    "on agent.turn_ended",
    { agent: who.agent, turnId: null, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text }] },
    context,
  );

/** A folder the room reads as a project of its own, so its seats share one work store. */
function projectFolder(name: string): string {
  const folder = join(PROJECT, "..", name);
  mkdirSync(join(folder, ".seatwork"), { recursive: true });
  writeFileSync(join(folder, ".seatwork", "room.json"), "{}");
  return folder;
}

const reset = () => {
  for (const key of Object.keys(says)) delete says[key];
  asked.length = 0;
};

test("a seat created with no model starts on the tier the decision model is sure of; a model its creator names stands, and the model is not asked", async () => {
  reset();
  const create = async (config: object) =>
    (
      (await call("before agent.create", {
        request: { config: { provider: "claude-peer", cwd: PROJECT, title: "[Peer] fix a typo", ...config }, env: {} },
      })) as { config: { model?: string } }
    ).config.model;
  assert.equal(await create({}), "claude-haiku-5-5", "split: the table's first model");
  says.tier = "default";
  asked.length = 0;
  assert.equal(await create({ title: "[Peer] repair the payment retry" }), "claude-sonnet-5-5");
  assert.deepEqual(
    asked.map((one) => [one.fork, one.labels]),
    [["tier", ["cheap", "default", "extra"]]],
  );
  assert.equal(await create({ model: "claude-haiku-5-5" }), "claude-haiku-5-5");
  assert.equal(asked.length, 1, "the creator's choice is not put to the model");
});

test("a question a Peer mails its Owner goes to the seat the model names, the Owner copied; the Owner reads it when the model is unsure", async () => {
  reset();
  const project = projectFolder("forks-escalate");
  const supervisor = await seat("sup-esc", "claude-supervisor", null, "[Supervisor] law", project);
  const lead = await seat("lead-esc", "claude-lead", supervisor.agent.id, "[Lead] stream", project);
  const peer = await seat("peer-esc", "claude-peer", lead.agent.id, "[Peer] store", project);
  const question = {
    to: "owner",
    subject: "QUESTION: which vendor",
    body: "Two fit; one costs more.",
    needs: "decision",
  };

  await peer.mail(question);
  assert.equal(lead.inbox.length, 1, "unsure: the Owner has it");
  assert.equal(supervisor.inbox.length, 0);

  says.escalate = "person";
  const sent = JSON.parse(await peer.mail({ ...question, body: "Two fit; one costs more money." }));
  assert.deepEqual(sent.to, ["supervisor sup-esc"]);
  assert.match(supervisor.inbox.at(-1)!, /bring it to the person/);
  assert.equal(lead.inbox.length, 1, "a copy waits for the Owner's next mail, it starts no turn");
  assert.match(await lead.call("seatwork_inbox", {}), /money/);
});

test("a claimed issue is read for what it lacks and a new one for what it repeats, through the work tool", async () => {
  reset();
  const project = projectFolder("forks-work");
  const lead = await seat("lead-work", "claude-lead", null, "[Lead] stream", project);
  const peer = await seat("peer-work", "claude-peer", lead.agent.id, "[Peer] store", project);
  const made = async (title: string) =>
    JSON.parse(await lead.call("seatwork_work", { do: "create", title })) as { id: string; duplicate_of?: string };

  const first = await made("Add paging to the orders list");
  assert.equal(first.duplicate_of, undefined);
  says.duplicate = first.id;
  const second = await made("Paging for the orders list");
  assert.equal(second.duplicate_of, first.id);
  assert.match(await lead.call("seatwork_work", { do: "show", id: second.id }), /"type":"related"|related/);

  says.gaps = "unclear";
  const claimed = JSON.parse(await peer.call("seatwork_work", { do: "claim", id: first.id })) as { note: string };
  assert.match(claimed.note, /search the room's record \(seatwork_knowledge\), the code and the docs/);
  const listed = JSON.parse(await peer.call("seatwork_work", { do: "list", issue_type: "question" })) as {
    issues: { title: string; assignee: string }[];
  };
  assert.deepEqual(
    listed.issues.map((one) => [one.title, one.assignee]),
    [["Research: Add paging to the orders list", "peer-work"]],
  );

  says.gaps = "ready";
  const plain = JSON.parse(await peer.call("seatwork_work", { do: "claim", id: second.id })) as { note?: string };
  assert.equal(plain.note, undefined);
});

test("a seat nearing the rotation line is named to its Owner at a milestone and left alone in the middle of its work", async () => {
  reset();
  const lead = await seat("lead-early", "claude-lead", null, "[Lead] stream");
  const peer = await seat("peer-early", "claude-peer", lead.agent.id, "[Peer] store");
  const holds = (tokens: number) =>
    Object.assign(agents[peer.agent.id], {
      current: () => ({ status: "idle", lastUsage: { contextWindowUsedTokens: tokens } }),
    });

  holds(100_000);
  says.rotate = "milestone";
  await turnEnds(peer, "DONE abc1\nthe endpoint is finished and handed in");
  assert.equal(asked.length, 0, "under the share of the line the model is not asked");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[room\]/);

  holds(150_000);
  await turnEnds(peer, "DONE abc2\nthe next endpoint is finished too");
  assert.match(lead.inbox.at(-1)!, /\[room\] This Peer holds 150K tokens of context [^"]* goes to a new Peer\./);
  assert.equal(asked.length, 1);

  says.rotate = "mid_work";
  await turnEnds(peer, "STATUS\nhalf the migration is written, the tests next");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[room\]/);
  says.rotate = undefined;
  await turnEnds(peer, "STATUS\nstill on the migration");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[room\]/, "unsure: nothing changes");
});

test("a task sent back twice: its Lead is told the tier a new Peer starts on, and a successor the room makes starts on it", async () => {
  reset();
  const project = projectFolder("forks-raise");
  const lead = await seat("lead-raise", "claude-lead", null, "[Lead] stream", project);
  const peer = await seat("peer-raise", "claude-peer", lead.agent.id, "[Peer] store", project);
  const handsIn = async (text: string) => {
    await turnEnds(peer, text);
    if (!/subject="HAND-IN RETURNED/.test(peer.inbox.at(-1) ?? "")) return;
    peer.inbox.pop();
    await turnEnds(peer, text);
  };
  Object.assign(agents[peer.agent.id], {
    current: () => ({ status: "idle", provider: "claude-peer", model: "claude-haiku-5-5", cwd: project }),
  });
  const receipts: string[] = [];
  for (const round of ["abc1", "abc2"]) {
    await handsIn(`CANDIDATE ${round}\ntry`);
    receipts.push(
      await lead.mail({ to: peer.agent.id, subject: `REJECT ${round}: not yet`, body: "Repair it.", needs: "nothing" }),
    );
  }
  assert.doesNotMatch(receipts[0], /tier up/);
  assert.match(
    receipts[1],
    /"note":"Sent back twice: a new peer for the repair starts a tier up, on claude-peer\/claude-sonnet-5-5\. Name that model when you create it\."/,
  );
  const made: { config: { provider: string } }[] = [];
  Object.assign(context.paseo.agents, {
    create: async (options: { config: { provider: string }; title?: string; parent?: string }) => {
      made.push(options);
      const next = await seat("peer-raise-2", "claude-peer", options.parent ?? null, options.title ?? "", project);
      return { id: next.agent.id };
    },
  });
  Object.assign(agents[peer.agent.id], {
    archive: async () => {},
    timeline: { refetch: async () => ({ entries: [], agent: { pendingPermissions: [] } }) },
  });
  await lead.call("seatwork_rotate", { agent_id: peer.agent.id });
  await turnEnds(peer, "HANDOFF\nCURRENT TASK: the store\nPROGRESS: half\nBLOCKERS: none");
  assert.equal(made[0].config.provider, "claude-peer/claude-sonnet-5-5");
  assert.match(
    await lead.call("seatwork_inbox", {}),
    /on claude-sonnet-5-5 \(a tier up: its task was sent back twice\)/,
  );
});

test("what a Lead recorded as a task's decision before its first claim follows the task to its issue", async () => {
  reset();
  const project = projectFolder("forks-keys");
  const supervisor = await seat("sup-keys", "claude-supervisor", null, "[Supervisor] keys", project);
  const lead = await seat("lead-keys", "claude-lead", supervisor.agent.id, "[Lead] keys", project);
  const inForce = async () =>
    (JSON.parse(await lead.call("seatwork_knowledge", { do: "list" })) as { inForce: string[] }).inForce.join("\n");
  const issue = JSON.parse(await supervisor.call("seatwork_work", { do: "create", title: "the store" })) as {
    id: string;
  };

  await lead.call("seatwork_knowledge", {
    do: "decide",
    scope: "task",
    topic: "store engine",
    statement: "Keep the store in SQLite.",
  });
  assert.match(await inForce(), /\[task lead-keys\] store-engine: Keep the store in SQLite/);

  await lead.call("seatwork_work", { do: "claim", id: issue.id });
  assert.match(await inForce(), new RegExp(`\\[task ${issue.id}\\] store-engine: Keep the store in SQLite`));
  assert.doesNotMatch(await inForce(), /\[task lead-keys\]/);
});
