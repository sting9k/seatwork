import { MAIL_POLICY, PROJECT, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import callLimits from "../shared/host.json";
import { MailEngine } from "../server/coordination/engine";
import { PaseoHost } from "../server/paseo/host";

shipSql();

const QUICK = { readSeconds: 0.03, historySeconds: 0.03, writeSeconds: 0.03, startSeconds: 0.03 };
const never = () => new Promise<never>(() => {});
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A host over a stand-in app whose every call hangs, so only the host's own limit can end it. */
function hungHost(limits = QUICK) {
  const host = new PaseoHost(limits);
  const handle = {
    refresh: never,
    current: () => null,
    send: never,
    archive: never,
    timeline: { refetch: never },
  };
  host.use({
    agents: { ref: () => handle, list: never },
    projects: { list: never },
  } as never);
  return host;
}

test(
  "a call to the app that is not answered in time fails like one the app could not answer",
  { timeout: 5000 },
  async () => {
    const host = hungHost();
    assert.equal(await host.state("seat-1"), "unknown", "a state not read proves nothing about the seat");
    await assert.rejects(host.live(), /did not answer the list of open seats within 0\.03 seconds/);
    await assert.rejects(host.seat("seat-1"), /did not answer the seat request for seat-1/);
    await assert.rejects(host.projects(), /did not answer the list of projects/);
    await assert.rejects(host.send("seat-1", "FYI: hello", false), /did not answer the message to seat-1/);
    await assert.rejects(host.archive("seat-1"), /did not answer the archive of seat-1/);
    assert.equal(await host.turn("seat-1", 10), null, "a history not read is unread");
    assert.equal(await host.prompts("seat-1", 10), null);
  },
);

test("each kind of call has its own time, and the shipped ones are shorter than the app's own minute", () => {
  for (const key of ["readSeconds", "historySeconds", "writeSeconds"] as const) {
    assert.ok(callLimits[key] > 0 && callLimits[key] < 60, key);
  }
  assert.ok(callLimits.readSeconds <= callLimits.historySeconds && callLimits.readSeconds <= callLimits.writeSeconds);
});

test("a seat's start that is not answered in time is asked once more under its key, so the app hands back one seat", async () => {
  const asked: { idempotencyKey: string; agentId: string; title: string }[] = [];
  const host = new PaseoHost(QUICK);
  host.use({
    agents: {
      create: async (options: (typeof asked)[number]) => {
        asked.push(options);
        if (options.title === "refused") throw new Error("agent_request_key_conflict");
        return asked.length === 1 ? never() : { id: options.agentId };
      },
    },
  } as never);
  const seat = {
    key: "rotation:lead-1:2026-10-16-10-00",
    provider: "claude-lead",
    cwd: PROJECT,
    title: "[Lead] stream (2)",
    prompt: "go",
  };
  const id = await host.create(seat);
  assert.deepEqual(
    asked.map(({ idempotencyKey, agentId }) => [idempotencyKey, agentId]),
    [
      [seat.key, id],
      [seat.key, id],
    ],
  );
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(await host.create({ ...seat, key: "other" }).then(() => asked.at(-1)!.agentId === id), false);

  asked.length = 0;
  await assert.rejects(host.create({ ...seat, title: "refused" }), /agent_request_key_conflict/);
  assert.equal(asked.length, 1, "a refusal is not asked again");
});

test(
  "an answer in time is passed on whole, leaves no timer behind, and a late answer to a call given up on is dropped",
  { timeout: 5000 },
  async () => {
    const live = new Set<unknown>();
    const { setTimeout: set, clearTimeout: clear } = globalThis;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const timer: NodeJS.Timeout = set(() => {
        live.delete(timer);
        fn();
      }, ms);
      live.add(timer);
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: NodeJS.Timeout) => {
      live.delete(timer);
      clear(timer);
    }) as typeof clearTimeout;
    const stray: unknown[] = [];
    const noted = (reason: unknown) => void stray.push(reason);
    process.on("unhandledRejection", noted);
    try {
      const host = new PaseoHost(QUICK);
      host.use({
        agents: {
          ref: (id: string) => ({
            refresh: () =>
              id === "slow" ? wait(80).then(() => Promise.reject(new Error("too late"))) : Promise.resolve(),
            current: () => (id === "slow" ? null : { id, status: "idle" }),
          }),
        },
      } as never);
      assert.equal(await host.state("quick"), "idle");
      assert.equal(live.size, 0, "the limit's timer is cleared when the app answers");
      assert.equal(await host.state("slow"), "unknown");
      await wait(150);
      assert.deepEqual(stray, [], "the late failure is nobody's to handle");
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
      process.off("unhandledRejection", noted);
    }
  },
);

test("the mail sweep goes on to the next seat when the app does not answer for one", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(PROJECT, "host-"));
  const sent: string[] = [];
  const hanging = new Set(["seat-a", "seat-b"]);
  const host = new PaseoHost(QUICK);
  host.use({
    agents: {
      ref: (id: string) => ({
        refresh: () => (hanging.has(id) ? never() : Promise.resolve()),
        current: () => ({ id, status: "idle" }),
        send: async () => void sent.push(id),
      }),
    },
  } as never);
  const engine = new MailEngine(host, MAIL_POLICY, () => {}, { rootOf: () => dir });
  for (const id of ["seat-a", "seat-b"])
    engine.rememberSeat({
      agentId: id,
      parentAgentId: null,
      role: "lead",
      provider: "claude-lead",
      title: id,
      cwd: dir,
    });
  const note = (to: string) => ({
    from: { agentId: "room", role: "system" },
    to,
    priority: "action" as const,
    subject: "FYI: hello",
    body: "hello",
    needs: "nothing" as const,
  });
  await engine.post(note("seat-a"));
  await engine.post(note("seat-b"));
  assert.deepEqual(sent, [], "both wait: the app answers for neither");
  hanging.delete("seat-b");
  await engine.sweep();
  assert.deepEqual(sent, ["seat-b"], "seat-a's unanswered state costs the sweep its limit, not the rest of its pass");
  engine.close();
});
