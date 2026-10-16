import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "../../server/host";
import { PASEO_HOME } from "../../server/paths";
import type { StandInApp } from "./stand-in-app";

/** What every Host owes the room, one clause per promise of its contract, by method; each runs on a Host over a fresh stand-in app. */

/** A Host under test and the app it runs on. */
export interface Subject {
  host: Host;
  app: StandInApp;
}

/** One promise of the contract: what it says, how to see it kept, and whether it holds before the app hands a client. */
export interface Clause {
  says: string;
  before?: true;
  run(subject: Subject): Promise<void>;
}

const LATE = 80;

const turnOf = (id: string) => [
  { item: { type: "user_message", text: "an old prompt" }, turnId: "t1" },
  { item: { type: "assistant_message", text: "old" }, turnId: "t1" },
  { item: { type: "user_message", text: `the brief of ${id}` }, timestamp: "2026-10-16T10:00:00.000Z", turnId: "t2" },
  {
    item: { type: "tool_call", status: "completed", detail: { type: "shell", command: "npm test", exitCode: 0 } },
    turnId: "t2",
  },
  { item: { type: "assistant_message", text: "DONE" }, turnId: "t2" },
];

export const HOST_CONTRACT: { [M in keyof Host]: Clause[] } = {
  state: [
    {
      says: "an agent at rest, closed, or after a failed turn starts a turn from a message: idle",
      async run({ host, app }) {
        for (const status of ["idle", "closed", "error"] as const) app.put({ id: `a-${status}`, status });
        for (const status of ["idle", "closed", "error"]) assert.equal(await host.state(`a-${status}`), "idle", status);
      },
    },
    {
      says: "an agent in a turn is running, and one waiting on a permission is permission whatever its status",
      async run({ host, app }) {
        app
          .put({ id: "busy", status: "running" })
          .put({ id: "asks", status: "running", pendingPermissions: [{}] as never });
        assert.equal(await host.state("busy"), "running");
        assert.equal(await host.state("asks"), "permission");
      },
    },
    {
      says: "an archived agent, or one the app does not have, is gone; one still opening is not known",
      async run({ host, app }) {
        app
          .put({ id: "old", status: "idle", archivedAt: "2026-10-14T00:00:00Z" })
          .put({ id: "new", status: "initializing" });
        assert.equal(await host.state("old"), "gone");
        assert.equal(await host.state("missing"), "gone");
        assert.equal(await host.state("new"), "unknown");
      },
    },
    {
      says: "an app that does not answer in time proves nothing about the seat",
      async run({ host, app }) {
        app.put({ id: "a", status: "idle" }).hang.add("refresh");
        assert.equal(await host.state("a"), "unknown");
      },
    },
    {
      says: "before the app hands a client, its CLI is read the same way, and an answer that is no JSON proves nothing",
      before: true,
      async run({ host, app }) {
        app
          .put({ id: "rest", status: "idle" })
          .put({ id: "busy", status: "running" })
          .put({ id: "asks", status: "running", pendingPermissions: [{}] as never })
          .put({ id: "old", status: "idle", archivedAt: "2026-10-14T00:00:00Z" })
          .garble("junk");
        assert.deepEqual(
          await Promise.all(["rest", "busy", "asks", "old", "missing", "junk"].map((id) => host.state(id))),
          ["idle", "running", "permission", "gone", "gone", "unknown"],
        );
      },
    },
  ],
  send: [
    {
      says: "a stop order ends a running turn first; any other message steers",
      async run({ host, app }) {
        app.put({ id: "a", status: "running" });
        await host.send("a", "STOP: halt", true);
        await host.send("a", "FYI: later", false);
        assert.deepEqual(
          app.received().map((one) => [one.text, one.behaviour]),
          [
            ["STOP: halt", "interrupt"],
            ["FYI: later", "steer"],
          ],
        );
      },
    },
    {
      says: "what comes again under its id with the same text and interrupt reaches the seat once",
      async run({ host, app }) {
        app.put({ id: "a", status: "idle" });
        await host.send("a", "FYI: one", false, "m-1");
        await host.send("a", "FYI: one", false, "m-1");
        await host.send("a", "FYI: one", false, "m-2");
        assert.deepEqual(
          app.received().map((one) => one.id),
          ["m-1", "m-2"],
        );
      },
    },
    {
      says: "a message the app does not answer in time fails",
      async run({ host, app }) {
        app.put({ id: "a", status: "idle" }).hang.add("send");
        await assert.rejects(host.send("a", "FYI: hello", false), /did not answer the message to a/);
      },
    },
    {
      says: "before the app hands a client, a seat at rest is written to through the CLI, and a running one takes only a stop order",
      before: true,
      async run({ host, app }) {
        app.put({ id: "rest", status: "idle" }).put({ id: "busy", status: "running" });
        await host.send("rest", "RESUME: continue", false);
        await assert.rejects(host.send("busy", "FYI: later", false), /no Paseo client to steer a running seat/);
        assert.deepEqual(
          app.received().map((one) => [one.agentId, one.text]),
          [["rest", "RESUME: continue"]],
        );
      },
    },
  ],
  reparent: [
    {
      says: "the app's record of a seat's parent moves to the one given",
      async run({ host, app }) {
        await host.reparent("child", "parent");
        assert.deepEqual(app.calls(), ["agent update child --label paseo.parent-agent-id=parent"]);
      },
    },
  ],
  live: [
    {
      says: "every open agent is listed, page after page, its state read as one seat's is",
      async run({ host, app }) {
        const statuses = ["idle", "running", "closed", "initializing"] as const;
        for (let i = 0; i < 450; i += 1) app.put({ id: `a-${i}`, status: statuses[i % 4], provider: "claude-peer" });
        app.put({ id: "asks", status: "running", pendingPermissions: [{}] as never });
        const live = await host.live();
        assert.equal(live.size, 451);
        for (const id of ["a-0", "a-1", "a-2", "a-3", "a-449", "asks"])
          assert.equal(live.get(id)?.state, await host.state(id), id);
      },
    },
    {
      says: "an archived agent is not listed",
      async run({ host, app }) {
        app.put({ id: "open", status: "idle" }).put({ id: "old", status: "idle", archivedAt: "2026-10-14T00:00:00Z" });
        assert.deepEqual([...(await host.live()).keys()], ["open"]);
      },
    },
    {
      says: "a list that never ends is refused, not read as the whole list",
      async run({ host, app }) {
        app.endless = true;
        await assert.rejects(host.live(), /more than \d+ open agents/);
      },
    },
    {
      says: "a list the app does not give in time fails",
      async run({ host, app }) {
        app.hang.add("list");
        await assert.rejects(host.live(), /did not answer the list of open seats/);
      },
    },
  ],
  seat: [
    {
      says: "an open agent is read whole: its provider, title, folder, status, turn, usage and model",
      async run({ host, app }) {
        app.put({
          id: "a",
          provider: "claude-peer",
          title: "[Peer] store",
          cwd: "/work/p",
          status: "running",
          updatedAt: "2026-10-16T10:00:00.000Z",
          activeTurn: { startedAt: "2026-10-16T09:59:00.000Z" } as never,
          lastUsage: { totalCostUsd: 1.5, outputTokens: 900 } as never,
          model: "opus",
        });
        const seat = await host.seat("a");
        assert.deepEqual(
          seat && [seat.provider, seat.title, seat.cwd, seat.state, seat.turnStartedAt, seat.usage, seat.model],
          [
            "claude-peer",
            "[Peer] store",
            "/work/p",
            "running",
            "2026-10-16T09:59:00.000Z",
            { totalCostUsd: 1.5, outputTokens: 900 },
            "opus",
          ],
        );
      },
    },
    {
      says: "an archived agent is no seat, and an app that does not answer in time is a failure",
      async run({ host, app }) {
        app.put({ id: "old", status: "idle", archivedAt: "2026-10-14T00:00:00Z" });
        assert.equal(await host.seat("old"), null);
        app.hang.add("refresh");
        await assert.rejects(host.seat("old"), /did not answer the seat request for old/);
      },
    },
  ],
  create: [
    {
      says: "a seat starts under its key with the provider, model, mode, thinking, folder, parent and brief asked",
      async run({ host, app }) {
        const id = await host.create({
          key: "start-1",
          provider: "claude-peer",
          model: "opus",
          mode: "bypass",
          thinking: "high",
          cwd: "/work/p",
          parent: "lead-1",
          title: "[Peer] store",
          prompt: "Outcome: one store",
        });
        const [start] = app.started();
        assert.equal(start.id, id);
        assert.equal(start.key, "start-1");
        assert.deepEqual(start.request.config, {
          provider: "claude-peer/opus",
          modeId: "bypass",
          thinkingOptionId: "high",
        });
        assert.deepEqual(
          [start.request.cwd, start.request.parent, start.request.title, start.request.prompt],
          ["/work/p", "lead-1", "[Peer] store", "Outcome: one store"],
        );
      },
    },
    {
      says: "a start the app answers late is asked once more under its key, and the app hands back the one seat",
      async run({ host, app }) {
        app.late.set("create", [LATE]);
        const id = await host.create({
          key: "start-2",
          provider: "claude-peer",
          cwd: "/work/p",
          title: "t",
          prompt: "p",
        });
        assert.deepEqual(
          app.started().map((one) => one.id),
          [id],
        );
      },
    },
    {
      says: "a start the app never answers fails",
      async run({ host, app }) {
        app.hang.add("create");
        await assert.rejects(
          host.create({ key: "start-3", provider: "claude-peer", cwd: "/work/p", title: "t", prompt: "p" }),
          /did not answer the start of t/,
        );
      },
    },
  ],
  archive: [
    {
      says: "the agent is archived",
      async run({ host, app }) {
        app.put({ id: "a", status: "idle" });
        await host.archive("a");
        assert.ok(app.agent("a")?.archivedAt);
      },
    },
    {
      says: "before the app hands a client, the agent is archived through the CLI",
      before: true,
      async run({ host, app }) {
        await host.archive("a");
        assert.deepEqual(app.calls(), ["agent archive a"]);
      },
    },
    {
      says: "an archive the app does not answer in time fails",
      async run({ host, app }) {
        app.put({ id: "a", status: "idle" }).hang.add("archive");
        await assert.rejects(host.archive("a"), /did not answer the archive of a/);
      },
    },
  ],
  turn: [
    {
      says: "the steps of a seat's latest turn are those of its last turn id",
      async run({ host, app }) {
        app.timeline("a", turnOf("a"));
        assert.deepEqual(
          (await host.turn("a", 50))?.map((event) => event.kind),
          ["prompt", "shell", "say"],
        );
      },
    },
    {
      says: "a history the app does not give in time is unread",
      async run({ host, app }) {
        app.hang.add("timeline");
        assert.equal(await host.turn("a", 50), null);
      },
    },
  ],
  prompts: [
    {
      says: "the prompts a seat was given among its last entries, oldest first",
      async run({ host, app }) {
        app.timeline("a", turnOf("a"));
        assert.deepEqual(await host.prompts("a", 50), ["an old prompt", "the brief of a"]);
        assert.deepEqual(await host.prompts("a", 3), ["the brief of a"]);
      },
    },
    {
      says: "a history the app does not give in time is unread",
      async run({ host, app }) {
        app.hang.add("timeline");
        assert.equal(await host.prompts("a", 50), null);
      },
    },
  ],
  projects: [
    {
      says: "the projects the app knows, by name and folder",
      async run({ host, app }) {
        app.projects([
          { name: "alpha", path: "/work/alpha" },
          { name: "beta", path: "/work/beta" },
        ]);
        assert.deepEqual(await host.projects(), [
          { name: "alpha", path: "/work/alpha" },
          { name: "beta", path: "/work/beta" },
        ]);
      },
    },
    {
      says: "a list the app does not give in time fails",
      async run({ host, app }) {
        app.hang.add("projects");
        await assert.rejects(host.projects(), /did not answer the list of projects/);
      },
    },
  ],
  dropWakers: [
    {
      says: "the timers of a gone seat go, and the finished ones of a live seat; a timer aimed elsewhere stays",
      async run({ host, app }) {
        const ids = ["users-finished", "live-finished", "live-running", "gone-running", "new-agent"];
        app.schedules([
          { id: "users-finished", agentId: "users-own", status: "completed" },
          { id: "live-finished", agentId: "seat-live", status: "completed" },
          { id: "live-running", agentId: "seat-live", status: "active" },
          { id: "gone-running", agentId: "seat-gone", status: "active" },
          { id: "new-agent", agentId: null, status: "active" },
        ]);
        const states: Record<string, "gone" | "live"> = { "seat-live": "live", "seat-gone": "gone" };
        const { deleted, failed } = await host.dropWakers((agentId) => states[agentId] ?? null);
        assert.deepEqual(app.scheduled(ids), ["users-finished", "live-running", "new-agent"]);
        assert.equal(deleted.length, 2);
        assert.deepEqual(failed, []);
      },
    },
    {
      says: "a timer that cannot be deleted is named, and those after it still go",
      async run({ host, app }) {
        app.schedules(
          ["a-stuck", "b-done", "c-done"].map((id) => ({
            id,
            agentId: "seat-gone",
            status: "active",
            stuck: id === "a-stuck",
          })),
        );
        const { deleted, failed } = await host.dropWakers(() => "gone");
        assert.deepEqual(app.scheduled(["a-stuck", "b-done", "c-done"]), ["a-stuck"]);
        assert.equal(deleted.length, 2);
        assert.equal(failed.length, 1);
        assert.match(failed[0], /heartbeat a-stuck .*no such schedule/);
      },
    },
  ],
  address: [
    {
      says: "the app's listen address as the app settles it: PASEO_LISTEN, then its config, then PORT on 127.0.0.1",
      async run({ host }) {
        const config = join(PASEO_HOME, "config.json");
        const env = { listen: process.env.PASEO_LISTEN, port: process.env.PORT };
        try {
          delete process.env.PASEO_LISTEN;
          process.env.PORT = "7001";
          assert.equal(host.address(), "127.0.0.1:7001");
          writeFileSync(config, JSON.stringify({ daemon: { listen: "unix:///tmp/paseo.sock" } }));
          assert.equal(host.address(), "unix:///tmp/paseo.sock");
          process.env.PASEO_LISTEN = "0.0.0.0:7002";
          assert.equal(host.address(), "0.0.0.0:7002");
        } finally {
          rmSync(config, { force: true });
          for (const [name, value] of [
            ["PASEO_LISTEN", env.listen],
            ["PORT", env.port],
          ] as const)
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
      },
    },
  ],
};
