import "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { familyOf, fitSeat, promptVars, type Models } from "../server/orchestration/models";

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
    modes: {},
  };
  const cases: [provider: string, model: string, allowed: boolean][] = [
    ["opencode-peer", "anthropic/claude-x", true],
    ["opencode-peer", "anthropic/other", false],
    ["opencode-peer", "anthropic-anything", false],
    ["codex-peer", "gpt-6", true],
  ];
  for (const [provider, model, allowed] of cases) {
    const fit = fitSeat(table, "peer", provider, model);
    assert.equal(fit.ok && fit.model === undefined, allowed, `${provider}/${model}`);
  }
});

test("a model's family is read from the parts of its id, and from its agent CLI when the id says nothing", () => {
  const cases: [string | null, string, string | null][] = [
    ["claude-opus-5-5", "claude", "anthropic"],
    ["gpt-6.1-sol", "codex", "openai"],
    ["openrouter/google/gemini-2.5-pro", "pi", "google"],
    ["qwen3-coder", "opencode", "alibaba"],
    [null, "codex", "openai"],
    ["local-model", "pi", null],
  ];
  for (const [model, harness, family] of cases)
    assert.equal(familyOf(model, harness), family, `${model} on ${harness}`);
});

test("the models a seat creates from carry the mode each takes, since Paseo refuses a create with none before the room can set one", () => {
  const table: Models = {
    seats: {
      hq: { provider: "claude-hq/opus", thinking: "high" },
      supervisor: { provider: "claude-supervisor/opus", thinking: "high" },
      lead: { provider: "claude-lead/opus", thinking: "high", alternatives: ["codex-lead/sol"] },
    },
    peer: {
      tiers: {
        default: { providers: ["claude-peer/sonnet", "pi-peer/glm"], thinking: "high", use: "work", never: "—" },
      },
    },
    modes: { claude: "bypassPermissions", codex: "full-access", pi: null, opencode: "build" },
  };
  const vars = promptVars(table, { mailChars: 4000 });
  assert.equal(vars.lead_mode, "`bypassPermissions`");
  assert.equal(vars.lead_alternatives, "`codex-lead/sol` (`full-access`)");
  assert.match(vars.peer_table, /`claude-peer\/sonnet` \(`bypassPermissions`\) · `pi-peer\/glm` \(no mode\)/);
});
