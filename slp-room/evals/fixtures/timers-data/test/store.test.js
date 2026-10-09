const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTimers } = require("../src/store");

test("loads every timer file", () => {
  const timers = loadTimers();
  assert.equal(timers.length, 3);
  assert.equal(timers.find((t) => t.name === "kitchen").ms, 5_400_000);
});
