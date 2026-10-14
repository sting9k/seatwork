import { deferred, MAIL_POLICY, ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MailError } from "../server/coordination/address";
import { MailEngine, type EngineOptions, type NewMail, type SeatRecord } from "../server/coordination/engine";
import { inbox } from "../server/coordination/reader";

shipSql();

interface Handle {
  refresh(): Promise<unknown>;
  current(): unknown;
  send(text: string): Promise<void>;
}

const idle = { refresh: async () => {}, current: () => ({ status: "idle" }) };
const ROUTES = { "lead>peer": true, "peer>lead": true, "supervisor>lead": true, "lead>supervisor": true };

/** An engine over these agents; any other id is one the daemon no longer has: it answers, with no agent. */
function engineFor(handles: Record<string, Partial<Handle>>, options: EngineOptions = {}): MailEngine {
  const missing = { refresh: async () => null, current: () => null };
  const paseo = { agents: { ref: (id: string) => handles[id] ?? missing } };
  return new MailEngine(
    paseo as never,
    MAIL_POLICY,
    { routes: ROUTES, spawn: { lead: ["peer"] } } as never,
    () => {},
    options,
  );
}

let cases = 0;
/** Seat ids no other test of this file uses: every engine here shares the room home's store. */
function names<T extends string>(...roles: T[]): Record<T, string> {
  cases += 1;
  return Object.fromEntries(roles.map((role) => [role, `${role}-${cases}`])) as Record<T, string>;
}

function seat(
  agentId: string,
  role: SeatRecord["role"],
  parentAgentId: string | null = null,
  cwd?: string,
): SeatRecord {
  return {
    agentId,
    parentAgentId,
    role,
    provider: `claude-${role}`,
    title: `[${role}] ${agentId}`,
    ...(cwd ? { cwd } : {}),
  };
}

function mail(to: string | string[], subject: string, more: Partial<NewMail> = {}): NewMail {
  return {
    from: { agentId: "room", role: "system" },
    to,
    priority: "action",
    subject,
    body: `body of ${subject}`,
    needs: "nothing",
    ...more,
  };
}

/** A seat at rest that keeps what it is sent. */
function listener(): { handle: Handle; got: string[] } {
  const got: string[] = [];
  return { got, handle: { ...idle, send: async (text) => void got.push(text) } };
}

test("a mail reaches a seat at rest as one tagged block, and the store remembers how it went", async () => {
  const id = names("lead");
  const { handle, got } = listener();
  const engine = engineFor({ [id.lead]: handle });
  engine.rememberSeat(seat(id.lead, "lead"));
  const sent = await engine.post(mail(id.lead, "FYI: main moved", { why: "the base branch changed" }));
  assert.match(
    got[0],
    new RegExp(
      `^<mail id="${sent.id}" from="room" subject="FYI: main moved" needs="nothing" thread="m${sent.id}" note="the base branch changed">\nbody of FYI: main moved\n</mail>$`,
    ),
  );
  assert.equal(sent.state, "delivered");
  assert.equal(sent.how, "idle");
  assert.deepEqual(engine.held(id.lead), []);
  assert.equal(engine.takeWake(id.lead)[0].id, sent.id);
});

test("mail posted while a delivery waits for the recipient's status is not lost", async () => {
  const id = names("lead");
  const gate = deferred();
  const got: string[] = [];
  let reads = 0;
  const engine = engineFor({
    [id.lead]: {
      refresh: async () => void ((reads += 1) === 1 && (await gate.promise)),
      current: () => ({ status: "idle" }),
      send: async (text) => void got.push(text),
    },
  });
  engine.rememberSeat(seat(id.lead, "lead"));
  const first = engine.post(mail(id.lead, "FYI: one"));
  const second = engine.post(mail(id.lead, "FYI: two"));
  gate.resolve();
  await Promise.all([first, second]);
  await engine.deliver(id.lead);
  assert.match(got.join("\n"), /FYI: one[\s\S]*FYI: two/);
  assert.deepEqual(engine.held(id.lead), []);
});

