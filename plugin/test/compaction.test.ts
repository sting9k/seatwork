import assert from "node:assert/strict";
import { test } from "node:test";
import { contextFell } from "../server/orchestration/compaction";
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

test("a context that fell by half or more, and by 20,000 tokens or more, between two turns is a compaction; no smaller fall is", () => {
  const held = (contextWindowUsedTokens: number) => ({ contextWindowUsedTokens });
  assert.equal(contextFell(held(150_000), held(30_000)), true);
  assert.equal(contextFell(held(150_000), held(75_000)), true, "exactly half");
  assert.equal(contextFell(held(30_000), held(5_000)), true);
  assert.equal(contextFell(held(150_000), held(100_000)), false, "a third is not a compaction");
  assert.equal(contextFell(held(150_000), held(75_001)), false);
  assert.equal(contextFell(held(15_000), held(2_000)), false, "too small a context to tell");
  assert.equal(contextFell(held(50_000), held(60_000)), false, "growth");
  assert.equal(contextFell(held(50_000), held(50_000)), false);
  assert.equal(contextFell(undefined, held(1_000)), false, "no turn before");
  assert.equal(contextFell(held(150_000), {}), false, "the CLI reported no size");
  assert.equal(contextFell({}, held(1_000)), false);
  assert.equal(contextFell(held(150_000), { contextWindowUsedTokens: Number.NaN }), false);
});
