import { installRoom } from "./support/room";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";

const paseoSide = fakeServer();
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-hq"]);
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

const settled = () => new Promise((done) => setImmediate(done));

test("the room's own project that could not be opened is tried again at the next hook, and once it is open it is left alone", async () => {
  const opened: string[] = [];
  let lists = 0;
  const context = {
    paseo: {
      workspaces: {
        list: async () => {
          lists += 1;
          if (lists === 1) throw new Error("the daemon is not ready");
          return { entries: [] };
        },
        open: async ({ cwd }: { cwd: string }) => void opened.push(cwd),
      },
    },
  };
  const hook = async () => {
    await paseoSide.call("on agent.permission_resolved", { agent: { id: "a", provider: "claude-hq" } }, context);
    await settled();
  };

  await hook();
  assert.deepEqual([lists, opened.length], [1, 0], "the first try failed");
  await hook();
  assert.deepEqual([lists, opened.length], [2, 1], "the next hook opened it");
  await hook();
  assert.deepEqual([lists, opened.length], [2, 1], "an open project is not asked for again");
});