test("mail to a seat the daemon no longer has is bounced, and a sender that waited is told", async () => {
  const id = names("lead", "peer", "gone");
  const lead = listener();
  const engine = engineFor({ [id.lead]: lead.handle });
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.gone, "peer", id.lead));
  const asked = await engine.post(
    mail(id.gone, "ANSWER: use v2", { from: { agentId: id.lead, role: "lead" }, needs: "reply" }),
  );
  assert.equal(engine.storeOf(id.gone)!.deliveries(asked.id)[0].state, "bounced");
  assert.match(lead.got[0], new RegExp(`subject="UNDELIVERABLE: #${asked.id} re: ANSWER: use v2"`));
  // one that asked nothing reads the notice with its next mail
  await engine.post(mail(id.gone, "FYI: nothing to do", { from: { agentId: id.lead, role: "lead" } }));
  assert.equal(lead.got.length, 1);
  assert.equal(engine.held(id.lead).length, 1);
  assert.equal(engine.held(id.lead)[0].quiet, true);
});

test("a failed status read, or a seat still opening, holds the mail; any seat a message can start takes it", async () => {
  const id = names("lost", "opening", "closed", "failed");
  const closed = listener();
  const failed = listener();
  const engine = engineFor({
    [id.lost]: { refresh: async () => Promise.reject(new Error("timeout")), current: () => null },
    [id.opening]: { ...idle, current: () => ({ status: "initializing" }) },
    [id.closed]: { ...closed.handle, current: () => ({ status: "closed" }) },
    [id.failed]: { ...failed.handle, current: () => ({ status: "error" }) },
  });
  for (const agent of Object.values(id)) engine.rememberSeat(seat(agent, "lead"));
  for (const agent of Object.values(id)) await engine.post(mail(agent, "FYI: hello"));
  assert.equal(engine.held(id.lost).length, 1);
  assert.equal(engine.held(id.opening).length, 1);
  assert.equal(closed.got.length, 1);
  assert.equal(failed.got.length, 1);
});

test("quiet mail waits for the next mail that starts a turn, cut to its opening; the inbox hands it out whole meanwhile", async () => {
  const id = names("lead", "other");
  const { handle, got } = listener();
  const engine = engineFor({ [id.lead]: handle, [id.other]: listener().handle }, { quietChars: 20 });
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.other, "lead"));
  const quiet = await engine.post(mail(id.lead, "STATUS: half way", { quiet: true, body: "x".repeat(50) }));
  assert.equal(got.length, 0);
  await engine.post(mail(id.lead, "QUESTION: which format?", { needs: "decision", priority: "blocking" }));
  assert.equal(got.length, 1);
  assert.match(got[0], /^<mail [^>]*subject="QUESTION: which format\?"[\s\S]*<mail [^>]*subject="STATUS: half way"/);
  const file = engine.storeOf(id.lead)!.get(quiet.id)!.file!;
  assert.ok(got[0].includes(`${"x".repeat(20)}\n[cut at 20 of 50 characters; the whole mail is in ${file}]`));
  assert.match(readFileSync(file, "utf8"), new RegExp(`# STATUS: half way\n\n${"x".repeat(50)}\n$`));
  // held again, and read through the inbox
  await engine.post(mail(id.other, "ACK: noted", { quiet: true }));
  assert.match(inbox(engine, id.other, {}, Date.now()), /^<mail [^>]*subject="ACK: noted"/);
  assert.equal(inbox(engine, id.other, {}, Date.now()), "inbox empty");
  assert.equal(engine.storeOf(id.other)!.received(id.other, 5)[0].state, "read");
});

test("a held review starts no turn until its hold runs out or its round is released", async () => {
  const id = names("lead");
  const { handle, got } = listener();
  const engine = engineFor({ [id.lead]: handle });
  engine.rememberSeat(seat(id.lead, "lead"));
  const later = new Date(Date.now() + 60_000).toISOString();
  await engine.post(mail(id.lead, "REVIEW: one", { round: "r1", heldUntil: later }));
  await engine.post(mail(id.lead, "REVIEW: two", { round: "r1", heldUntil: later }));
  assert.equal(got.length, 0);
  await engine.release(id.lead, "r1");
  assert.equal(got.length, 1);
  assert.match(got[0], /REVIEW: one[\s\S]*REVIEW: two/);
});

