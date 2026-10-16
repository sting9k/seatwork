import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";
import { roomSeats } from "./room-seats";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-supervisor", "claude-lead", "claude-peer"]);
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

const { context, seat } = roomSeats(call);

interface Waiting {
  seats: string[];
  codes: { code: string; agentId: string; title: string | null; rule: string; reason: string; command: string }[];
}

test("a code only the person may grant waits in the room's answer to the app, and the person's grant lets its command run once", async () => {
  const peer = await seat("peer-code", "claude-peer", null, "[Peer] code", PROJECT);
  const command = `echo x > ${join(ROOM_HOME, "policy.json")}`;
  const denied = JSON.parse(await peer.hook("Bash", { command }));
  const code = /code (\d{6})/.exec(denied.hookSpecificOutput.permissionDecisionReason)![1];

  const waiting = (await call("rpc room.waiting", {}, context)) as Waiting;
  assert.ok(
    waiting.seats.includes(peer.agent.id),
    "the app is told the room's seats, to put the room on their composer",
  );
  const listed = waiting.codes.find((one) => one.code === code);
  assert.deepEqual([listed?.agentId, listed?.title, listed?.rule], [peer.agent.id, "[Peer] code", "room-file-write"]);
  assert.equal(listed?.command, command);
  assert.match(listed?.reason ?? "", /room's own files/);

  const granted = (await call("rpc room.grant", { code }, context)) as { message: string };
  assert.match(granted.message, /^Granted/);
  assert.equal(await peer.hook("Bash", { command }), "", "the person's grant lets the command run");
  assert.match(await peer.hook("Bash", { command }), /permissionDecision":"deny/, "once");
  const after = (await call("rpc room.waiting", {}, context)) as Waiting;
  assert.equal(
    after.codes.some((one) => one.code === code),
    false,
    "a granted code no longer waits",
  );
});
