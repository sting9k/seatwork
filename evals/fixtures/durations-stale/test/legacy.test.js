const test = require("node:test");
const assert = require("node:assert/strict");

// Pinned the tokenizer's internal token list. The tokenizer was removed in March 2025.
test.skip("tokenizer emits [number, unit]", () => {
  const { tokenize } = require("../src/legacy-parser");
  assert.deepEqual(tokenize("90s"), [{ type: "number", value: 90 }, { type: "unit", value: "s" }]);
});
