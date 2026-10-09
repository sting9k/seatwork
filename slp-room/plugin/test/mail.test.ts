import { deferred, MAIL_POLICY } from "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MailEngine, type Mail, type SeatRecord } from "../server/mail";

interface Handle {
  refresh(): Promise<unknown>;
  current(): unknown;
  send(text: string): Promise<void>;
}

const idle = { refresh: async () => {}, current: () => ({ status: "idle" }) };

/** An engine over these agents; any other id is one the daemon no longer has. */
function engineFor(handles: Record<string, Partial<Handle>>): MailEngine {
  const missing = (id: string) => ({
    refresh: async () => {
      throw new Error(`Agent not found: ${id}`);
    },
  });
  const paseo = { agents: { ref: (id: string) => handles[id] ?? missing(id) } };
  return new MailEngine(paseo as never, MAIL_POLICY, { routes: {}, spawn: {} } as never, () => {});
}

function lead(agentId: string): SeatRecord {
  return { agentId, parentAgentId: null, role: "lead", provider: "claude-lead", title: null };
}

function mail(to: string, subject: string, from: Mail["from"] = { agentId: "room", role: "system" }, needs: Mail["needs"] = "nothing"): Omit<Mail, "id" | "at"> {
  return { from, to, priority: "action", subject, body: `body of ${subject}`, needs, whyNow: "test" };
}

test("mail posted while a delivery waits for the recipient's status is not lost", async () => {
  const waiting = deferred();
  const release = deferred();
  const sent: string[] = [];
  const engine = engineFor({
    r1: {
      refresh: async () => {
        waiting.resolve();
        await release.promise;
      },
      current: () => ({ status: "idle" }),
      send: async (text) => void sent.push(text),
    },
  });

  const first = engine.post(mail("r1", "A"));
  await waiting.promise;
  const second = await engine.post(mail("r1", "B"));
  release.resolve();
  await first;

  const delivered = sent.some((text) => text.includes(second.id));
  const held = engine.held("r1").some((m) => m.id === second.id);
  assert.ok(delivered || held, "B was accepted, then neither delivered nor held");
});

test("mail that arrives while the room learns its recipient is archived is bounced, not erased", async () => {
  const waiting = deferred();
  const release = deferred();
  const toSender: string[] = [];
  const engine = engineFor({
    gone1: {
      refresh: async () => {
        waiting.resolve();
        await release.promise;
      },
      current: () => ({ status: "idle", archivedAt: "2026-10-01T00:00:00Z" }),
    },
    lead1: { ...idle, send: async (text) => void toSender.push(text) },
  });
  engine.rememberSeat(lead("lead1"));
  const from = { agentId: "lead1", role: "lead" } as const;

  const first = engine.post(mail("gone1", "A", from, "reply"));
  await waiting.promise;
  const second = await engine.post(mail("gone1", "B", from, "reply"));
  release.resolve();
  await first;

  assert.ok(toSender.some((text) => text.includes(`UNDELIVERABLE: #${second.id}`)), "the sender of B was never told");
  assert.deepEqual(engine.held("gone1"), []);
});

test("a failed status read holds the mail until the daemon answers again", async () => {
  let down = true;
  const sent: string[] = [];
  const engine = engineFor({
    r2: {
      refresh: async () => {
        if (down) throw new Error("connection lost");
      },
      current: () => ({ status: "idle" }),
      send: async (text) => void sent.push(text),
    },
  });

  const posted = await engine.post(mail("r2", "retry me"));
  assert.deepEqual(engine.held("r2").map((m) => m.id), [posted.id]);

  down = false;
  await engine.sweep();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes(posted.id));
});

test("mail to a seat the daemon no longer has is dropped and its sender told", async () => {
  const toSender: string[] = [];
  const engine = engineFor({ lead2: { ...idle, send: async (text) => void toSender.push(text) } });
  engine.rememberSeat(lead("lead2"));

  const posted = await engine.post(mail("deleted2", "anyone there", { agentId: "lead2", role: "lead" }, "reply"));

  assert.deepEqual(engine.held("deleted2"), []);
  assert.ok(toSender.some((text) => text.includes(`UNDELIVERABLE: #${posted.id}`)));
});

