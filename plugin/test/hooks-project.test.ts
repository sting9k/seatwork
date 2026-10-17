import assert from "node:assert/strict";
import { test } from "node:test";
import limits from "../shared/host.json";
import { pluginRoom } from "./support/plugin";

const { call } = pluginRoom(["claude-hq"]);

const settled = () => new Promise((done) => setImmediate(done));

test("the room's own project that could not be opened is tried again only after a growing wait, and once it is open it is left alone", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const opened: string[] = [];
  let lists = 0;
  const context = {
    paseo: {
      workspaces: {
        list: async () => {
          lists += 1;
          if (lists <= 2) throw new Error("the daemon is not ready");
          return { entries: [] };
        },
        open: async ({ cwd }: { cwd: string }) => void opened.push(cwd),
      },
    },
  };
  const hook = async () => {
    await call("on agent.permission_resolved", { agent: { id: "a", provider: "claude-hq" } }, context);
    await settled();
  };
  const first = limits.projectRetryFirstSeconds * 1000;

  await hook();
  assert.deepEqual([lists, opened.length], [1, 0], "the first try failed");
  await hook();
  assert.equal(lists, 1, "the very next hook does not try again");
  t.mock.timers.tick(first);
  await hook();
  assert.equal(lists, 2, "a hook after the wait tries again, and fails");
  t.mock.timers.tick(first);
  await hook();
  assert.equal(lists, 2, "the wait has grown");
  t.mock.timers.tick(first);
  await hook();
  assert.deepEqual([lists, opened.length], [3, 1], "a hook after the longer wait opened it");
  t.mock.timers.tick(limits.projectRetryMostSeconds * 1000);
  await hook();
  assert.deepEqual([lists, opened.length], [3, 1], "an open project is not asked for again");
});
