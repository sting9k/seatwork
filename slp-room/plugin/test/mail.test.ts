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

function mail(to: string, subject: string, from: Mail["from"] = { agentId: "room", role: "system" }): Omit<Mail, "id" | "at"> {
  return { from, to, priority: "action", subject, body: `body of ${subject}`, needs: "nothing", whyNow: "test" };
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

  const first = engine.post(mail("gone1", "A", from));
  await waiting.promise;
  const second = await engine.post(mail("gone1", "B", from));
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

  const posted = await engine.post(mail("deleted2", "anyone there", { agentId: "lead2", role: "lead" }));

  assert.deepEqual(engine.held("deleted2"), []);
  assert.ok(toSender.some((text) => text.includes(`UNDELIVERABLE: #${posted.id}`)));
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
