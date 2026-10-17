import assert from "node:assert/strict";
import { test } from "node:test";
import { contextFell } from "../server/orchestration/compaction";

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
