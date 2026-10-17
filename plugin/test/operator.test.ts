import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveSeat, NewSeat } from "../server/host";
import type { SeatFit } from "../server/orchestration/models";
import { keepOperator, operatorState } from "../server/orchestration/operator";

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
  fit: (cwd: string, role: string, on: string, model: string | undefined): SeatFit =>
    cwd === "/room-home/hq-seatwork" && role === "hq" && on === "claude-hq" && model === undefined
      ? { ok: true, model: "claude-opus-5-5", thinking: "high" }
      : { ok: false, listed: [] },
  folder: "/room-home/hq-seatwork",
  log: () => {},
});

test("the room's own seat, when none is open, is started once on the provider set up for it and the model and thinking its table gives, in the room's folder", async () => {
  const gone = app({ "lead-1": "claude-lead" });
  const open = new Set<string>(["hq-old"]);
  const starting = { at: 0, failed: null };
  assert.equal(await keepOperator(deps(gone.host), open, starting), "new-1");
  assert.deepEqual(open, new Set(), "a seat the app no longer lists is no operator");
  assert.deepEqual(
    [gone.started[0].provider, gone.started[0].model, gone.started[0].thinking],
    ["claude-hq", "claude-opus-5-5", "high"],
    "the app refuses a start that names no model",
  );
  assert.equal(gone.started[0].cwd, "/room-home/hq-seatwork");
  assert.match(gone.started[0].title, /^\[HQ\] /);
  assert.equal(await keepOperator(deps(gone.host), open, starting), null, "one start, then a wait");
  assert.equal(gone.started.length, 1);
});

test("an open seat of the room's role is the operator and nothing is started; with no provider set up, nothing is either", async () => {
  const there = app({ "hq-1": "claude-hq", "peer-1": "claude-peer" });
  const open = new Set<string>();
  assert.equal(await keepOperator(deps(there.host), open, { at: 0, failed: null }), null);
  assert.deepEqual(open, new Set(["hq-1"]));
  const never = app({});
  assert.equal(await keepOperator(deps(never.host, null), new Set(), { at: 0, failed: null }), null);
  assert.equal(never.started.length + there.started.length, 0);
});

test("a start of the room's own seat that fails is said on the person's screen with its reason, until a seat is open", async () => {
  const refused = app({});
  refused.host.create = async () => {
    throw new Error("agent_create_failed: the provider claude-hq is not available");
  };
  const starting = { at: 0, failed: null };
  await assert.rejects(keepOperator(deps(refused.host), new Set(), starting));
  const said = await operatorState(deps(refused.host), starting);
  assert.equal(said?.ok, false);
  assert.match(said?.detail ?? "", /could not start it: agent_create_failed/);
  await keepOperator(deps(app({ "hq-2": "claude-hq" }).host), new Set(), starting);
  assert.equal(starting.failed, null, "an open seat clears the failure");
});
