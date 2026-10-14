import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TaskKeys } from "../server/orchestration/task-keys";

const file = (name: string) => join(ROOM_HOME, `task-keys-${name}.json`);

test("a seat's task is the issue it claimed first and stays when that issue is closed; a claim of another issue moves it", () => {
  const keys = new TaskKeys(file("moves"));
  assert.equal(keys.of("peer-1", []), "peer-1", "no issue ever: the key is the seat's own id");
  assert.equal(keys.of("peer-1", ["sw-a"]), "sw-a");
  assert.equal(keys.of("peer-1", ["sw-b", "sw-a"]), "sw-a", "the issue it claimed first stays while it is held");
  assert.equal(keys.of("peer-1", []), "sw-a", "the issue was closed in the seat's turn: the key stays");
  assert.equal(keys.of("peer-1", ["sw-c"]), "sw-c", "a claim of another issue moves the key to it");
  assert.equal(keys.of("peer-1", []), "sw-c");
  assert.equal(new TaskKeys(file("moves")).of("peer-1", []), "sw-c", "the key outlives a restart");
});

test("a successor takes its predecessor's key, whether an issue or the first seat of the chain, and may read the seats before it", () => {
  const keys = new TaskKeys(file("chain"));
  keys.succeed("lead-0", "lead-1");
  keys.succeed("lead-1", "lead-2");
  assert.equal(keys.of("lead-2", []), "lead-0", "with no issue ever, the key is the first seat of the chain");
  assert.deepEqual(keys.before("lead-2"), ["lead-0", "lead-1"]);
  assert.deepEqual(keys.before("lead-0"), []);

  keys.of("peer-0", ["sw-k"]);
  keys.succeed("peer-0", "peer-1");
  assert.equal(keys.of("peer-1", []), "sw-k");
  assert.equal(keys.of("peer-1", ["sw-k"]), "sw-k");
  assert.equal(new TaskKeys(file("chain")).of("lead-2", []), "lead-0");
});

test("the chain a seat may read is bounded, the oldest seat leaving first", () => {
  const keys = new TaskKeys(file("long"));
  for (let i = 0; i < 40; i += 1) keys.succeed(`seat-${i}`, `seat-${i + 1}`);
  const before = keys.before("seat-40");
  assert.ok(before.length <= 20, `${before.length} predecessors are kept`);
  assert.equal(before.at(-1), "seat-39");
});

test("a seat that is gone takes its key with it; the rounds of a key go only when no other seat holds it", () => {
  const keys = new TaskKeys(file("gone"));
  keys.succeed("lead-0", "lead-1");
  assert.equal(keys.forget("lead-0"), null, "the successor continues the key lead-0");
  assert.equal(keys.forget("lead-1"), "lead-0", "the last seat of a key that was no issue takes its rounds with it");
  assert.equal(keys.forget("plain"), "plain", "a seat with no entry: its own id");
  keys.of("peer-0", ["sw-k"]);
  assert.equal(keys.forget("peer-0"), null, "the rounds of an issue are the issue's");
  assert.equal(new TaskKeys(file("gone")).of("lead-1", []), "lead-1", "the forgotten seat is not read back");
});

test("seats the room no longer knows lose their key, and a file that cannot be read starts the keys empty", () => {
  const path = file("expire");
  const keys = new TaskKeys(path);
  keys.of("peer-live", ["sw-1"]);
  keys.of("peer-lost", ["sw-2"]);
  assert.equal(
    keys.expire((seat) => seat === "peer-live"),
    1,
  );
  assert.equal(
    keys.expire((seat) => seat === "peer-live"),
    0,
  );
  assert.equal(new TaskKeys(path).of("peer-lost", []), "peer-lost");
  assert.equal(new TaskKeys(path).of("peer-live", []), "sw-1");

  writeFileSync(path, '{"peer-live": {"key": 7}, "bad": [], "ok": {"key": "sw-9", "issue": true, "before": []}}');
  const damaged = new TaskKeys(path);
  assert.equal(damaged.of("peer-live", []), "peer-live", "an entry of the wrong shape is not a key");
  assert.equal(damaged.of("ok", []), "sw-9");
  writeFileSync(path, "{not json");
  assert.equal(new TaskKeys(path).of("peer-live", []), "peer-live");
});
