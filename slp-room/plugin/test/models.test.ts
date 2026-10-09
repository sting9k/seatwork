import "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelAllowed, type Models } from "../server/models";

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
