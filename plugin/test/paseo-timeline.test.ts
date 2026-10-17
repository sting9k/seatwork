import assert from "node:assert/strict";
import { test } from "node:test";
import { eventOf, eventsOf, sinceMark } from "../server/paseo/timeline";

const item = (shape: Record<string, unknown>) => ({ type: "compaction", ...shape });

test("the compaction items each agent CLI's timeline carries are one event when the compaction is done, and none while it runs", () => {
  const shapes = {
    "Claude, compact_boundary": item({ status: "completed", trigger: "manual", preTokens: 180_000 }),
    "Codex, contextCompaction item": item({ status: "completed" }),
    "Codex, thread/compacted": item({ status: "completed", trigger: "auto" }),
    "Pi, compaction_end": item({ status: "completed", trigger: "auto" }),
    "Pi, a manual compact run outside a turn": item({ status: "completed", trigger: "manual" }),
    "OpenCode, session.compacted": item({ status: "completed" }),
    "an older app, no status": item({}),
  };
  for (const [what, shape] of Object.entries(shapes)) assert.deepEqual(eventOf(shape), { kind: "compaction" }, what);
  for (const trigger of ["auto", "manual", undefined])
    assert.equal(eventOf(item({ status: "loading", trigger })), null, "a compaction that has not finished");
  assert.deepEqual(
    eventsOf([item({ status: "loading" }), { type: "assistant_message", text: "ok" }, item({ status: "completed" })]),
    [{ kind: "say", text: "ok" }, { kind: "compaction" }],
    "the marker that opens a compaction and the one that closes it are one compaction",
  );
});

test("a compaction a seat's CLI ran outside a turn is read in the next turn's items, and only once", () => {
  const before = [
    { type: "user_message", text: "go" },
    { type: "assistant_message", text: "done" },
  ];
  const first = sinceMark(before, undefined);
  const timeline = [
    ...before,
    item({ status: "loading", trigger: "manual" }),
    item({ status: "completed", trigger: "manual" }),
  ];
  const later = [...timeline, { type: "user_message", text: "next" }, { type: "assistant_message", text: "ok" }];
  const second = sinceMark(later, first.mark);
  assert.deepEqual(
    eventsOf(second.items).map((event) => event.kind),
    ["compaction", "prompt", "say"],
  );
  assert.deepEqual(
    eventsOf(sinceMark([...later, { type: "assistant_message", text: "more" }], second.mark).items).map((e) => e.kind),
    ["say"],
  );
});

test("a turn read with no mark from before starts at its prompt", () => {
  const timeline = [
    { type: "user_message", text: "one" },
    { type: "assistant_message", text: "done one" },
    { type: "user_message", text: "two" },
    { type: "assistant_message", text: "done two" },
  ];
  const fresh = sinceMark(timeline, undefined);
  assert.deepEqual(
    fresh.items,
    timeline.slice(2),
    "after a restart the room has no mark: the last prompt opens the turn",
  );
  const moved = sinceMark([...timeline.slice(1), { type: "user_message", text: "three" }], {
    count: 2,
    last: sinceMark(timeline.slice(0, 2), undefined).mark.last,
  });
  assert.deepEqual(
    moved.items,
    [timeline[2], timeline[3], { type: "user_message", text: "three" }],
    "a cut timeline is read after the last item seen",
  );
});