test("a report kept for a turn end goes out once: as it stands when the turn ends, or by the sweep when that never reached the room", async () => {
  const id = names("lead", "peer", "slow");
  const lead = listener();
  const engine = engineFor({ [id.lead]: lead.handle, [id.peer]: idle, [id.slow]: idle });
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.peer, "peer", id.lead));
  engine.rememberSeat(seat(id.slow, "peer", id.lead));
  const report = (from: string, subject: string) =>
    mail(id.lead, subject, { from: { agentId: from, role: "peer" }, needs: "reply" });
  engine.keepReport(report(id.peer, "CANDIDATE: first try"));
  const kept = engine.keepReport(report(id.peer, "CANDIDATE: store"));
  assert.equal(lead.got.length, 0);
  const draft = engine.takeReport(id.peer)!;
  assert.equal(draft.id, kept.id);
  assert.equal(engine.takeReport(id.peer), null, "taken once");
  await engine.post({ ...draft, body: `${draft.body}\n\n[room] second candidate` });
  assert.equal(lead.got.length, 1);
  assert.match(
    lead.got[0],
    new RegExp(
      `<mail id="${kept.id}" [^>]*subject="CANDIDATE: store"[^>]*>\nbody of CANDIDATE: store\n\n\\[room\\] second candidate\n</mail>`,
    ),
  );
  engine.keepReport(report(id.slow, "DONE: docs"));
  await engine.sweep();
  assert.equal(lead.got.length, 2);
  assert.match(lead.got[1], /subject="DONE: docs"/);
});

test("mail whose delivery was cut off is still there for the next engine, marked as a possible repeat", async () => {
  const id = names("lead");
  const stuck = deferred();
  const first = engineFor({ [id.lead]: { ...idle, send: () => stuck.promise } });
  first.rememberSeat(seat(id.lead, "lead"));
  void first.post(mail(id.lead, "ANSWER: use v2"));
  await new Promise((done) => setTimeout(done, 20));
  const { handle, got } = listener();
  const next = engineFor({ [id.lead]: handle });
  next.rememberSeat(seat(id.lead, "lead"));
  assert.equal(next.held(id.lead)[0].state, "sending");
  assert.equal(
    inbox(next, id.lead, { peek: true }, Date.now()),
    "inbox empty",
    "the inbox leaves mail on its way out alone",
  );
  await next.deliver(id.lead);
  assert.match(got[0], /repeat="an earlier delivery was cut off; if you handled it, do nothing"/);
  stuck.resolve();
});

test("a refused delivery keeps the mail for the next attempt, as a first delivery", async () => {
  const id = names("lead");
  const got: string[] = [];
  let refuse = true;
  const engine = engineFor({
    [id.lead]: { ...idle, send: async (text) => (refuse ? Promise.reject(new Error("busy")) : void got.push(text)) },
  });
  engine.rememberSeat(seat(id.lead, "lead"));
  await engine.post(mail(id.lead, "FYI: later"));
  assert.equal(engine.held(id.lead)[0].state, "queued");
  assert.deepEqual(engine.takeWake(id.lead), []);
  refuse = false;
  await engine.sweep();
  assert.equal(got.length, 1);
  assert.doesNotMatch(got[0], /repeat=/);
});

test("an answer settles the ask it names, or the oldest open ask of its recipient; an unanswered ask is owed", async () => {
  const id = names("lead", "peer");
  const engine = engineFor({ [id.lead]: listener().handle, [id.peer]: listener().handle });
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.peer, "peer", id.lead));
  const peer = { agentId: id.peer, role: "peer" as const };
  const lead = { agentId: id.lead, role: "lead" as const };
  const first = await engine.post(mail(id.lead, "QUESTION: which format?", { from: peer, needs: "decision" }));
  const second = await engine.post(mail(id.lead, "QUESTION: and the name?", { from: peer, needs: "reply" }));
  assert.match(
    inbox(engine, id.lead, { view: "owed" }, Date.now()),
    new RegExp(`^you owe: #${first.id} [\\s\\S]*\nyou owe: #${second.id} `),
  );
  assert.match(
    inbox(engine, id.lead, {}, Date.now()),
    /^inbox empty\n\[room\] you owe 2 answers: #\d+ \(QUESTION, \d+ min\), #\d+ /,
  );
  const answer = await engine.post(
    mail(id.peer, "ANSWER: the second one", { from: lead, replyTo: second.id, thread: second.thread }),
  );
  const store = engine.storeOf(id.lead)!;
  assert.equal(store.get(second.id)!.answeredBy, answer.id);
  const other = await engine.post(mail(id.peer, "ANSWER: v2", { from: lead }));
  assert.equal(store.get(first.id)!.answeredBy, other.id);
  assert.equal(inbox(engine, id.lead, { view: "owed" }, Date.now()), "nothing is owed");
  assert.deepEqual(
    store.thread(second.thread, null, 10).map((message) => message.id),
    [second.id, answer.id],
  );
});

