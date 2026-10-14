import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { briefFields } from "../server/orchestration/brief";
import { parseHandoff } from "../server/orchestration/rotation";
import { TaskKeys } from "../server/orchestration/task-keys";
import { MailEngine } from "../server/coordination/engine";
import type { LiveSeat } from "../server/host";
import { lookAtRunningTurns } from "../server/room/council";
import type { RoomContext } from "../server/room/context";
import { Safety } from "../server/safety/index";
import { WorkStore } from "../server/tasks/store";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "claude-lens"]);
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
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

interface TestSeat {
  agent: { id: string; parentAgentId: string | null; provider: string; cwd: string; title: string; workspaceId: null };
  inbox: string[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
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
  return { agent, inbox, call: tool };
}

const turnEnds = (who: TestSeat, text: string) =>
  call(
    "on agent.turn_ended",
    { agent: who.agent, turnId: null, outcome: { kind: "completed" }, timeline: [{ type: "assistant_message", text }] },
    context,
  );

test("an ended turn asks the work store which task the seat holds once, not once for each thing that wants to know", async () => {
  const project = join(PROJECT, "..", "taskof-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  writeFileSync(join(project, ".seatwork", "room.json"), "{}");
  const lead = await seat("lead-taskof", "claude-lead", null, "[Lead] stream", project);
  const peer = await seat("peer-taskof", "claude-peer", lead.agent.id, "[Peer] store", project);
  const made = JSON.parse(await lead.call("seatwork_work", { do: "create", title: "store" })) as { id: string };
  await peer.call("seatwork_work", { do: "claim", id: made.id });

  const real = WorkStore.prototype.list;
  let asked = 0;
  WorkStore.prototype.list = function (this: WorkStore, ...args: Parameters<WorkStore["list"]>) {
    if (args[0]?.assignee) asked += 1;
    return real.apply(this, args);
  };
  try {
    // the Lead's delivery asks once more for its own decisions: that is the knowledge district's
    await turnEnds(peer, "QUESTION\nwhich unit?");
    assert.ok(asked <= 2, `a question ended a turn and the store was asked ${asked} times`);
    asked = 0;
    await turnEnds(peer, "CANDIDATE abc1\nfirst");
    assert.ok(asked <= 2, `a candidate ended a turn and the store was asked ${asked} times`);
  } finally {
    WorkStore.prototype.list = real;
  }
});

test("a report still goes up when the room cannot add its own lines under it", async () => {
  const lead = await seat("lead-lines", "claude-lead", null, "[Lead] lines");
  const peer = await seat("peer-lines", "claude-peer", lead.agent.id, "[Peer] lines");
  const real = Safety.prototype.blocksLine;
  Safety.prototype.blocksLine = () => {
    throw new Error("database is locked");
  };
  try {
    await turnEnds(peer, "QUESTION\nwhich unit?");
  } finally {
    Safety.prototype.blocksLine = real;
  }
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="QUESTION from peer/);
});

test("a rotation whose successor stands is not reported as failed when a later step of it does not work", async () => {
  const supervisor = await seat("sup-late", "claude-supervisor", null, "[Supervisor] late");
  const lead = await seat("lead-late", "claude-lead", supervisor.agent.id, "[Lead] late");
  let started = 0;
  Object.assign(context.paseo.agents, {
    create: async (options: { parent?: string; title?: string }) => {
      started += 1;
      const next = await seat("lead-late-2", "claude-lead", options.parent ?? null, options.title ?? "");
      return { id: next.agent.id };
    },
  });
  Object.assign(agents[lead.agent.id], {
    current: () => ({ status: "idle", provider: "claude-lead", model: "claude-opus-5-5", cwd: PROJECT }),
    archive: async () => {},
    timeline: { refetch: async () => ({ entries: [], agent: { pendingPermissions: [] } }) },
  });
  await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id });

  const real = MailEngine.prototype.move;
  MailEngine.prototype.move = async () => {
    throw new Error("store busy");
  };
  try {
    await turnEnds(lead, "HANDOFF\nCURRENT TASK: the store\nPROGRESS: done 2ea3368\nBLOCKERS: none");
  } finally {
    MailEngine.prototype.move = real;
  }
  assert.equal(started, 1);
  assert.doesNotMatch(
    supervisor.inbox.join("\n"),
    /ROTATION FAILED/,
    "a successor stands and its Owner was told it does not",
  );
  assert.match(await supervisor.call("seatwork_inbox", {}), /ROTATED: lead \[Lead\] late continues in a fresh seat/);
});

