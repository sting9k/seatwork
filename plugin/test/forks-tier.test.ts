import { installRoom, PROJECT } from "./support/room";
import { forksWith, modelSaying } from "./forks-support";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { SeatRecord } from "../server/coordination/engine";
import type { Host } from "../server/host";
import { pickModel, stepUp, type Models } from "../server/orchestration/models";
import { parseHandoff, rotate } from "../server/orchestration/rotation";
import { fitAt, stepUpAt } from "../server/room/launch";

before(() => installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "codex-peer"]));

const seat = { provider: "claude-lead/opus", thinking: "high" };
const tier = (providers: string[], use: string | null) => ({ providers, thinking: "high", use, never: "—" });
const TABLE = {
  seats: { hq: seat, supervisor: seat, lead: seat },
  peer: {
    reviewThinking: "high",
    tiers: {
      cheap: tier(["claude-peer/haiku"], "mechanical, fully specified work"),
      default: tier(["claude-peer/sonnet", "pi-peer/mini"], "implementation and debugging"),
      deep: tier(["claude-peer/opus", "pi-peer/maxi"], "hard design"),
      other: tier(["codex-peer/astra"], "a second family"),
    },
  },
  modes: {},
} as unknown as Models;

test("the tier above is the next one the provider lists, in the table's order", () => {
  assert.equal(stepUp(TABLE, "peer", "claude-peer", "haiku"), "sonnet");
  assert.equal(stepUp(TABLE, "peer", "claude-peer", "sonnet-20261001"), "opus", "a dated id is its model");
  assert.equal(stepUp(TABLE, "peer", "claude-peer", "opus"), undefined, "no tier above the last");
  assert.equal(stepUp(TABLE, "peer", "pi-peer", "mini"), "maxi", "another provider climbs its own tiers");
  assert.equal(stepUp(TABLE, "peer", "codex-peer", "astra"), undefined, "one tier of its own has none above");
  assert.equal(stepUp(TABLE, "peer", "claude-peer", "unlisted"), undefined);
  assert.equal(stepUp(TABLE, "lead", "claude-lead", "opus"), undefined, "a role of one model has no tiers");
});

test("the decision model picks the tier it is sure fits the work; a split answer, an off fork, one tier or no task keep the table's first", async () => {
  const task = { title: "[Peer:fe] rename the label in the footer", brief: "Change the word Contact to Help." };
  const sure = modelSaying("cheap");
  const { forks } = forksWith(sure.router, ["tier"]);
  assert.equal(await pickModel(forks, TABLE, "peer", "claude-peer", task), "haiku");
  const [call] = sure.asked;
  assert.equal(call.caller, "forks.tier@1");
  assert.deepEqual(call.labels, ["cheap", "default", "deep"], "the tiers this provider lists, nothing else");
  assert.deepEqual(call.state, { title: task.title, brief: task.brief });

  const split = modelSaying("deep", 0.6);
  assert.equal(await pickModel(forksWith(split.router, ["tier"]).forks, TABLE, "peer", "claude-peer", task), undefined);
  const off = modelSaying("cheap");
  assert.equal(await pickModel(forksWith(off.router, []).forks, TABLE, "peer", "claude-peer", task), undefined);
  assert.equal(off.asked.length, 0, "a fork the policy keeps off is never asked");

  const one = modelSaying("default");
  const alone = forksWith(one.router, ["tier"]).forks;
  assert.equal(await pickModel(alone, TABLE, "peer", "codex-peer", task), undefined, "one tier on this provider");
  assert.equal(await pickModel(alone, TABLE, "peer", "claude-peer", {}), undefined, "nothing to read");
  assert.equal(await pickModel(alone, TABLE, "lead", "claude-lead", task), undefined, "a role of one model");
  assert.equal(one.asked.length, 0);
});

test("a task sent back twice starts its successor a tier up where the table lists one; once is not enough", async () => {
  assert.equal(stepUpAt(PROJECT, "peer", "claude-peer", "claude-haiku-5-5"), "claude-sonnet-5-5");
  assert.equal(stepUpAt(PROJECT, "peer", "claude-peer", "claude-sonnet-5-5"), "claude-opus-5-5");
  assert.equal(stepUpAt(PROJECT, "peer", "claude-peer", "claude-opus-5-5"), undefined);

  const made: { model?: string }[] = [];
  const old: SeatRecord = {
    agentId: "peer-old",
    parentAgentId: "lead-1",
    role: "peer",
    provider: "claude-peer",
    title: "[Peer] store",
  };
  const on = (model: string) => ({
    host: {
      seat: async () => ({ cwd: PROJECT, model, thinking: "high" }),
      prompts: async () => ["Brief: build the store."],
      create: async (input: { model?: string }) => {
        made.push(input);
        return "peer-new";
      },
      archive: async () => {},
    } as unknown as Host,
    engine: {
      parentOf: () => "lead-1",
      rememberSeat: () => {},
      allSeats: () => [],
      move: async () => {},
      threadsFor: () => [],
    } as never,
    version: "test",
    fit: fitAt,
    up: stepUpAt,
    handOver: () => {},
  });
  const handoff = parseHandoff("HANDOFF\nCURRENT TASK: the store\nPROGRESS: half\nBLOCKERS: none")!;

  const sameTier = await rotate(on("claude-haiku-5-5"), old, handoff, [], 1);
  const higher = await rotate(on("claude-haiku-5-5"), old, handoff, [], 2);
  const top = await rotate(on("claude-opus-5-5"), old, handoff, [], 3);
  assert.deepEqual(
    [sameTier, higher, top].map((one) => [one.model, one.raised]),
    [
      ["claude-haiku-5-5", false],
      ["claude-sonnet-5-5", true],
      ["claude-opus-5-5", false],
    ],
  );
  assert.deepEqual(
    made.map((input) => input.model),
    ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  );
});
