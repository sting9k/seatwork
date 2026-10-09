import "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAllowed, promptVars, type Models } from "../server/models";

test("a project's model table matches a model id whole, slashes included", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: { reviewThinking: "high", tiers: { default: { providers: ["opencode-peer/anthropic/claude-x", "codex-peer/gpt-6"], thinking: "medium", use: "", never: "" } } },
    lens: { oracle: "codex-lens/gpt-6", pair: [], pool: [], thinking: "high" },
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

test("the lens table names the lens for a hard question, and lets a model repeat only where the table lists it twice", () => {
  const seat = { provider: "claude-lead/opus", thinking: "high" };
  const table: Models = {
    seats: { hq: seat, supervisor: seat, lead: seat },
    peer: { reviewThinking: "high", tiers: {} },
    lens: { oracle: "codex-lens/sol", hard: "codex-lens/astra", pair: ["codex-lens/sol", "claude-lens/opus"], pool: ["claude-lens/opus"], thinking: "high" },
    modes: {},
  };
  const params = { heartbeatCron: "*/15 * * * *", peerStallMinutes: 6, reviewStallMinutes: 30, leadStallMinutes: 30, readBudgetTokens: 80000, cheapReadBudgetTokens: 40000 };

  const shown = promptVars(table, params).lens_table;
  assert.match(shown, /one lens[^\n]*codex-lens\/sol[^\n]*hard[^\n]*codex-lens\/astra/);
  assert.doesNotMatch(shown, /never the same model twice/, "the table gives a third lens the pair's own model, and the prompt forbids it");
  assert.ok(modelAllowed(table, "lens", "codex-lens", "astra").ok, "the hard-question lens is refused as a model the table does not list");

  const distinct = promptVars({ ...table, lens: { ...table.lens, pool: ["claude-lens/sonnet"] } }, params).lens_table;
  assert.match(distinct, /never the same model twice/);
});
