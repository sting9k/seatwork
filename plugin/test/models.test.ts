import "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAllowed, promptVars, type Models } from "../server/orchestration/models";

test("a project's model table matches a model id whole, slashes included", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: {
      reviewThinking: "high",
      tiers: {
        default: {
          providers: ["opencode-peer/anthropic/claude-x", "codex-peer/gpt-6"],
          thinking: "medium",
          use: "",
          never: "",
        },
      },
    },
    lens: { tiers: {} },
    modes: {},
  };
  const cases: [provider: string, model: string, allowed: boolean][] = [
    ["opencode-peer", "anthropic/claude-x", true],
    ["opencode-peer", "anthropic/other", false],
    ["opencode-peer", "anthropic-anything", false],
    ["codex-peer", "gpt-6", true],
  ];
  for (const [provider, model, allowed] of cases) {
    assert.equal(modelAllowed(table, "peer", provider, model).ok, allowed, `${provider}/${model}`);
  }
});

test("a harness without session modes is one a seat is told to create with no modeId", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: { reviewThinking: "high", tiers: {} },
    lens: { tiers: {} },
    modes: { claude: "bypassPermissions", pi: null, opencode: "build" },
  };
  const params = {
    heartbeatCron: "*/15 * * * *",
    reviewStallMinutes: 30,
    readBudgetTokens: 80000,
    cheapReadBudgetTokens: 40000,
    mailChars: 6000,
    rotateAtTokens: 200000,
  };

  const shown = promptVars(table, params).modes;
  assert.match(shown, /claude `bypassPermissions`, opencode `build`/);
  assert.match(shown, /pi: none, omit `modeId`/);
  assert.doesNotMatch(shown, /null/, "Paseo refuses any mode it is handed for a harness that has none");
});