test("the same text sent again within the window is one mail; a key stands for the text it was first used with", async () => {
  const id = names("lead", "peer");
  const { handle, got } = listener();
  const engine = engineFor({ [id.lead]: handle });
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.peer, "peer", id.lead));
  const draft = mail(id.lead, "STATUS: half way", { from: { agentId: id.peer, role: "peer" }, key: "status-1" });
  assert.equal(engine.repeatOf(draft), null);
  const sent = await engine.post(draft);
  assert.equal(engine.repeatOf(draft)?.id, sent.id);
  assert.equal(engine.repeatOf({ ...draft, key: undefined })?.id, sent.id);
  assert.throws(
    () => engine.repeatOf({ ...draft, body: "another text" }),
    (error: unknown) => error instanceof MailError && error.code === "KEY_REUSED",
  );
  assert.equal(engine.repeatOf({ ...draft, key: undefined, body: "another text" }), null);
  assert.equal(got.length, 1);
});

test("a copy and a mail to the team inform without starting a turn; a seat reads its own mail and that of the seats under it", async () => {
  const id = names("lead", "peer", "other", "stranger");
  const peer = listener();
  const other = listener();
  const engine = engineFor({
    [id.lead]: listener().handle,
    [id.peer]: peer.handle,
    [id.other]: other.handle,
    [id.stranger]: idle,
  });
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.peer, "peer", id.lead));
  engine.rememberSeat(seat(id.other, "peer", id.lead));
  engine.rememberSeat(seat(id.stranger, "lead"));
  const lead = { agentId: id.lead, role: "lead" as const };
  const sent = await engine.post(mail(id.peer, "INSTRUCTION: rebase on main", { from: lead, cc: [id.other] }));
  assert.equal(peer.got.length, 1);
  assert.equal(other.got.length, 0);
  assert.match(
    inbox(engine, id.other, {}, Date.now()),
    new RegExp(`^<mail id="${sent.id}" from="owner" [^>]* as="cc">`),
  );
  const team = await engine.post(
    mail([id.peer, id.other], "FYI: the law changed", { from: lead, kind: "team", quiet: true }),
  );
  assert.deepEqual(
    engine
      .storeOf(id.lead)!
      .deliveries(team.id)
      .map((to) => [to.kind, to.state]),
    [
      ["team", "queued"],
      ["team", "queued"],
    ],
  );
  assert.match(
    inbox(engine, id.lead, { view: "sent" }, Date.now()),
    new RegExp(`^#${team.id} [^\n]*\\[queued\\][^\n]*\\[queued\\]`),
  );
  assert.match(
    inbox(engine, id.lead, { id: sent.id }, Date.now()),
    /^<mail [^>]*subject="INSTRUCTION: rebase on main"/,
  );
  assert.match(inbox(engine, id.lead, { q: "rebase" }, Date.now()), new RegExp(`^#${sent.id} `));
  assert.throws(
    () => inbox(engine, id.stranger, { id: sent.id }, Date.now()),
    (error: unknown) => error instanceof MailError && error.code === "UNKNOWN_MAIL",
  );
  assert.equal(inbox(engine, id.stranger, { q: "rebase" }, Date.now()), "nothing matches `rebase`");
});