test("the council's look at running turns goes on to the next seat when one cannot be looked at", async () => {
  const running = (title: string) => ({ status: "running", cwd: PROJECT, title }) as LiveSeat;
  const posted: string[] = [];
  const logs: string[] = [];
  const room = {
    log: (line: string) => logs.push(line),
    host: {
      live: async () =>
        new Map([
          ["seat-a", running("A")],
          ["seat-b", running("B")],
        ]),
      turn: async () => [],
    },
    works: { existing: () => null },
    taskKeys: new TaskKeys(join(ROOM_HOME, "council-keys.json")),
    engine: {
      seat: () => ({ role: "peer" }),
      projectOf: () => PROJECT,
      parentOf: () => "owner-1",
      post: async (mail: { subject: string }) => void posted.push(mail.subject),
    },
    safety: {
      council: {
        whileRunning: (seat: { id: string }) => {
          if (seat.id === "seat-a") throw new Error("a timeline that cannot be read");
          return [{ member: "stuck", line: "the same command four times", level: 1 }];
        },
      },
    },
  } as unknown as RoomContext;
  await lookAtRunningTurns(room);
  assert.deepEqual(posted, ["COUNCIL: stuck on B"]);
  assert.match(logs[0], /seat-a.*cannot be read/);
});

test("the reason a seat is asked for its handoff is a clause, whatever length it was given", async () => {
  const supervisor = await seat("sup-why", "claude-supervisor", null, "[Supervisor] why");
  const lead = await seat("lead-why", "claude-lead", supervisor.agent.id, "[Lead] why");
  await supervisor.call("seatwork_rotate", { agent_id: lead.agent.id, why: "context ".repeat(5000) });
  assert.ok(lead.inbox[0].length < 4000, `the request was ${lead.inbox[0].length} characters`);
});

test("the reasons a seat gives to keep a finding or to label one are kept as a sentence, not as long as it wrote them", async () => {
  const lead = await seat("lead-reason", "claude-lead", null, "[Lead] reason");
  const peer = await seat("peer-reason", "claude-peer", lead.agent.id, "[Peer] reason");
  const kept: number[] = [];
  const [acknowledge, label] = [Safety.prototype.acknowledge, Safety.prototype.label];
  Safety.prototype.acknowledge = (_by: string, _id: string, reason: string) => (kept.push(reason.length), false);
  Safety.prototype.label = (_by: string, _id: number, _value: "right" | "wrong", reason: string) => (
    kept.push(reason.length),
    "noted"
  );
  try {
    await peer.call("seatwork_safety", { action: "ack", id: "abc", reason: "because ".repeat(2000) });
    await lead.call("seatwork_safety", { action: "label", id: "1", value: "right", reason: "because ".repeat(2000) });
  } finally {
    Object.assign(Safety.prototype, { acknowledge, label });
  }
  assert.equal(kept.length, 2);
  assert.ok(
    kept.every((length) => length <= 500),
    `reasons of ${kept.join(" and ")} characters were kept`,
  );
});

test("a mail names a bounded number of recipients, files and a bounded thread", async () => {
  const lead = await seat("lead-bounds", "claude-lead", null, "[Lead] bounds");
  const peer = await seat("peer-bounds", "claude-peer", lead.agent.id, "[Peer] bounds");
  const note = { subject: "INSTRUCTION: start", body: "Go.", needs: "nothing" };
  const refused = (args: Record<string, unknown>) =>
    lead.call("seatwork_mail", { ...note, ...args }).then(
      () => "sent",
      (error: Error) => (JSON.parse(error.message) as { error: { code: string } }).error.code,
    );

  assert.equal(await refused({ to: Array(60).fill(peer.agent.id) }), "INVALID_ARGUMENT");
  assert.equal(await refused({ to: peer.agent.id, cc: Array(60).fill(peer.agent.id) }), "INVALID_ARGUMENT");
  assert.equal(await refused({ to: peer.agent.id, files: Array(60).fill(PROJECT) }), "INVALID_ARGUMENT");
  assert.equal(await refused({ to: peer.agent.id, thread: "t".repeat(300) }), "INVALID_ARGUMENT");
  assert.deepEqual(peer.inbox, [], "a refused mail was sent");
  assert.equal(await refused({ to: [peer.agent.id, peer.agent.id] }), "sent");
});

