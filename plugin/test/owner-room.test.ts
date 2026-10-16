import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { SAFETY_DIR } from "../server/paths";
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

test("a seat's command a grave rule holds for runs and is kept, nothing waits on the person, and the app is told the room's seats", async () => {
  const peer = await seat("peer-kept", "claude-peer", null, "[Peer] kept", PROJECT);
  const command = `echo x > ${join(ROOM_HOME, "policy.json")}`;
  assert.equal(await peer.hook("Bash", { command }), "", "the command runs");

  const db = new DatabaseSync(join(SAFETY_DIR, "safety.db"), { readOnly: true });
  try {
    const kept = db.prepare("SELECT rule FROM decisions WHERE seat = ?").all(peer.agent.id) as { rule: string }[];
    assert.deepEqual(
      kept.map(({ rule }) => rule),
      ["room-file-write"],
    );
  } finally {
    db.close();
  }
  const waiting = (await call("rpc room.waiting", {}, context)) as { waiting: unknown[]; seats: string[] };
  assert.deepEqual(waiting.waiting, []);
  assert.ok(
    waiting.seats.includes(peer.agent.id),
    "the app is told the room's seats, to put the room on their composer",
  );
});

interface Places {
  required: { id: string; on: boolean }[];
  optional: { id: string; on: boolean }[];
}

test("the person turns the room's optional Jev places on and off, kept in the room's policy; a place the room needs stays on", async () => {
  const places = (await call("rpc jev.places", {}, context)) as Places;
  assert.deepEqual(
    places.required.map(({ id, on }) => [id, on]),
    [
      ["knowledge.gate", true],
      ["forks.answers", true],
      ["forks.overlap", true],
    ],
  );
  assert.deepEqual(
    places.optional.map(({ id }) => id),
    ["council.claims", "council.scope", "council.gaming"].concat(
      ["report", "wake", "failure", "tier", "gaps", "escalate", "duplicate", "incident"].map((name) => `forks.${name}`),
    ),
  );
  const on = (list: Places, id: string) => list.optional.find((place) => place.id === id)?.on;
  assert.equal(
    on((await call("rpc jev.place", { id: "forks.tier", on: true }, context)) as Places, "forks.tier"),
    true,
  );
  assert.equal(
    on((await call("rpc jev.place", { id: "council.scope", on: false }, context)) as Places, "council.scope"),
    false,
  );
  const file = JSON.parse(readFileSync(join(ROOM_HOME, "policy.json"), "utf8"));
  assert.ok(file.jev.forks.includes("tier"));
  assert.deepEqual(file.safety.council.jurors, ["claims", "gaming"]);
  await assert.rejects(call("rpc jev.place", { id: "forks.answers", on: false }, context), /the room needs it/);
  await assert.rejects(call("rpc jev.place", { id: "forks.nope", on: true }, context), /no place/);
});