test("a dropped mail that asked for nothing does not start its sender's turn; the notice comes with its next mail", async () => {
  const toSender: string[] = [];
  const engine = engineFor({ lead3: { ...idle, send: async (text) => void toSender.push(text) } });
  engine.rememberSeat(lead("lead3"));

  const dropped = await engine.post(mail("deleted3", "ACCEPT: released", { agentId: "lead3", role: "lead" }));
  assert.equal(toSender.length, 0, "the sender was started for a mail nobody waited on");

  const next = await engine.post(mail("lead3", "a mail that does start a turn"));
  assert.equal(toSender.length, 1);
  assert.ok(toSender[0].includes(`UNDELIVERABLE: #${dropped.id}`));
  assert.ok(toSender[0].includes(next.id));
  assert.deepEqual(engine.held("lead3"), []);
});

test("quiet mail waits for the next mail that starts a turn, and the inbox hands it out meanwhile", async () => {
  const sent: string[] = [];
  const engine = engineFor({ r6: { ...idle, send: async (text) => void sent.push(text) }, r7: { ...idle, send: async (text) => void sent.push(text) } });

  const quiet = await engine.post({ ...mail("r6", "ACK"), priority: "fyi", quiet: true });
  await engine.sweep();
  assert.equal(sent.length, 0, "a quiet mail started a turn");

  const loud = await engine.post(mail("r6", "QUESTION"));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes(quiet.id) && sent[0].includes(loud.id));

  const other = await engine.post({ ...mail("r7", "ACK"), priority: "fyi", quiet: true });
  assert.deepEqual(engine.takeHeld("r7").map((m) => m.id), [other.id]);
});

test("a report kept for a turn end that never reached the room is posted once its seat is at rest", async () => {
  let status = "running";
  const toLead: string[] = [];
  const engine = engineFor({
    peer8: { refresh: async () => {}, current: () => ({ status }) },
    lead8: { ...idle, send: async (text) => void toLead.push(text) },
  });

  const kept = engine.keepReport(mail("lead8", "REVIEW: abc123 PASS", { agentId: "peer8", role: "peer" }, "reply"));
  await engine.sweep();
  assert.equal(toLead.length, 0, "the report went out while its seat was still in the turn");

  status = "idle";
  await engine.sweep();
  assert.equal(toLead.length, 1);
  assert.ok(toLead[0].includes(`#${kept.id}`));
  await engine.sweep();
  assert.equal(toLead.length, 1);
});

test("mail whose delivery was cut off is still there for the next engine, marked as a possible repeat", async () => {
  const sending = deferred();
  const before = engineFor({
    r3: {
      ...idle,
      send: () => {
        sending.resolve();
        return new Promise<void>(() => {}); // the daemon never answers
      },
    },
  });
  void before.post(mail("r3", "survive"));
  await sending.promise;
  const [queued] = before.held("r3");
  assert.ok(queued, "the mail left the disk before its delivery was confirmed");

  // the plugin process dies here; a new one starts on the same room home
  const sent: string[] = [];
  const after = engineFor({ r3: { ...idle, send: async (text) => void sent.push(text) } });
  await after.sweep();

  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes(`#${queued.id}`));
  assert.match(sent[0], /possible repeat/);
  assert.deepEqual(after.held("r3"), []);
});

test("a refused delivery keeps the mail for the next attempt, as a first delivery", async () => {
  let refuse = true;
  const sent: string[] = [];
  const engine = engineFor({
    r4: {
      ...idle,
      send: async (text) => {
        if (refuse) throw new Error("agent busy");
        sent.push(text);
      },
    },
  });

  const posted = await engine.post(mail("r4", "again"));
  assert.deepEqual(engine.held("r4").map((m) => m.id), [posted.id]);

  refuse = false;
  await engine.deliver("r4");
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /possible repeat/);
});

test("the inbox does not hand out mail that is being delivered", async () => {
  const sending = deferred();
  const release = deferred();
  const sent: string[] = [];
  const engine = engineFor({
    r5: {
      ...idle,
      send: async (text) => {
        sending.resolve();
        await release.promise;
        sent.push(text);
      },
    },
  });

  const posting = engine.post(mail("r5", "once"));
  await sending.promise;
  assert.deepEqual(engine.takeHeld("r5"), []);
  release.resolve();
  await posting;

  assert.equal(sent.length, 1);
  assert.deepEqual(engine.held("r5"), []);
});
