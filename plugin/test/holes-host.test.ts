import { MAIL_POLICY, PROJECT, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import callLimits from "../shared/host.json";
import { MailEngine } from "../server/coordination/engine";
import { PaseoHost } from "../server/paseo/host";
import { StandInApp } from "./support/stand-in-app";

shipSql();

const QUICK = { readSeconds: 0.03, historySeconds: 0.03, writeSeconds: 0.03, startSeconds: 0.03 };
const never = () => new Promise<never>(() => {});
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("each kind of call has its own time, and the shipped ones are shorter than the app's own minute", () => {
  for (const key of ["readSeconds", "historySeconds", "writeSeconds"] as const) {
    assert.ok(callLimits[key] > 0 && callLimits[key] < 60, key);
  }
  assert.ok(callLimits.readSeconds <= callLimits.historySeconds && callLimits.readSeconds <= callLimits.writeSeconds);
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

/** A lead seat at rest on a stand-in app, with a mail engine of its own over the folder `dir`. */
function mailOver(app: StandInApp, dir: string) {
  const host = new PaseoHost(QUICK);
  host.use(app.client());
  app.put({ id: "seat-a", status: "idle" });
  const engine = new MailEngine(host, MAIL_POLICY, () => {}, { rootOf: () => dir });
  engine.rememberSeat({
    agentId: "seat-a",
    parentAgentId: null,
    role: "lead",
    provider: "claude-lead",
    title: "a",
    cwd: dir,
  });
  return engine;
}

const note = (subject: string) => ({
  from: { agentId: "room", role: "system" },
  to: "seat-a",
  priority: "action" as const,
  subject,
  body: subject,
  needs: "nothing" as const,
});

test("a message the app takes after its time goes again as it was, alone, and the seat reads it once", async () => {
  const dir = mkdtempSync(join(PROJECT, "host-"));
  const app = new StandInApp(join(dir, "app"));
  const engine = mailOver(app, dir);
  app.late.set("send", [80]);
  await engine.post(note("FYI: first"));
  assert.equal(app.received().length, 1, "the app took it, but answered after the room gave up");
  await engine.post(note("FYI: second"));
  await wait(20);
  const read = app.received().map((one) => one.text);
  assert.equal(read.length, 2);
  assert.match(read[0], /first/);
  assert.doesNotMatch(read[0], /second/);
  assert.match(read[1], /second/);
  assert.doesNotMatch(read[1], /first/, "the second goes in a message of its own");
  engine.close();
});

test("a message the app lost track of goes again under a new id; after a restart the same mail in the same words is read once", async () => {
  const dir = mkdtempSync(join(PROJECT, "host-"));
  const app = new StandInApp(join(dir, "app"));
  const first = mailOver(app, dir);
  app.forget = 1;
  await first.post(note("FYI: lost"));
  await first.deliver("seat-a");
  assert.deepEqual(
    app.received().map((one) => one.text.includes("FYI: lost")),
    [true],
  );
  assert.equal(first.storeOf("seat-a")!.queued("seat-a").length, 0, "and the mail is delivered");

  app.late.set("send", [80]);
  await first.post(note("FYI: late"));
  first.close();
  const next = mailOver(app, dir);
  await next.deliver("seat-a");
  assert.equal(app.received().filter((one) => one.text.includes("FYI: late")).length, 1);
  assert.equal(next.storeOf("seat-a")!.queued("seat-a").length, 0);
  next.close();
});
