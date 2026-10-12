const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseDuration } = require("../src/duration");

test("seconds", () => assert.equal(parseDuration("90s"), 90_000));
test("minutes", () => assert.equal(parseDuration("5m"), 300_000));
test("rejects what it does not know", () => assert.throws(() => parseDuration("1x")));
