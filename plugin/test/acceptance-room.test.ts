import assert from "node:assert/strict";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { git } from "./support/git";
import { ROOM_HOME } from "./support/room";
import { parserRepo, type TestSeat } from "./support/seats";
import { editPolicy, pluginRoom } from "./support/plugin";

const { agents, call, context, seat, restart } = pluginRoom(["claude-supervisor", "claude-lead", "claude-peer"]);

const BRIEF = [
  "Outcome: the parser reads one more constant",
  "Write scope: src/parse.js",
  "Contract: the constants keep their values",
  "Acceptance evidence: `npm test` passes",
].join("\n");

/** A shell step of a turn as the app's history keeps it. */
const shell = (command: string, exitCode: number) => ({
  item: { type: "tool_call", status: "completed", detail: { type: "shell", command, exitCode, output: "" } },
  turnId: "lead-turn",
});

/** Gives a seat's history to the room, as `host.turn` reads it. */
function history(who: TestSeat, entries: object[]): void {
  Object.assign(agents[who.agent.id], { timeline: { refetch: async () => ({ entries }) } });
}

/** A Peer's turn that ends with its candidate. */
async function handIn(peer: TestSeat, turnId: string): Promise<void> {
  await call("on agent.turn_started", { agent: peer.agent, turnId }, context);
  await call(
    "on agent.turn_ended",
    {
      agent: peer.agent,
      turnId,
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text: "CANDIDATE: one more constant\nnpm test passes" }],
    },
    context,
  );
}

/** A Supervisor, its Lead and a briefed Peer, the Peer's work committed; `project` makes the folder a project of the room, with a work store. */
async function briefed(name: string, left: Record<string, string> = {}, brief = BRIEF, project = false) {
  const dir = parserRepo(name);
  if (project) {
    mkdirSync(join(dir, ".seatwork"), { recursive: true });
    writeFileSync(join(dir, ".seatwork", "room.json"), "{}");
  }
  const remote = `${dir}-remote.git`;
  rmSync(remote, { recursive: true, force: true });
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "remote", "add", "origin", remote);
  const sup = await seat(`sup-${name}`, "claude-supervisor", null, "[Supervisor] project", dir);
  const lead = await seat(`lead-${name}`, "claude-lead", sup.agent.id, "[Lead] stream", dir);
  const peer = await seat(`peer-${name}`, "claude-peer", lead.agent.id, `[Peer] ${name}`, dir);
  history(peer, [{ item: { type: "user_message", text: brief } }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  appendFileSync(join(dir, "src", "parse.js"), "const n9 = 9;\n");
  git(dir, "commit", "-qam", "one more constant");
  for (const [path, text] of Object.entries(left)) writeFileSync(join(dir, path), text);
  return { dir, sup, lead, peer };
}

/** A seat's turn with `steps` from the app's timeline, ending with `text`. */
async function turnOf(who: TestSeat, turnId: string, steps: object[], text: string): Promise<void> {
  await call("on agent.turn_started", { agent: who.agent, turnId }, context);
  await call(
    "on agent.turn_ended",
    {
      agent: who.agent,
      turnId,
      outcome: { kind: "completed" },
      timeline: [...steps, { type: "assistant_message", text }],
    },
    context,
  );
}

/** The note of a mail tool's answer. */
const noteOf = (receipt: string): string => JSON.parse(receipt).note ?? "";

/** The DONE reports a Supervisor has been handed. */
const dones = (sup: TestSeat) => sup.inbox.filter((text) => /subject="DONE/.test(text));

/** Rows of a table of the safety store. */
function rows(sql: string, ...params: string[]): Record<string, unknown>[] {
  const store = new DatabaseSync(join(ROOM_HOME, "safety", "safety.db"), { readOnly: true });
  try {
    return store
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }));
  } finally {
    store.close();
  }
}