test("seatwork_seats lists the seats under a seat in tree order, each nested under its Owner", async () => {
  const supervisor = await seat("sup-tree", "claude-supervisor", null, "[Supervisor] tree");
  const lead = await seat("lead-tree", "claude-lead", supervisor.agent.id, "[Lead] tree");
  const other = await seat("lead-tree-2", "claude-lead", supervisor.agent.id, "[Lead] tree two");
  await seat("peer-tree-a", "claude-peer", lead.agent.id, "[Peer] a");
  await seat("peer-tree-b", "claude-peer", other.agent.id, "[Peer] b");
  await seat("peer-tree-c", "claude-peer", lead.agent.id, "[Peer] c");

  const view = await supervisor.call("seatwork_seats", {});
  const rows = view
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/ · .*/, ""));
  assert.deepEqual(rows, [
    "- lead [Lead] tree",
    "  - peer [Peer] a",
    "  - peer [Peer] c",
    "- lead [Lead] tree two",
    "  - peer [Peer] b",
  ]);
  assert.match(view, /^5 open seats under you, 0 at work\./);
});

const BIG = [10_000, 40_000];

/** The fastest of a few runs: a loaded machine slows a run, never speeds one up. */
function fastest(run: () => unknown, times = 7): number {
  run();
  let best = Infinity;
  for (let i = 0; i < times; i += 1) {
    const start = process.hrtime.bigint();
    run();
    best = Math.min(best, Number(process.hrtime.bigint() - start));
  }
  return best;
}

test("a final message of many empty or ruled lines is read in time that grows with its length", () => {
  for (const line of ["\n", "-\n", "1.\n"]) {
    const [small, large] = BIG.map((lines) =>
      fastest(() => parseHandoff(`${line.repeat(lines)}CURRENT TASK: x\nPROGRESS: y`)),
    );
    assert.ok(
      large < small * 8,
      `${JSON.stringify(line)}: 4 times the lines took ${(large / small).toFixed(1)} times as long`,
    );
  }
});

test("a brief line of a label and many spaces is read in time that grows with its length", () => {
  const [small, large] = BIG.map((n) => fastest(() => briefFields(`a${" ".repeat(n)}x`)));
  assert.ok(large < small * 8, `4 times the spaces took ${(large / small).toFixed(1)} times as long`);
});

/** A folder the room reads as a project of its own, so its seats share one work store. */
function projectFolder(name: string): string {
  const folder = join(PROJECT, "..", name);
  mkdirSync(join(folder, ".seatwork"), { recursive: true });
  writeFileSync(join(folder, ".seatwork", "room.json"), "{}");
  return folder;
}

/** `owner` asks `old` for its handoff, `old` answers with `handoff`, and the successor is the seat the room made. */
async function rotated(
  owner: TestSeat,
  old: TestSeat,
  project: string,
  handoff: string,
  on = { provider: "claude-lead", model: "claude-opus-5-5" },
): Promise<{ successor: TestSeat; prompt: string; archived: string[] }> {
  let made: { successor: TestSeat; prompt: string; archived: string[] } | undefined;
  const archived: string[] = [];
  Object.assign(context.paseo.agents, {
    create: async (options: { parent?: string; title?: string; prompt?: string }) => {
      const successor = await seat(
        `${old.agent.id}-2`,
        on.provider,
        options.parent ?? null,
        options.title ?? "",
        project,
      );
      made = { successor, prompt: options.prompt ?? "", archived };
      return { id: successor.agent.id };
    },
  });
  Object.assign(agents[old.agent.id], {
    current: () => ({ status: "idle", ...on, cwd: project }),
    archive: async () => void archived.push(old.agent.id),
    timeline: { refetch: async () => ({ entries: [], agent: { pendingPermissions: [] } }) },
  });
  await owner.call("seatwork_rotate", { agent_id: old.agent.id });
  await turnEnds(old, handoff);
  assert.ok(made, "the room started no successor");
  return made;
}

const HANDOFF = "HANDOFF\nCURRENT TASK: the store\nPROGRESS: done 2ea3368\nBLOCKERS: none";

const inForce = async (who: TestSeat): Promise<string[]> =>
  (JSON.parse(await who.call("seatwork_knowledge", { do: "list" })) as { inForce: string[] }).inForce;

