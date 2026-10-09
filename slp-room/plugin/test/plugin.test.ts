import { installRoom, PROJECT, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";

type Hook = (input: never, context: never) => unknown;

const hooks = new Map<string, Hook>();
const server = {
  before: (name: string, hook: Hook) => void hooks.set(`before ${name}`, hook),
  on: (name: string, hook: Hook) => void hooks.set(`on ${name}`, hook),
};
const call = (name: string, input: unknown, context: unknown = {}) => hooks.get(name)!(input as never, context as never);

const runtimes = join(ROOM_HOME, "runtimes");
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-lead", "pi-peer"]);
  chmodSync(ROOM_HOME, 0o755); // as a room home made under the usual umask
  mkdirSync(runtimes);
  writeFileSync(join(runtimes, "pi"), ""); // no Pi runtime can be built while this file is in the way
  console.log = console.error = () => {};
  dispose = contribute(server as never);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

function createRequest(provider: string) {
  return { request: { config: { provider, cwd: PROJECT, title: "[Peer] task" }, env: {} } };
}

test("the plugin makes the room home private to its owner", () => {
  assert.equal(statSync(ROOM_HOME).mode & 0o077, 0);
});

test("a seat whose runtime cannot be built is refused, and created on its own home once it can", async () => {
  await assert.rejects(async () => call("before agent.create", createRequest("pi-peer")), /pi-peer/);

  rmSync(join(runtimes, "pi"));
  const created = (await call("before agent.create", createRequest("pi-peer"))) as { env: Record<string, string> };
  assert.equal(created.env.PI_CODING_AGENT_DIR, join(runtimes, "pi", "peer"));
  assert.ok(existsSync(join(created.env.PI_CODING_AGENT_DIR, "settings.json")));
});

// the daemon's agents; the plugin keeps the first Paseo client a hook hands it
const agents: Record<string, object> = {};
const context = { paseo: { agents: { ref: (id: string) => agents[id] } } };

for (const archive of ["works", "fails"] as const) {
  test(`a seat created outside the spawn rules: its creator is told what happened when the archive ${archive}`, async () => {
    const parent = `lead-${archive}`;
    const child = `second-lead-${archive}`;
    const toParent: string[] = [];
    agents[parent] = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async (text: string) => void toParent.push(text) };
    agents[child] = {
      archive: async () => {
        if (archive === "fails") throw new Error("daemon busy");
      },
    };
    const created = (id: string, parentAgentId: string | null) => ({ agent: { id, parentAgentId, provider: "claude-lead", cwd: PROJECT, title: "[Lead] stream", workspaceId: null } });

    await call("on agent.created", created(parent, null), context);
    await call("on agent.created", created(child, parent), context); // a Lead may not create a Lead

    assert.equal(toParent.length, 1);
    const [notice] = toParent;
    assert.match(notice, /SPAWN REFUSED/);
    if (archive === "works") {
      assert.match(notice, /The room archived it/);
      assert.match(notice, /may have started/); // Paseo sends the first prompt without waiting for this hook
    } else {
      assert.match(notice, /could not archive it/);
      assert.match(notice, /daemon busy/);
      assert.doesNotMatch(notice, /The room archived it/);
    }
  });
}
