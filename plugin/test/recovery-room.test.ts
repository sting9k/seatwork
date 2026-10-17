import { PROJECT } from "./support/room";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { roomProjectDir } from "../server/orchestration/registry";
import { pluginRoom } from "./support/plugin";

const { seat, fails } = pluginRoom(["claude-hq", "claude-lead", "claude-peer"], {
  // a service error is tried again at the next minute's sweep
  policy: (policy) => void (policy.room.recovery.delaysSeconds = [0, 0, 0]),
  timers: "minute",
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a seat whose turn failed on the service is still resumed after the operator read how many wait", async () => {
  const hq = await seat("hq-recovery", "claude-hq", null, "[HQ] room", roomProjectDir());
  const lead = await seat("lead-recovery", "claude-lead", null, "[Lead] stream", PROJECT);
  const peer = await seat("peer-recovery", "claude-peer", "lead-recovery", "[Peer] store", PROJECT);

  await fails(peer, "API Error: 529 Overloaded");
  const waiting = async () =>
    (JSON.parse(await hq.call("seatwork_room", { do: "seats" })) as Record<string, unknown>).seats;
  assert.deepEqual(await waiting(), { retrying: 1 });
  assert.deepEqual(await waiting(), { retrying: 1 }, "a reading took the retry it counted");

  mock.timers.tick(60_000);
  for (let waited = 0; peer.inbox.length === 0 && waited < 100; waited += 1) await settle();
  assert.equal(peer.inbox.length, 1);
  assert.match(peer.inbox[0], /subject="RESUME: /);
  assert.deepEqual(lead.inbox, [], "nobody above is told of a failure the room mends");
});
