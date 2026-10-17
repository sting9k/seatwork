import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import contribute from "../index.server";
import { roomProjectDir } from "../server/orchestration/registry";
import { fakeServer } from "./support/server";
import { roomSeats } from "./room-seats";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-hq", "claude-lead", "claude-peer"]);
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  // a service error is tried again at the next minute's sweep
  policy.room.recovery.delaysSeconds = [0, 0, 0];
  writeFileSync(file, JSON.stringify(policy));
  console.log = console.error = () => {};
  mock.timers.enable({ apis: ["setInterval"] });
  dispose = contribute(paseoSide.server);
});

after(async () => {
  mock.timers.reset();
  await dispose();
  Object.assign(console, output);
});

const { seat, fails } = roomSeats(call);
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