test("the decisions of a task stay with it when its issue is closed and follow the seat that takes the seat over; another claim leaves them", async () => {
  const project = projectFolder("keys-project");
  const supervisor = await seat("sup-keys", "claude-supervisor", null, "[Supervisor] keys", project);
  const lead = await seat("lead-keys", "claude-lead", supervisor.agent.id, "[Lead] keys", project);
  const made = (title: string) =>
    supervisor
      .call("seatwork_work", { do: "create", title })
      .then((answer) => (JSON.parse(answer) as { id: string }).id);
  const [first, second] = [await made("the store"), await made("the cache")];
  await lead.call("seatwork_work", { do: "claim", id: first });
  await lead.call("seatwork_knowledge", {
    do: "decide",
    scope: "task",
    topic: "store engine",
    statement: "Keep the store in SQLite.",
  });
  assert.match((await inForce(lead)).join("\n"), /Keep the store in SQLite/);

  // the Owner closes the issue while the seat is still at work on the task
  await supervisor.call("seatwork_work", { do: "close", id: first, reason: "merged with the tests green at abc1234" });
  assert.match((await inForce(lead)).join("\n"), /Keep the store in SQLite/, "closing the issue changed the task");

  const { successor } = await rotated(supervisor, lead, project, HANDOFF);
  assert.match((await inForce(successor)).join("\n"), /Keep the store in SQLite/, "the successor lost the task");

  await successor.call("seatwork_work", { do: "claim", id: second });
  assert.doesNotMatch((await inForce(successor)).join("\n"), /Keep the store in SQLite/);
});

