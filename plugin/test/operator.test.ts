import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveSeat, NewSeat } from "../server/host";
import { keepOperator } from "../server/orchestration/operator";

/** An app whose open seats are `providers` by id, keeping every seat it was asked to start. */
function app(providers: Record<string, string>) {
  const started: NewSeat[] = [];
  const host = {
    live: async () =>
      new Map(Object.entries(providers).map(([id, provider]) => [id, { id, provider } as unknown as LiveSeat])),
    create: async (seat: NewSeat) => {
      started.push(seat);
      return `new-${started.length}`;
    },
  };
  return { host, started };
}

const deps = (host: ReturnType<typeof app>["host"], provider: string | null = "claude-hq") => ({
  host,
  provider: () => provider ?? undefined,
  folder: "/room-home/hq-seatwork",
  log: () => {},
});

test("the room's own seat, when none is open, is started once on the provider set up for it, in the room's folder", async () => {
  const gone = app({ "lead-1": "claude-lead" });
  const open = new Set<string>(["hq-old"]);
  const starting = { at: 0 };
  assert.equal(await keepOperator(deps(gone.host), open, starting), "new-1");
  assert.deepEqual(open, new Set(), "a seat the app no longer lists is no operator");
  assert.equal(gone.started[0].provider, "claude-hq");
  assert.equal(gone.started[0].cwd, "/room-home/hq-seatwork");
  assert.match(gone.started[0].title, /^\[HQ\] /);
  assert.equal(await keepOperator(deps(gone.host), open, starting), null, "one start, then a wait");
  assert.equal(gone.started.length, 1);
});

test("an open seat of the room's role is the operator and nothing is started; with no provider set up, nothing is either", async () => {
  const there = app({ "hq-1": "claude-hq", "peer-1": "claude-peer" });
  const open = new Set<string>();
  assert.equal(await keepOperator(deps(there.host), open, { at: 0 }), null);
  assert.deepEqual(open, new Set(["hq-1"]));
  const never = app({});
  assert.equal(await keepOperator(deps(never.host, null), new Set(), { at: 0 }), null);
  assert.equal(never.started.length + there.started.length, 0);
});