/** What the Lead has been handed of its Peer's candidates. */
const candidates = (lead: TestSeat) => lead.inbox.filter((text) => /subject="CANDIDATE/.test(text));

/** A Lead and Peer whose committed candidate reached the Lead. */
async function handedIn(name: string, brief = BRIEF) {
  const { dir, sup, lead, peer } = await briefed(name, {}, brief);
  await handIn(peer, "p1");
  await handIn(peer, "p2");
  assert.equal(candidates(lead).length, 1, "the candidate reached the Lead");
  return { dir, sup, lead, peer };
}

/** The ACCEPTs the gate passed, as the safety store keeps them. */
function accepts(writer: string): { task: string; head: string; digest: string; commands: string }[] {
  const store = new DatabaseSync(join(ROOM_HOME, "safety", "safety.db"), { readOnly: true });
  try {
    return store.prepare("SELECT task, head, digest, commands FROM accepts WHERE writer = ?").all(writer) as never;
  } finally {
    store.close();
  }
}

/** The Lead's ACCEPT: its answer, and the mail as the Peer reads it. */
async function accept(
  lead: TestSeat,
  peer: TestSeat,
  body = "Read and run.",
): Promise<{ receipt: string; mail: string }> {
  const receipt = await lead.mail({ to: peer.agent.id, subject: "ACCEPT: one more constant", body });
  const mail = [...peer.inbox, await peer.held()].filter((text) => text.includes(body));
  return { receipt, mail: mail.at(-1) ?? "" };
}

test("an ACCEPT given in a turn that did not run the brief's acceptance check says so to its Lead", async () => {
  const { lead, peer } = await handedIn("accept-unrun");
  history(lead, [shell("npm test 2>&1 | tail -5", 0)]);
  const note = noteOf((await accept(lead, peer)).receipt);
  assert.match(note, /\[room\] acceptance gate: .*`npm test`/);
  assert.match(note, /piped/, "and names why the run seen proves nothing");
});

test("the acceptance gate's line goes to the Lead and under its next report up, never down to the writer", async () => {
  const { sup, lead, peer } = await handedIn("accept-reader");
  history(lead, []);
  const { receipt, mail } = await accept(lead, peer);
  assert.match(noteOf(receipt), /acceptance gate/);
  assert.doesNotMatch(mail, /\[room\]/, "the writer can do nothing about its Lead's run");
  await turnOf(lead, "l1", [], "DONE: one more constant");
  assert.match(
    dones(sup)[0],
    /\[room\] acceptance gate on \[Peer\] accept-reader: the accepting turn has no passing run/,
  );
  await turnOf(lead, "l2", [], "DONE: one more constant, again");
  assert.doesNotMatch(dones(sup).at(-1)!, /acceptance gate/, "and it is said once");
});

test("an ACCEPT on work that changed after it was handed in says so to its Lead", async () => {
  const { dir, lead, peer } = await handedIn("accept-changed");
  history(lead, [shell("npm test", 0)]);
  appendFileSync(join(dir, "src", "parse.js"), "const n10 = 10;\n");
  const note = noteOf((await accept(lead, peer)).receipt);
  assert.match(note, /\[room\] acceptance gate: .*changed after it was handed in/);
  assert.doesNotMatch(note, /`npm test`/, "the run the turn made is not called missing");
});

test("an ACCEPT the facts bear out carries no line, and is kept with the commit, digest and commands it was given on", async () => {
  const { dir, lead, peer } = await handedIn("accept-kept");
  history(lead, [shell("cd /tmp/copy && npm test", 0)]);
  const { mail } = await accept(lead, peer);
  assert.doesNotMatch(mail, /\[room\]/);
  const [kept, ...more] = accepts(peer.agent.id);
  assert.equal(more.length, 0);
  assert.equal(kept.head, git(dir, "rev-parse", "HEAD"));
  assert.match(kept.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(kept.commands), ["npm test"]);
  assert.ok(kept.task);
});

test("work handed in uncommitted goes back to its writer, and the finding it acknowledged must be waived by name in the ACCEPT", async () => {
  const { lead, peer } = await briefed("accept-waive", { "notes.txt": "scratch\n" });
  await handIn(peer, "p1");
  await handIn(peer, "p2");
  const returned = peer.inbox.at(-1)!;
  assert.match(returned, /HAND-IN RETURNED: 1 finding\(s\)/);
  const id = /- ([0-9a-f]{12}) uncommitted at notes\.txt: 1 file\(s\) not committed: notes\.txt/.exec(returned)![1];
  await peer.call("seatwork_safety", { action: "ack", id, reason: "the notes are the Peer's scratch, not the work" });
  await handIn(peer, "p3");
  assert.equal(candidates(lead).length, 1);
  history(lead, [shell("npm test", 0)]);

  const bare = await accept(lead, peer);
  assert.match(noteOf(bare.receipt), new RegExp(`not waived: ${id} uncommitted at notes\\.txt`));
  assert.equal(accepts(peer.agent.id).length, 0, "an ACCEPT with a gap is not kept");
  const waived = await accept(
    lead,
    peer,
    `Read and run.\nwaive ${id.slice(0, 8)}: the notes file is scratch and stays out`,
  );
  assert.doesNotMatch(noteOf(waived.receipt), /acceptance gate/);
  assert.equal(accepts(peer.agent.id).length, 1);
});

test("an ACCEPT over a review's P0 or P1 finding on that head names it until the ACCEPT waives it by name", async () => {
  const { dir, lead, peer } = await handedIn("accept-reviewed");
  const head = git(dir, "rev-parse", "HEAD");
  const reviewer = await seat("rev-accept-reviewed", "claude-peer", lead.agent.id, "[Peer:review] parser", dir);
  await turnOf(
    reviewer,
    "r1",
    [],
    `REVIEW: NOT YET: the new constant breaks the order\nRead ${head.slice(0, 8)}.\n- P1 src/parse.js:10 n9 sorts before n8; repair: keep the order\n- P3 src/parse.js:1 a comment would help\nNo P0.`,
  );
  history(lead, [shell("npm test", 0)]);
  const note = noteOf((await accept(lead, peer)).receipt);
  const found = /review finding\(s\) on this head not waived: ([0-9a-f]{12}) /.exec(note);
  assert.ok(found, note);
  assert.match(note, /n9 sorts before n8/);
  assert.doesNotMatch(note, /a comment would help|No P0/, "only P0 and P1 lines are findings");
  const waived = noteOf(
    (await accept(lead, peer, `Read and run.\nwaive ${found![1]}: the order is free, the spec says so`)).receipt,
  );
  assert.doesNotMatch(waived, /review finding/);
});

test("an acceptance copy is the commit the candidate was handed in at, with what the tree gained since left out", async () => {
  const { dir, lead, peer } = await handedIn("accept-copy");
  mkdirSync(join(dir, "node_modules"));
  appendFileSync(join(dir, "src", "parse.js"), "const n10 = 10;\n");
  const said = await lead.call("seatwork_safety", { action: "copy", seat: peer.agent.id });
  const copy = /at (\S+): the commit/.exec(said)![1];
  const text = readFileSync(join(copy, "src", "parse.js"), "utf8");
  assert.match(text, /const n9 = 9;/);
  assert.doesNotMatch(text, /n10/);
  assert.ok(lstatSync(join(copy, "node_modules")).isSymbolicLink(), "the installed dependencies are linked");
  assert.ok(copy.startsWith(ROOM_HOME), "the copy lies in the room home, where GC clears it");
});

test("a run narrowed to some tests, or of another script that starts with the brief's command, is no run of that command", async () => {
  const brief = BRIEF.replace("`npm test` passes", "`npm run e2e` passes on the user's path");
  const { lead, peer } = await handedIn("accept-narrow", brief);
  history(lead, [shell("npm run e2e:unit", 0), shell("npm run e2e -- test/unit.spec.ts", 0)]);
  assert.match(noteOf((await accept(lead, peer)).receipt), /\[room\] acceptance gate: .*`npm run e2e`/);
});

test("a DONE whose integrated head lacks an accepted head says so under the report", async () => {
  const { dir, sup, lead, peer } = await handedIn("done-missing");
  history(lead, [shell("npm test", 0)]);
  await accept(lead, peer);
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  await turnOf(
    lead,
    "l1",
    [shell("npm test", 0).item],
    "DONE: one more constant\nnpm test passes on the integrated head",
  );
  assert.equal(dones(sup).length, 1);
  assert.match(dones(sup)[0], /\[room\] done gate: .*accepted head [0-9a-f]{8} .*is not in HEAD/);
});

test("a DONE after an accepted file changed, from a turn that did not run the acceptance check, says both", async () => {
  const { dir, sup, lead, peer } = await handedIn("done-changed");
  history(lead, [shell("npm test", 0)]);
  await accept(lead, peer);
  appendFileSync(join(dir, "src", "parse.js"), "const n10 = 10;\n");
  git(dir, "commit", "-qam", "a later edit");
  await turnOf(lead, "l1", [], "DONE: one more constant");
  assert.match(dones(sup)[0], /\[room\] done gate: .*`npm test`/);
  assert.match(dones(sup)[0], /src\/parse\.js changed after its ACCEPT/);
});

test("a DONE over an accepted file changed and left uncommitted says the task reopens", async () => {
  const { dir, sup, lead, peer } = await handedIn("done-loose");
  history(lead, [shell("npm test", 0)]);
  await accept(lead, peer);
  appendFileSync(join(dir, "src", "parse.js"), "const n10 = 10;\n");
  await turnOf(lead, "l1", [shell("npm test", 0).item], "DONE: one more constant");
  assert.match(dones(sup)[0], /\[room\] done gate: task .* reopens: src\/parse\.js changed after its ACCEPT/);
});

test("a DONE over accepted work whose TEMPORARY line names no open issue says where, and one that names an open issue passes", async () => {
  const { dir, sup, lead, peer } = await briefed("done-temporary", {}, BRIEF, true);
  const issue = (
    JSON.parse(await lead.call("seatwork_work", { do: "create", title: "drop the fallback" })) as {
      id: string;
    }
  ).id;
  appendFileSync(
    join(dir, "src", "parse.js"),
    `// TEMPORARY: until ${issue} lands\nconst n10 = 10;\n// TEMPORARY: until the cache is fixed\n`,
  );
  git(dir, "commit", "-qam", "a fallback");
  await handIn(peer, "p1");
  await handIn(peer, "p2");
  history(lead, [shell("npm test", 0)]);
  await accept(lead, peer);
  await turnOf(lead, "l1", [shell("npm test", 0).item], "DONE: one more constant");
  const line = dones(sup)[0].match(/\[room\] done gate: .*/)?.[0] ?? "";
  assert.match(line, /`TEMPORARY` .*src\/parse\.js:13/);
  assert.doesNotMatch(line, /src\/parse\.js:11/, "a line naming an open issue stands");
});

test("a push of commits no ACCEPT covers is an incident for HQ and a notice to the pusher's Owner", async () => {
  const { dir, lead, peer } = await briefed("push-unaccepted");
  git(dir, "push", "-q", "origin", "HEAD:main");
  await turnOf(peer, "p1", [shell("git push origin HEAD:main", 0).item], "STATUS: pushed the branch");
  const told = lead.inbox.find((text) =>
    /subject="UNACCEPTED PUSH: \[Peer\] push-unaccepted pushed 1 commit\(s\) no ACCEPT covers"/.test(text),
  );
  assert.ok(told, lead.inbox.join("\n").slice(-600));
  assert.match(told!, new RegExp(git(dir, "rev-parse", "--short=8", "HEAD")));
  const operations = new DatabaseSync(join(ROOM_HOME, "operations", "operations.db"), { readOnly: true });
  const incidents = operations.prepare("SELECT key FROM incidents WHERE district = 'safety'").all() as {
    key: string;
  }[];
  operations.close();
  assert.ok(
    incidents.some(({ key }) => key === "safety|unaccepted push"),
    "raised as an incident on purpose, whatever its words",
  );
});

test("a DONE the facts bear out is kept with its head, and a push of that head is recorded with nothing to tell", async () => {
  const { dir, sup, lead, peer } = await handedIn("done-kept");
  history(lead, [shell("npm test", 0)]);
  await accept(lead, peer);
  await turnOf(
    lead,
    "l1",
    [shell("npm test", 0).item],
    "DONE: one more constant\nnpm test passes on the integrated head",
  );
  assert.doesNotMatch(dones(sup)[0], /\[room\]/);
  const head = git(dir, "rev-parse", "HEAD");
  assert.deepEqual(rows("SELECT head FROM dones WHERE seat = ?", lead.agent.id), [{ head }]);
  git(dir, "push", "-q", "origin", "HEAD:main");
  const before = sup.inbox.length;
  await turnOf(lead, "l2", [shell("git push origin HEAD:main", 0).item], "STATUS: pushed");
  assert.deepEqual(rows("SELECT sha, remote, ref, uncovered FROM pushes WHERE seat = ?", lead.agent.id), [
    { sha: head, remote: "origin", ref: "main", uncovered: 0 },
  ]);
  assert.ok(!sup.inbox.slice(before).some((text) => /INCIDENT/.test(text)));
});

test("when the gate blocks, an ACCEPT it finds a gap in is refused with the reason and the copy to run in, and the writer hears nothing", async () => {
  editPolicy((policy) => void (policy.safety.acceptance.mode = policy.safety.done.mode = "block"));
  await restart();
  const { lead, peer } = await handedIn("accept-block");
  history(lead, []);
  const before = peer.inbox.length;
  const sent = lead.mail({ to: peer.agent.id, subject: "ACCEPT: one more constant", body: "Read and run." });
  const refused = JSON.parse(
    (
      await sent.then(
        () => assert.fail("the ACCEPT was sent"),
        (error: Error) => error,
      )
    ).message,
  ).error;
  assert.equal(refused.code, "ACCEPT_UNPROVEN");
  assert.match(refused.message, /the accepting turn has no passing run of `npm test`/);
  assert.deepEqual(refused.next, { tool: "seatwork_safety", args: { action: "copy", seat: peer.agent.id } });
  assert.equal(peer.inbox.length, before);
  assert.doesNotMatch(await peer.held(), /ACCEPT/);
});

test("when the done gate blocks, a DONE it finds a gap in goes back to its Lead and nothing goes up", async () => {
  const { dir, sup, lead, peer } = await handedIn("done-block");
  history(lead, [shell("npm test", 0)]);
  await accept(lead, peer);
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  await turnOf(lead, "l1", [shell("npm test", 0).item], "DONE: one more constant");
  assert.equal(dones(sup).length, 0);
  const back = lead.inbox.at(-1)!;
  assert.match(back, /subject="DONE RETURNED: 1 gap\(s\) from the room's done gate"/);
  assert.match(back, /- task .*: its accepted head [0-9a-f]{8} is not in HEAD/);
});