test("a seat that never held an issue is replaced by one that works on the same task", async () => {
  const project = projectFolder("keys-chain");
  const supervisor = await seat("sup-chain", "claude-supervisor", null, "[Supervisor] chain", project);
  const lead = await seat("lead-chain", "claude-lead", supervisor.agent.id, "[Lead] chain", project);
  await lead.call("seatwork_knowledge", {
    do: "decide",
    scope: "task",
    topic: "index kind",
    statement: "Use a covering index for the lookup.",
  });
  const { successor } = await rotated(supervisor, lead, project, HANDOFF);
  assert.match((await inForce(successor)).join("\n"), /\[task lead-chain\] index-kind: Use a covering index/);
  const kept = JSON.parse(readFileSync(join(ROOM_HOME, "task-keys.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(kept["lead-chain-2"], { key: "lead-chain", issue: false, before: ["lead-chain"] });
});

test("the rejections a task has met go with it to the seat that takes the seat over", async () => {
  const project = projectFolder("keys-rounds");
  const lead = await seat("lead-rounds", "claude-lead", null, "[Lead] rounds", project);
  const peer = await seat("peer-rounds", "claude-peer", lead.agent.id, "[Peer] rounds", project);
  // a first hand-in goes back once for a pass with fresh eyes; the next goes up
  await turnEnds(peer, "CANDIDATE abc1\nfirst");
  await turnEnds(peer, "CANDIDATE abc1\nFresh eyes: nothing");
  await lead.call("seatwork_mail", {
    to: peer.agent.id,
    subject: "REJECT abc1: the cost of small ingests",
    body: "Repair it.",
    needs: "nothing",
  });
  const { successor } = await rotated(lead, peer, project, HANDOFF, {
    provider: "claude-peer",
    model: "claude-sonnet-5-5",
  });
  // the app reports the old seat archived: its rounds are the successor's, and stay
  await call("on agent.archived", { agent: peer.agent }, context);
  await turnEnds(successor, "CANDIDATE abc2\nsecond");
  await turnEnds(successor, "CANDIDATE abc2\nFresh eyes: nothing");
  assert.match(lead.inbox.at(-1)!, /\[room\] Second candidate of this task: one rejection/);
});

test("a successor is given the old seat's exact strings, the decisions in force for its task and where the old seat's record is read, and can read it", async () => {
  const project = projectFolder("keys-record");
  const supervisor = await seat("sup-record", "claude-supervisor", null, "[Supervisor] record", project);
  const lead = await seat("lead-record", "claude-lead", supervisor.agent.id, "[Lead] record", project);
  await lead.call("seatwork_knowledge", {
    do: "decide",
    scope: "task",
    topic: "store engine",
    statement: "Keep the store in SQLite.",
  });
  // the old seat's turns are kept as the room sees them end
  await call(
    "on agent.turn_ended",
    {
      agent: lead.agent,
      turnId: "t1",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "Fix the flaky migration in the store." },
        { type: "assistant_message", text: "The migration fails with ERR_CHECKSUM_MISMATCH at step four." },
      ],
    },
    context,
  );
  const exact = "$ npm run migrate -- --step 4\nError: ERR_CHECKSUM_MISMATCH 0x7fff_ffff";
  const { successor, prompt } = await rotated(supervisor, lead, project, `${HANDOFF}\nVERBATIM:\n${exact}`);

  assert.ok(prompt.includes(`\n\`\`\`\n${exact}\n\`\`\`\n`), "the strings reach the successor as the seat wrote them");
  assert.match(
    prompt,
    /## Decisions in force for your task[^\n]*\n[^\n]*\n- \[task lead-record\] store-engine: Keep the store in SQLite/,
  );
  assert.match(prompt, /seatwork_knowledge do=pack task=lead-record/);
  assert.match(prompt, /do=search agent=lead-record/);
  const [file] = readdirSync(join(project, ".seatwork", "handoffs")).filter((name) => name.endsWith(".md"));
  assert.ok(
    readFileSync(join(project, ".seatwork", "handoffs", file), "utf8").includes(`\n\`\`\`\n${exact}\n\`\`\`\n`),
    "the copy for people holds them too",
  );
  assert.ok(prompt.indexOf("## Exact strings") < prompt.indexOf("## Decisions in force for your task"));
  assert.doesNotMatch(prompt.slice(prompt.indexOf("## The handoff"), prompt.indexOf("## Exact strings")), /CHECKSUM/);

  // the successor is not told again what its prompt held, and reads what the old seat did
  const answer = JSON.parse(
    await successor.call("seatwork_knowledge", { do: "search", q: "ERR_CHECKSUM_MISMATCH", agent: lead.agent.id }),
  ) as { hits: { agent: string; text: string }[]; notices?: string[] };
  assert.ok(answer.hits.length > 0 && answer.hits.every((hit) => hit.agent === lead.agent.id));
  assert.equal(answer.notices, undefined);
  const packed = JSON.parse(await successor.call("seatwork_knowledge", { do: "pack", task: "lead-record" })) as {
    items: { agent: string }[];
  };
  assert.ok(packed.items.some((item) => item.agent === lead.agent.id));
  // a seat of another line of work does not
  const other = await seat("lead-other", "claude-lead", supervisor.agent.id, "[Lead] other", project);
  assert.equal(
    (
      JSON.parse(await other.call("seatwork_knowledge", { do: "search", q: "ERR_CHECKSUM_MISMATCH" })) as {
        hits: unknown[];
      }
    ).hits.length,
    0,
  );
});

/** Gives a seat the context its agent CLI reports at the end of its next turn. */
const holds = (who: TestSeat, tokens: number) =>
  Object.assign(agents[who.agent.id], {
    current: () => ({ status: "idle", lastUsage: { contextWindowUsedTokens: tokens } }),
  });

const told = async (who: TestSeat): Promise<string[] | undefined> =>
  (JSON.parse(await who.call("seatwork_knowledge", { do: "list" })) as { notices?: string[] }).notices;

test("a context that falls between two turns is read as a compaction: the seat is told its decisions again, once", async () => {
  const project = projectFolder("keys-fall");
  const lead = await seat("lead-fall", "claude-lead", null, "[Lead] fall", project);
  await lead.call("seatwork_knowledge", {
    do: "decide",
    scope: "task",
    topic: "store engine",
    statement: "Keep the store in SQLite.",
  });
  assert.equal(await told(lead), undefined, "the seat that records a decision is not told it as news");

  holds(lead, 150_000);
  await turnEnds(lead, "STATUS\nstill working");
  assert.equal(await told(lead), undefined, "the first reading has nothing to fall from");
  holds(lead, 190_000);
  await turnEnds(lead, "STATUS\nstill working");
  holds(lead, 120_000);
  await turnEnds(lead, "STATUS\nstill working");
  assert.equal(await told(lead), undefined, "a smaller context is not a compaction");

  holds(lead, 25_000);
  await turnEnds(lead, "STATUS\nstill working");
  const again = await told(lead);
  assert.match(
    again?.join("\n") ?? "",
    /Your context was compacted[\s\S]*New decision: \[task lead-fall\] store-engine/,
  );
  assert.equal(await told(lead), undefined, "told once");
  holds(lead, 30_000);
  await turnEnds(lead, "STATUS\nstill working");
  assert.equal(await told(lead), undefined, "growth after a compaction is not another");

  // the timeline showed this compaction: the context falling with it is the same one
  holds(lead, 190_000);
  await turnEnds(lead, "STATUS\nstill working");
  holds(lead, 20_000);
  await call(
    "on agent.turn_ended",
    {
      agent: lead.agent,
      turnId: null,
      outcome: { kind: "completed" },
      timeline: [
        { type: "compaction", status: "completed" },
        { type: "assistant_message", text: "STATUS\nstill working" },
      ],
    },
    context,
  );
  const shown = (await told(lead))?.filter((line) => line.includes("Your context was compacted"));
  assert.equal(shown?.length, 1);
  assert.equal(await told(lead), undefined);
});
