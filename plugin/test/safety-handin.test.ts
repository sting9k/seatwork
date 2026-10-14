import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { packsInForce } from "../server/safety/gate/packs";
import { handInLine, handInReturn, inspectHandIn } from "../server/safety/handin";
import { SafetyStore } from "../server/safety/store";
import { machineTools } from "../server/safety/system";

shipSql();

let repos = 0;
/** A git repository with one commit of a small project, and a store that knows a seat started there. */
function project(files: Record<string, string>) {
  const dir = join(ROOM_HOME, `handin-${(repos += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  git("init", "-q");
  write(dir, { ...files, ".gitignore": ".store/\nnode_modules/\ndist/\n" });
  git("add", "-A");
  git("commit", "-qm", "start");
  const store = new SafetyStore(join(dir, ".store"), 1000);
  store.noteStart("seat", dir, git("rev-parse", "HEAD"));
  const gate = {
    place: { home: "/Users/u", project: dir, tmp: null, start: dir, guard: null, roomFolder: ".seatwork" },
    config: { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  };
  return { dir, store, git, check: () => inspectHandIn("seat", store, gate) };
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const START = {
  "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n",
  "test/sum.test.ts":
    'import { sum } from "../src/sum";\ntest("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n  expect(sum(0, 0)).toBe(0);\n});\n',
  "test/old.test.ts": 'test("old", () => expect(1).toBe(1));\n',
  "package.json": '{"name":"x","scripts":{"test":"jest"}}\n',
};

test("the check reads what the seat changed since it started, committed or not, new files included", async () => {
  const { dir, check, git } = project(START);
  write(dir, {
    "test/sum.test.ts":
      'import { sum } from "../src/sum";\ntest.only("sum", () => {\n  expect(sum(1, 2)).toBeTruthy();\n});\n',
    "src/sum.ts":
      'export const sum = (a: number, b: number) => {\n  debugger;\n  // TODO handle floats\n  const key = "sk-proj-Abcdefghijklmnopqrstuvwx12";\n  return a + b;\n};\n',
    "package.json": '{"name":"x","scripts":{"test":"jest","clean":"rm -rf ~"}}\n',
    "src/new.ts": 'const s = "it.only( and debugger; inside a string are data";\n',
  });
  git("add", "src/sum.ts");
  git("commit", "-qm", "work in progress");
  rmSync(join(dir, "test/old.test.ts"));
  const result = await check();
  assert.equal(result.state, "blocked");
  const open = result.open.map((r) => `${r.rule} ${r.path}`).sort();
  assert.deepEqual(open, [
    "assertions-removed test/sum.test.ts",
    "debugger src/sum.ts",
    "destructive-script package.json",
    "hardcoded-secret src/sum.ts",
    "test-deleted test/old.test.ts",
    "test-focused test/sum.test.ts",
  ]);
  assert.deepEqual(result.warnings.map((r) => r.rule).sort(), ["new-todo", "weak-assertion"]);
  assert.ok(!result.open.some((r) => r.text.includes("sk-proj-Abcdefghijklmnop")), "the secret itself is not kept");
  assert.match(handInReturn(result), /Fix each one, or acknowledge it/);
});

test("a finding the seat acknowledges rides up with its reason; the same finding keeps its id across hand-ins", async () => {
  const { dir, check, store } = project(START);
  write(dir, { "test/sum.test.ts": START["test/sum.test.ts"].replace('test("sum"', 'test.skip("sum"') });
  const first = await check();
  assert.deepEqual(
    first.open.map((r) => r.rule),
    ["test-skipped"],
  );
  const id = first.open[0].fingerprint;
  assert.equal((await check()).open[0].fingerprint, id);
  assert.equal(store.acknowledge("seat", id, "the upstream API is down until Friday"), true);
  const second = await check();
  assert.equal(second.state, "clean");
  assert.match(
    handInLine(second) ?? "",
    /acknowledged by the seat: test-skipped test\/sum\.test\.ts:2 \(the upstream API is down/,
  );
});

test("no change is said, a seat the room never saw start is not verified, and neither is clean", async () => {
  const { check } = project(START);
  const empty = await check();
  assert.equal(empty.state, "empty");
  assert.match(handInLine(empty) ?? "", /no change found/);
  const store = new SafetyStore(join(ROOM_HOME, "handin-unknown"), 1000);
  const unknown = await inspectHandIn("nobody", store, {
    place: { home: "/x", project: null, tmp: null, start: null, guard: null, roomFolder: null },
    config: { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  });
  assert.equal(unknown.state, "partial");
  assert.match(handInLine(unknown) ?? "", /not verified/);
});

test("vendored, generated and lock files are not read", async () => {
  const { dir, check } = project(START);
  // ignored folders never reach the diff; a lock file and a minified file do, and are skipped
  write(dir, {
    "node_modules/x/index.js": "debugger;\n",
    "vendor/lib.js": "debugger;\n",
    "package-lock.json": '{"x":"sk-proj-Abcdefghijklmnopqrstuvwx12"}\n',
    "web/app.min.js": "debugger;\n",
  });
  assert.equal((await check()).state, "empty");
});
