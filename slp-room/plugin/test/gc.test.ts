import { MAIL_POLICY } from "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Collector } from "../server/gc";
import { MailEngine } from "../server/mail";

test("GC archives a seat that is at rest, never one that waits on someone or went back to work", async () => {
  const longAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
  // what agents.list reported, and (when it differs) what the agent is by the time GC reaches it
  const seats: Record<string, { listed: object; now?: object }> = {
    idle: { listed: { status: "idle" } },
    closed: { listed: { status: "closed" } },
    error: { listed: { status: "error" } },
    "needs-input": { listed: { status: "needs_input" } },
    permission: { listed: { status: "permission" } },
    attention: { listed: { status: "attention" } },
    "pending-permission": { listed: { status: "idle", pendingPermissions: [{ id: "p1" }] } },
    "woke-up": { listed: { status: "idle" }, now: { status: "running" } },
  };
  const archived: string[] = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: Object.entries(seats).map(([id, seat]) => ({ agent: { id, updatedAt: longAgo, ...seat.listed } })) }),
      ref: (id: string) => ({
        refresh: async () => {},
        current: () => ({ id, updatedAt: longAgo, ...(seats[id].now ?? seats[id].listed) }),
        archive: async () => void archived.push(id),
      }),
    },
  };
  const engine = new MailEngine(paseo as never, MAIL_POLICY, { routes: {}, spawn: {} } as never, () => {});
  for (const agentId of Object.keys(seats)) engine.rememberSeat({ agentId, parentAgentId: null, role: "peer", provider: "claude-peer", title: null });
  const policy = { everyMinutes: 10, idleHoursBeforeArchive: { peer: 48 }, deleteOrphanHeartbeats: false, tellParent: false };

  await new Collector(paseo as never, engine, policy as never, () => {}, () => {}).run();

  assert.deepEqual(archived, ["idle", "closed", "error"]);
});
