import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";
import { roomSeats, type TestSeat } from "./room-seats";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-supervisor", "claude-lead", "claude-peer"]);
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.safety.council.levels = { report: 1 };
  writeFileSync(file, JSON.stringify(policy));
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

const { context, seat } = roomSeats(call);

const MESSAGE = "CANDIDATE: parser fixed\nthe bug was at src/parse.js:400";
const COUNCIL = /\[council\] report #\d+: cites &quot;src\/parse\.js:400&quot;, the file has 9 lines/;

/** A git repository beside the project with a nine-line source file and a test, committed: where the seats start. */
function repo(name: string): string {
  const dir = join(PROJECT, "..", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "src", "parse.js"),
    Array.from({ length: 9 }, (_, i) => `const n${i} = ${i};`).join("\n") + "\n",
  );
  writeFileSync(join(dir, "test", "a.test.ts"), 'test("a", () => expect(1).toBe(1));\n');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-qm", "start"],
  ])
    execFileSync("git", args, { cwd: dir, env });
  return dir;
}

/** A turn of a seat that starts and ends as the app reports them, with `text` as its final message. */
async function turn(who: TestSeat, text: string, id: string): Promise<void> {
  await call("on agent.turn_started", { agent: who.agent, turnId: id }, context);
  await call(
    "on agent.turn_ended",
    {
      agent: who.agent,
      turnId: id,
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text }],
    },
    context,
  );
}

/** What the Lead has been handed of its Peer's candidates. */
const candidates = (lead: TestSeat) => lead.inbox.filter((text) => /subject="CANDIDATE/.test(text));

test("a finding held back with a candidate that goes back for one pass with fresh eyes is told with the candidate that goes up", async () => {
  const dir = repo("council-fresh");
  const lead = await seat("lead-fresh", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-fresh", "claude-peer", lead.agent.id, "[Peer] parser", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));

  await turn(peer, MESSAGE, "t1");
  assert.match(peer.inbox.at(-1)!, /HAND-IN RETURNED: one pass with fresh eyes/);
  assert.equal(candidates(lead).length, 0);

  await turn(peer, MESSAGE, "t2");
  assert.equal(candidates(lead).length, 1);
  assert.match(candidates(lead)[0], COUNCIL, "the Lead is told what the first hand-in held back");

  await turn(peer, MESSAGE, "t3");
  assert.equal(candidates(lead).length, 2);
  assert.doesNotMatch(candidates(lead)[1], /\[council\]/, "and told once");
});

test("a finding held back with a candidate the hand-in check sends back is told with the candidate that goes up", async () => {
  const dir = repo("council-check");
  const lead = await seat("lead-check", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-check", "claude-peer", lead.agent.id, "[Peer] parser check", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(join(dir, "test", "a.test.ts"), 'test.only("a", () => expect(1).toBe(1));\n');

  await turn(peer, MESSAGE, "t1");
  assert.match(peer.inbox.at(-1)!, /HAND-IN RETURNED: one pass with fresh eyes/);
  await turn(peer, MESSAGE, "t2");
  const returned = peer.inbox.at(-1)!;
  assert.match(returned, /HAND-IN RETURNED: 1 finding\(s\) from the room's check/);
  assert.equal(candidates(lead).length, 0);

  const id = /- ([0-9a-f]{12}) test-focused/.exec(returned)![1];
  await peer.call("seatwork_safety", { action: "ack", id, reason: "the other suites wait on an upstream fix" });
  await turn(peer, MESSAGE, "t3");
  assert.equal(candidates(lead).length, 1);
  assert.match(candidates(lead)[0], COUNCIL);
});
