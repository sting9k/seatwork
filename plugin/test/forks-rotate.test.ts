import "./support/room";
import { forksWith, modelSaying } from "./forks-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { atMilestone } from "../server/orchestration/rotation";
import { ownerNote } from "../server/orchestration/rounds";

const LINE = 200_000;
const seat = (tokens: number | null, message = "DONE abc1\nthe endpoint is finished", role = "peer") => ({
  role,
  tokens,
  message,
});

test("a seat over a share of the rotation line, and under it, is read at its turn's end; the model is sure of a milestone or of mid_work", async () => {
  const milestone = modelSaying("milestone");
  const { forks, lines } = forksWith(milestone.router, ["rotate"]);
  assert.equal(await atMilestone(forks, seat(130_000), LINE), true);
  assert.deepEqual(lines, ["fork rotate: milestone (0.95)"]);
  const [call] = milestone.asked;
  assert.equal(call.caller, "forks.rotate@1");
  assert.deepEqual(call.labels, ["milestone", "mid_work"]);
  assert.deepEqual(call.state, { message: "DONE abc1\nthe endpoint is finished", held_tokens: 130_000 });

  const middle = modelSaying("mid_work");
  assert.equal(await atMilestone(forksWith(middle.router, ["rotate"]).forks, seat(130_000), LINE), false);
});

test("below the share, at or past the line, with no message, no line, or a role that has no rotation line, the model is not asked", async () => {
  const model = modelSaying("milestone");
  const { forks } = forksWith(model.router, ["rotate"]);
  assert.equal(await atMilestone(forks, seat(119_999), LINE), false, "under 0.6 of the line");
  assert.equal(await atMilestone(forks, seat(120_000), LINE), true, "from 0.6 of the line");
  const asked = model.asked.length;
  assert.equal(await atMilestone(forks, seat(LINE), LINE), false, "at the line the room's own line is told already");
  assert.equal(await atMilestone(forks, seat(300_000), LINE), false);
  assert.equal(await atMilestone(forks, seat(null), LINE), false, "no reading of the context");
  assert.equal(await atMilestone(forks, seat(150_000, "  \n"), LINE), false, "no final message");
  assert.equal(await atMilestone(forks, seat(150_000), Infinity), false, "no line");
  assert.equal(await atMilestone(forks, seat(150_000, "done", "hq"), LINE), false, "a role with no rotation line");
  assert.equal(model.asked.length, asked);
});

test("a split answer, a fork that is off and no model leave a seat where it is", async () => {
  assert.equal(
    await atMilestone(forksWith(modelSaying("milestone", 0.7).router, ["rotate"]).forks, seat(150_000), LINE),
    false,
  );
  const off = modelSaying("milestone");
  assert.equal(await atMilestone(forksWith(off.router, []).forks, seat(150_000), LINE), false);
  assert.equal(off.asked.length, 0);
  assert.equal(await atMilestone(forksWith(null, ["rotate"]).forks, seat(150_000), LINE), false);
});

test("the message the model reads is clipped to what a report may be, and the line it earns is the room's own rotation line", async () => {
  const model = modelSaying("milestone");
  await atMilestone(forksWith(model.router, ["rotate"]).forks, seat(150_000, "x".repeat(9000)), LINE);
  assert.ok(String(model.asked[0].state.message).length <= 2001);

  const standing = { role: "peer", candidate: false, rejected: 0, contextTokens: 150_000, rotateAtTokens: LINE };
  assert.equal(ownerNote(standing), null, "under the line, nothing is said");
  assert.match(
    String(ownerNote({ ...standing, early: true })),
    /\[room\] This Peer holds 150K tokens of context .* goes to a new Peer\./,
  );
  assert.equal(ownerNote({ ...standing, early: true, contextTokens: null }), null, "an early line needs a reading");
  assert.equal(
    ownerNote({ ...standing, early: true, role: "lens" }),
    null,
    "a role with no rotation line says nothing",
  );
});
