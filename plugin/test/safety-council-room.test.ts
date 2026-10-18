import { PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { git } from "./support/git";
import { parserRepo, type TestSeat } from "./support/seats";
import type { LiveSeat } from "../server/host";
import { TaskKeys } from "../server/orchestration/task-keys";
import { lookAtRunningTurns } from "../server/room/council";
import type { RoomContext } from "../server/room/context";
import { pluginRoom } from "./support/plugin";

const { call, context, seat, turnEnds, rotatable } = pluginRoom(["claude-supervisor", "claude-lead", "claude-peer"], {
  policy: (policy) => void (policy.safety.council.levels = { report: 1 }),
});

const MESSAGE = "CANDIDATE: parser fixed\nthe bug was at src/parse.js:400";
const COUNCIL = /\[council\] report #\d+: cites &quot;src\/parse\.js:400&quot;, the file has 9 lines/;

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
  const dir = parserRepo("council-fresh");
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
  const dir = parserRepo("council-check");
  const lead = await seat("lead-check", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-check", "claude-peer", lead.agent.id, "[Peer] parser check", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  writeFileSync(join(dir, "test", "a.test.ts"), 'test.only("a", () => expect(1).toBe(1));\n');
  git(dir, "commit", "-qam", "focus");

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

test("a Peer that edits only through its shell is held to the checks it ran after the edit the guard saw", async () => {
  const dir = parserRepo("council-shell");
  const lead = await seat("lead-shell", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-shell", "claude-peer", lead.agent.id, "[Peer] parser shell", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const edit = "python3 - <<'EOF'\np='src/parse.js'\nopen(p,'a').write('const z = 9;\\n')\nEOF";
  const shell = (command: string) => ({
    type: "tool_call",
    status: "completed",
    detail: { type: "shell", command, exitCode: 0, output: "ok" },
  });
  const store = new DatabaseSync(join(ROOM_HOME, "safety", "safety.db"), { readOnly: true });
  const zone = store.prepare("SELECT zone FROM council_readings WHERE member = 'claims' AND seat = ? AND turn = ?");
  for (const [id, steps, read] of [
    ["t1", ["npm test", edit], "found"],
    ["t2", [edit, "npm test"], "clear"],
  ] as const) {
    await call("on agent.turn_started", { agent: peer.agent, turnId: id }, context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await peer.hook("Bash", { command: edit });
    appendFileSync(join(dir, "src", "parse.js"), "const z = 9;\n");
    await call(
      "on agent.turn_ended",
      {
        agent: peer.agent,
        turnId: id,
        outcome: { kind: "completed" },
        timeline: [
          ...steps.map(shell),
          { type: "assistant_message", text: "CANDIDATE: parser fixed\nAll tests pass." },
        ],
      },
      context,
    );
    assert.equal((zone.get(peer.agent.id, id) as { zone: string } | undefined)?.zone, read, steps.join(" then "));
  }
  store.close();
});

test("a finding told with the report a seat kept before its handoff is told once, though the seat is rotated", async () => {
  const dir = parserRepo("council-rotate");
  const lead = await seat("lead-rotate", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-rotate", "claude-peer", lead.agent.id, "[Peer] parser rotate", dir);
  rotatable(peer, "peer-rotate-2", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const done = (lines: string[]) => lines.filter((text) => /subject="DONE/.test(text));

  await lead.call("seatwork_rotate", { agent_id: peer.agent.id });
  await peer.mail({ to: lead.agent.id, subject: "DONE: parser fixed", body: "the bug was at src/parse.js:400" });
  await turnEnds(
    peer,
    "HANDOFF\nCURRENT TASK: the parser\nPROGRESS: fixed the bug at src/parse.js:400\nBLOCKERS: none",
  );
  assert.match(await lead.call("seatwork_inbox", {}), /ROTATED: peer .*parser rotate continues in a fresh seat/);
  assert.equal(done(lead.inbox).length, 1, "the report the seat kept goes up with its handoff");
  assert.match(done(lead.inbox)[0], COUNCIL);

  // the old seat stays when what it launched did not move; it says the same thing again
  await turnEnds(peer, "DONE: parser fixed\nthe bug was at src/parse.js:400");
  assert.equal(done(lead.inbox).length, 2);
  assert.doesNotMatch(done(lead.inbox)[1], /\[council\]/, "and the finding is told once");
});

test("a finding of a seat rotated with no report kept goes up with the word of its rotation, and once", async () => {
  const dir = parserRepo("council-rotate-bare");
  const lead = await seat("lead-bare", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-bare", "claude-peer", lead.agent.id, "[Peer] parser bare", dir);
  rotatable(peer, "peer-bare-2", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));

  await lead.call("seatwork_rotate", { agent_id: peer.agent.id });
  await turnEnds(
    peer,
    "HANDOFF\nCURRENT TASK: the parser\nPROGRESS: fixed the bug at src/parse.js:400\nBLOCKERS: none",
  );
  const rotated = await lead.call("seatwork_inbox", {});
  assert.match(rotated, /ROTATED: peer .*parser bare continues in a fresh seat/);
  assert.match(rotated, COUNCIL);

  // the old seat stays when what it launched did not move; it says the same thing again
  await turnEnds(peer, "DONE: parser fixed\nthe bug was at src/parse.js:400");
  assert.doesNotMatch(lead.inbox.at(-1)!, /\[council\]/, "and the finding is told once");
});

test("the council's look at running turns goes on to the next seat when one cannot be looked at", async () => {
  const running = (title: string) => ({ status: "running", cwd: PROJECT, title }) as LiveSeat;
  const posted: string[] = [];
  const shown: number[] = [];
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
          return [{ id: 7, member: "stuck", line: "the same command four times", level: 1 }];
        },
        shown: (findings: { id: number }[]) => shown.push(...findings.map((finding) => finding.id)),
      },
    },
  } as unknown as RoomContext;
  await lookAtRunningTurns(room);
  assert.deepEqual(posted, ["COUNCIL: stuck on B"]);
  assert.deepEqual(shown, [7], "a finding is shown once its mail is posted");
  assert.match(logs[0], /seat-a.*cannot be read/);
});
