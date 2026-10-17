import { installRoom, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";
import { roomSeats } from "./room-seats";

/** A room set up with its own seat alone: every district must run with no worker seat. */

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
const { context, seat } = roomSeats(call);
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-hq"]);
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

test("with its own seat alone the room starts, the seat runs it, records the room's decisions, and lists projects", async () => {
  const hq = await seat("hq-alone", "claude-hq", null, "HQ", join(ROOM_HOME, "hq-seatwork"));
  const health = JSON.parse(await hq.call("seatwork_room", { do: "health" }));
  assert.ok(health.readings.includes("safety"));
  for (const reading of health.readings) assert.ok(JSON.parse(await hq.call("seatwork_room", { do: reading })));
  await call("on agent.turn_started", { agent: hq.agent, turnId: "t1" }, context);
  const decided = JSON.parse(
    await hq.call("seatwork_knowledge", {
      do: "decide",
      scope: "room",
      topic: "jev spend",
      statement: "Keep the decision model under five dollars a month.",
    }),
  );
  assert.equal(decided.state, "pending");
  await call(
    "on agent.turn_ended",
    {
      agent: hq.agent,
      turnId: "t1",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "giữ Jev dưới 5 đô một tháng" },
        { type: "assistant_message", text: "Recorded." },
      ],
    },
    context,
  );
  const list = JSON.parse(await hq.call("seatwork_knowledge", { do: "list" }));
  assert.match(list.inForce[0], /jev-spend: Keep the decision model under five dollars a month/);
  assert.match(await hq.call("seatwork_projects", {}), /\S/);
});

test("a worker seat the room has not set up is refused at its start, and the room goes on", async () => {
  await assert.rejects(
    () => seat("lead-none", "claude-lead", null, "[Lead] x", join(ROOM_HOME, "hq-seatwork")),
    /not a seat the room has set up/,
  );
  const hq = await seat("hq-again", "claude-hq", null, "HQ", join(ROOM_HOME, "hq-seatwork"));
  assert.ok(JSON.parse(await hq.call("seatwork_room", { do: "policy" })).tunable);
});
