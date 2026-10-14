import assert from "node:assert/strict";
import { test } from "node:test";
import { componentGlob, treeGlob } from "../server/safety/gate/glob";

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

test("a component glob with many stars is decided in steps proportional to its length", () => {
  const name = "application_default_credentials.json";
  const started = performance.now();
  assert.equal(componentGlob(`${"*?".repeat(400)}z`)(name), false);
  assert.equal(componentGlob(`${"*?".repeat(10)}n`)(name), true);
  assert.equal(componentGlob(`${"*a".repeat(400)}b`)(name), false);
  // the bound only catches a matcher that backtracks without end
  assert.ok(performance.now() - started < 2_000);
});

test("a tree glob holds for the path itself and for everything under it", () => {
  const holds = (glob: string, path: string) => treeGlob(glob, "/h")(path);
  assert.ok(holds("/p/build/**", "/p/build/out"));
  assert.ok(holds("/p/build/**", "/p/build/a/b"));
  assert.ok(!holds("/p/build/**", "/p/build"));
  assert.ok(!holds("/p/build/**", "/p/builds/x"));
  assert.ok(holds("/p/build", "/p/build"));
  assert.ok(holds("/p/build", "/p/build/out"));
  assert.ok(!holds("/p/build", "/p/builds"));
});

test("in a tree glob * stays inside one folder and ** crosses folders", () => {
  const holds = (glob: string, path: string) => treeGlob(glob, "/h")(path);
  assert.ok(holds("/p/*/c", "/p/a/c"));
  assert.ok(holds("/p/*/c", "/p/a/c/d"));
  assert.ok(!holds("/p/*/c", "/p/a/b/c"));
  assert.ok(holds("/p/**/c", "/p/a/b/c"));
  assert.ok(holds("/p/a*", "/p/abc"));
  assert.ok(holds("/p/a*", "/p/abc/d"));
  assert.ok(!holds("/p/a*", "/p/b"));
});

test("a tree glob takes ~/ for the home and every other character as itself", () => {
  const holds = (glob: string, path: string) => treeGlob(glob, "/h")(path);
  assert.ok(holds("~/work/**", "/h/work/a"));
  assert.ok(!holds("~/work/**", "/x/work/a"));
  assert.ok(holds("/p/a.b", "/p/a.b"));
  assert.ok(!holds("/p/a.b", "/p/aXb"));
  assert.ok(holds("/p/a+b(c)?", "/p/a+b(c)?"));
  assert.ok(!holds("/p/a?", "/p/ab"));
});

test("a tree glob with several ** is decided in steps proportional to the path", () => {
  const test4 = treeGlob("/p/**/a/**/a/**/a/**/b", "/h");
  const started = performance.now();
  assert.equal(test4(`/p${"/a".repeat(20_000)}`), false);
  assert.equal(test4(`/p${"/a".repeat(20_000)}/b`), true);
  assert.ok(performance.now() - started < 2_000);
});
