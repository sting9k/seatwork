import assert from "node:assert/strict";
import { test } from "node:test";
import { componentGlob } from "../server/safety/gate/glob";
import { fastestInTurns } from "./support/timing";

test("a component glob reads * ? [set] {a,b} without regard to case", () => {
  const holds = (pattern: string, name: string) => componentGlob(pattern)(name);
  assert.ok(holds("id_*", "ID_RSA"));
  assert.ok(holds("*.pub", "id_rsa.pub"));
  assert.ok(!holds("*.pub", "id_rsa.pubx"));
  assert.ok(holds("?sh", "ASH"));
  assert.ok(!holds("?sh", "sh"));
  assert.ok(holds("[a-c]x", "Bx"));
  assert.ok(!holds("[!a-c]x", "bx"));
  assert.ok(holds("[!a-c]x", "dx"));
  assert.ok(holds("{ab,cd}e", "CDE"));
  assert.ok(holds("a{,b}c", "ac"));
  assert.ok(!holds("{ab,cd}e", "abce"));
  assert.ok(holds("a*b*c", "aXXbYYc"));
  assert.ok(!holds("a*b*c", "aXXbYY"));
  assert.ok(holds("", ""));
  assert.ok(!holds("", "a"));
});

test("a component glob reads a bracket or brace without its close as the character itself", () => {
  assert.ok(componentGlob("a[b")("a[b"));
  assert.ok(componentGlob("x{y")("x{y"));
  assert.ok(!componentGlob("a[b")("ab"));
});

test("a component glob it cannot read matches any name, the safe side", () => {
  assert.ok(componentGlob("[z-a]")("anything"));
  assert.ok(componentGlob("a".repeat(1001))("anything"));
});

test("a component glob with many stars is decided in steps proportional to its length", async () => {
  const name = "application_default_credentials.json";
  assert.equal(componentGlob(`${"*?".repeat(400)}z`)(name), false);
  assert.equal(componentGlob(`${"*?".repeat(10)}n`)(name), true);
  assert.equal(componentGlob(`${"*a".repeat(400)}b`)(name), false);
  const decide = (pairs: number) => () => {
    for (let i = 0; i < 300; i += 1) componentGlob(`${"*?".repeat(pairs)}z`)(name);
  };
  // four times the stars: a matcher that tried each star against each other would do sixteen times the work
  const [short, long] = await fastestInTurns(decide(100), decide(400));
  assert.ok(long < Math.max(short, 1) * 8, `100 stars: ${short.toFixed(2)} ms, 400 stars: ${long.toFixed(2)} ms`);
});
