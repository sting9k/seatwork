import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Safety } from "../server/safety/index";
import table from "../shared/safety/acceptance.json";

shipSql();

const DAY = 86_400_000;

/** A Safety whose gates are on, with the lines it logs. */
function gated() {
  const logs: string[] = [];
  const safety = new Safety({
    dir: join(ROOM_HOME, "gate-keep"),
    userHome: "/Users/u",
    daemon: "127.0.0.1:6767",
    policy: () => ({ acceptance: { mode: "warn" }, done: { mode: "warn" }, push: { mode: "warn" } }),
    seat: () => null,
    projectOf: () => null,
    isAncestor: () => false,
    tmpOf: (id) => `/tmp/${id}`,
    guard: { paths: [], except: [] },
    roomFolder: ".seatwork",
    decider: null,
    log: (line) => logs.push(line),
  });
  return { store: safety.store(), safety, logs };
}

const accepted = (accepter: string, task: string) => ({
  accepter,
  task,
  writer: "peer",
  repo: "/r",
  base: "a0",
  head: "b1",
  digest: "d",
  commands: ["npm test"],
});

test("an ACCEPT no DONE covers outlives every keep; covered records keep days of their own; open ones past the most go oldest first, said in the log", () => {
  const { store, safety, logs } = gated();
  store.noteAccept(accepted("lead-a", "kept"));
  safety.expireGates(new Date(Date.now() + 10 * DAY));
  assert.deepEqual(
    store.openAccepts("lead-a", 5).map((row) => row.task),
    ["kept"],
    "an open ACCEPT is not dropped by age",
  );

  store.noteAccept(accepted("lead-b", "covered"));
  store.noteDone("lead-b", "/r", "c2");
  store.notePush({ seat: "lead-b", repo: "/r", remote: "origin", ref: "main", sha: "c2", uncovered: 0 });
  safety.expireGates(new Date(Date.now() + (table.keepDays - 1) * DAY));
  assert.deepEqual(store.headsIn("/r", 10).sort(), ["b1", "c2"], "covered records stand within their keep");
  safety.expireGates(new Date(Date.now() + (table.keepDays + 1) * DAY));
  assert.deepEqual(store.headsIn("/r", 10), ["b1"], "past it only the open ACCEPT stands");

  for (let i = 0; i < table.openMost; i += 1) store.noteAccept(accepted("lead-c", `t${i}`));
  safety.expireGates(new Date());
  assert.deepEqual(store.openAccepts("lead-a", 5), [], "the oldest open ACCEPT went first");
  assert.equal(store.openAccepts("lead-c", table.openMost + 1).length, table.openMost);
  assert.match(logs.join("\n"), /1 open ACCEPT\(s\) past the \d+ kept were dropped, oldest first/);
});