test("a project's mail lives in the project: its store, a file per mail, a file per thread, kept out of its commits", async () => {
  const id = names("lead", "peer");
  const project = join(ROOM_HOME, `project-${cases}`);
  mkdirSync(project, { recursive: true });
  const folder = join(project, ".seatwork", ".mail");
  const options = { rootOf: (cwd: string) => (cwd.startsWith(project) ? project : null) };
  const peer = listener();
  const engine = engineFor({ [id.peer]: peer.handle, [id.lead]: listener().handle }, options);
  engine.rememberSeat(seat(id.lead, "lead", null, project));
  engine.rememberSeat(seat(id.peer, "peer", id.lead, join(project, ".worktrees", "a")));
  assert.equal(engine.folderOf(id.peer), folder);
  const brief = await engine.post(
    mail(id.peer, "INSTRUCTION: build the index", { from: { agentId: id.lead, role: "lead" }, thread: "sw-k3f" }),
  );
  await engine.post(
    mail(id.lead, "QUESTION: sorted?", {
      from: { agentId: id.peer, role: "peer" },
      replyTo: brief.id,
      thread: "sw-k3f",
      needs: "reply",
    }),
  );
  assert.ok(existsSync(join(folder, "mail.db")));
  assert.equal(readFileSync(join(folder, ".gitignore"), "utf8"), "*\n");
  const thread = readFileSync(join(folder, "threads", "sw-k3f.md"), "utf8");
  assert.match(
    thread,
    /^# Thread sw-k3f\n\n## #1 · [^\n]* → peer [^\n]*\n\n\*\*INSTRUCTION: build the index\*\*[\s\S]*## #2 · [^\n]* → owner\n\n\*\*QUESTION: sorted\?\*\*/,
  );
  assert.match(
    inbox(engine, id.peer, { thread: "sw-k3f" }, Date.now()),
    /^#1 [^\n]*\n#2 [^\n]*\nthe whole thread as one file: .*sw-k3f\.md$/,
  );
  // the store is lost: the next engine reads the mail back from its files, history as delivered
  engine.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(folder, `mail.db${suffix}`), { force: true });
  const again = engineFor({ [id.peer]: peer.handle, [id.lead]: listener().handle }, options);
  again.rememberSeat(seat(id.lead, "lead", null, project));
  again.rememberSeat(seat(id.peer, "peer", id.lead, join(project, ".worktrees", "a")));
  assert.deepEqual(again.lookupMail(brief.id, id.peer), { from: id.lead, to: [id.peer], thread: "sw-k3f" });
  assert.match(inbox(again, id.peer, { q: "sorted" }, Date.now()), /^#2 /);
  const next = await again.post(
    mail(id.peer, "ANSWER: yes", { from: { agentId: id.lead, role: "lead" }, thread: "sw-k3f" }),
  );
  assert.equal(next.id, 3, "ids go on from the files");
});

test("a handover holds for the engine that starts after a reload, and held mail follows a seat's successor", async () => {
  const id = names("lead", "next", "peer", "heir");
  const heir = listener();
  const handles = {
    [id.lead]: idle,
    [id.next]: idle,
    [id.peer]: { ...idle, current: () => ({ status: "running" }) },
    [id.heir]: heir.handle,
  };
  const engine = engineFor(handles);
  engine.rememberSeat(seat(id.lead, "lead"));
  engine.rememberSeat(seat(id.next, "lead"));
  engine.rememberSeat(seat(id.peer, "peer", id.lead));
  engine.rememberSeat(seat(id.heir, "peer", id.lead));
  assert.deepEqual(await engine.adopt(id.next, id.peer), {
    ok: false,
    reason: `${id.peer} still reports to a live seat that is not in your chain; only its chain may hand it over`,
  });
  const gone = engineFor({ ...handles, [id.lead]: { refresh: async () => null, current: () => null } });
  for (const record of engine.allSeats()) gone.rememberSeat(record);
  assert.deepEqual(await gone.adopt(id.next, id.peer), { ok: true, previous: id.lead });
  const reloaded = engineFor(handles);
  reloaded.rememberSeat(seat(id.peer, "peer", id.lead));
  assert.equal(reloaded.parentOf(id.peer), id.next);
  await engine.post(mail(id.peer, "ANSWER: use v2"));
  assert.equal(engine.held(id.peer).length, 1);
  await engine.move(id.peer, id.heir);
  assert.equal(engine.held(id.peer).length, 0);
  assert.match(heir.got[0], /subject="ANSWER: use v2"/);
});
