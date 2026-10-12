import "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAllowed, promptVars, type Models } from "../server/models";

test("a project's model table matches a model id whole, slashes included", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: { reviewThinking: "high", tiers: { default: { providers: ["opencode-peer/anthropic/claude-x", "codex-peer/gpt-6"], thinking: "medium", use: "", never: "" } } },
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

test("the Lead is shown the lenses as one role's models with what each is for, and two lenses are two different models", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const tier = (provider: string, use: string) => ({ providers: [provider], thinking: "high", use, never: "—" });
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: { reviewThinking: "high", tiers: {} },
    lens: { tiers: { default: tier("codex-lens/sol", "one lens"), high: tier("codex-lens/astra", "a hard question") } },
    modes: {},
  };
  const params = { heartbeatCron: "*/15 * * * *", peerStallMinutes: 6, reviewStallMinutes: 30, leadStallMinutes: 30, readBudgetTokens: 80000, cheapReadBudgetTokens: 40000 };

  const shown = promptVars(table, params).lens_table;
  assert.match(shown, /\| default \| `codex-lens\/sol` \| high \| one lens \|/);
  assert.match(shown, /\| high \| `codex-lens\/astra` \| high \| a hard question \|/);
  assert.match(shown, /Two lenses are two different models, always/);
  assert.ok(modelAllowed(table, "lens", "codex-lens", "astra").ok, "a lens model the table lists is refused");

  // a table with one lens model cannot seat two different ones
  const single = promptVars({ ...table, lens: { tiers: { default: table.lens.tiers.default } } }, params).lens_table;
  assert.match(single, /one lens model: open one lens/);
  assert.doesNotMatch(single, /two different models/);
});

test("a harness without session modes is one a seat is told to create with no modeId", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: { reviewThinking: "high", tiers: {} },
    lens: { tiers: {} },
    modes: { claude: "bypassPermissions", pi: null, opencode: "build" },
  };
  const params = { heartbeatCron: "*/15 * * * *", peerStallMinutes: 6, reviewStallMinutes: 30, leadStallMinutes: 30, readBudgetTokens: 80000, cheapReadBudgetTokens: 40000 };

  const shown = promptVars(table, params).modes;
  assert.match(shown, /claude `bypassPermissions`, opencode `build`/);
  assert.match(shown, /pi: none, omit `modeId`/);
  assert.doesNotMatch(shown, /null/, "Paseo refuses any mode it is handed for a harness that has none");
});
