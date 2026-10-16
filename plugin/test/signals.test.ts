import assert from "node:assert/strict";
import { test } from "node:test";
import { asksOwner, priorityOf, signalOf, subjectOpening, subjectSignal } from "../server/signals";
import { fastestInTurns } from "./support/timing";

test("a final message is read for the signal it opens with, and for what it leaves to its Owner", () => {
  assert.equal(signalOf("\n\n  CANDIDATE: the index is in"), "CANDIDATE");
  assert.equal(signalOf("ACK noted\nCANDIDATE later"), "ACK");
  assert.equal(signalOf("all done, DONE"), "DONE");
  assert.equal(signalOf("nothing to say"), undefined);
  assert.equal(asksOwner("DECISION_NEEDED: which unit?"), "DECISION_NEEDED");
  assert.equal(asksOwner("work done\n  WAITING ON YOU: the key"), "WAITING ON YOU");
  assert.equal(asksOwner("work done\r\nWAITING ON YOU:\r\n   the key"), "WAITING ON YOU");
  assert.equal(asksOwner("work done\nWAITING ON YOU:   \n"), null, "a wait that names nothing is none");
  assert.equal(asksOwner("not waiting on you: no"), null);
});

test("a subject opens with a signal of the room, or with none", () => {
  assert.equal(subjectOpening("  revised brief: new scope"), "REVISED BRIEF");
  assert.equal(subjectOpening("ACKNOWLEDGED: x"), undefined, "a word that only starts like a signal is none");
  assert.equal(subjectSignal("-- DONE: docs"), "DONE");
  assert.equal(subjectSignal("see DONE below"), undefined);
  assert.equal(priorityOf("BLOCKED: the key", "nothing", false), "blocking");
  assert.equal(priorityOf("FYI: moved", "reply", false), "action");
});

test("reading a final message takes time in proportion to its length, however many blank lines it holds", async () => {
  const [few, many] = [8000, 32_000].map((lines) => `STATUS\n${" \n".repeat(lines)}x`);
  const [fastSmall, fastLarge] = await fastestInTurns(
    () => asksOwner(few),
    () => asksOwner(many),
    5,
  );
  assert.ok(
    fastLarge < Math.max(fastSmall, 1) * 10,
    `8000 lines: ${fastSmall.toFixed(1)} ms, 32000 lines: ${fastLarge.toFixed(1)} ms`,
  );
});
