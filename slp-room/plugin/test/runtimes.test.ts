import { USER_CODEX } from "./support/room";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CodexRuntimePolicy, RuntimePolicy } from "../server/policy";
import { ensureRuntime, runtimeDir } from "../server/runtimes";

const seat = { harness: "codex", role: "peer" } as const;
const userConfig = join(USER_CODEX, "config.toml");
const seatConfig = join(runtimeDir(seat), "config.toml");

function policyWith(over: Partial<CodexRuntimePolicy> = {}): RuntimePolicy {
  const codex: CodexRuntimePolicy = {
    shareFiles: [],
    shareSkills: [],
    sharePlugins: false,
    shareHooks: false,
    stripTables: ["mcp_servers", "hooks"],
    stripKeys: ["notify"],
    featuresOff: ["multi_agent"],
    multiAgentV2Off: false,
    agentsOff: false,
    ...over,
  };
  return { codex } as RuntimePolicy;
}

/** The config.toml a new Codex seat gets when the user's own config is `user`. */
function seatConfigFor(user: string, policy = policyWith()): string {
  rmSync(runtimeDir(seat), { recursive: true, force: true });
  writeFileSync(userConfig, user);
  ensureRuntime(seat, policy);
  return readFileSync(seatConfig, "utf8");
}

const OFF = "[features]\nmulti_agent = false\n";

const cases: { name: string; user: string; seat: string; policy?: Partial<CodexRuntimePolicy> }[] = [
  {
    name: "an array table ends the stripped table before it",
    user: '[mcp_servers.x]\ncommand = "a"\n[[profiles]]\nname = "keep"\n[other]\nk = 1\n',
    seat: `[[profiles]]\nname = "keep"\n\n[other]\nk = 1\n\n${OFF}`,
  },
  {
    name: "an array table under a stripped name is stripped",
    user: 'model = "m"\n[[hooks.PreToolUse]]\ncommand = "x"\n',
    seat: `model = "m"\n\n${OFF}`,
  },
  {
    name: "a flag is switched off in [features], not in the array table after it",
    user: '[features]\nmulti_agent = true\nweb = true\n[[x]]\nmulti_agent = "mine"\n',
    seat: '[features]\nmulti_agent = false\nweb = true\n\n[[x]]\nmulti_agent = "mine"\n',
  },
  {
    name: "a stripped table written with dotted keys or inline is stripped",
    user: 'mcp_servers.github.command = "gh"\nhooks = { Stop = [{ command = "x" }] }\nmodel = "m"\n',
    seat: `model = "m"\n\n${OFF}`,
  },
  {
    name: "a header with a trailing comment is still a header",
    user: '[mcp_servers.x] # work\ncommand = "a"\n[keep] # mine\nk = 1\n',
    seat: `[keep]\nk = 1\n\n${OFF}`,
  },
  {
    name: "a stripped key goes at the top only, however many lines it takes",
    user: 'notify = [\n  "say",\n  "done",\n]\nmodel = "m"\n[[x]]\nnotify = "kept"\n',
    seat: `model = "m"\n\n[[x]]\nnotify = "kept"\n\n${OFF}`,
  },
  {
    name: "every other value is kept as written",
    user: 'banner = """\n[not a table]\n# not a comment\n"""\nargs = [\n  ["a", "b"],  # nested\n  "c",\n]\nwhen = 1979-05-27 07:32:00Z\npath = \'C:\\dir\'\n',
    seat: `banner = """\n[not a table]\n# not a comment\n"""\nargs = [\n  ["a", "b"],  # nested\n  "c",\n]\nwhen = 1979-05-27 07:32:00Z\npath = 'C:\\dir'\n\n${OFF}`,
  },
  {
    name: "an inline features table is switched off like any other",
    user: "features = { multi_agent = true, web = true }\n",
    seat: "[features]\nmulti_agent = false\nweb = true\n",
  },
  {
    name: "multi_agent_v2 written as a table is disabled in place",
    user: "[features.multi_agent_v2]\nenabled = true\nmax = 4\n",
    seat: "[features]\nmulti_agent = false\n\n[features.multi_agent_v2]\nenabled = false\nmax = 4\n",
    policy: { multiAgentV2Off: true },
  },
  {
    name: "with no config of the user's, the seat gets only the switches",
    user: "",
    seat: "[agents]\nenabled = false\n\n[features]\nmulti_agent = false\nmulti_agent_v2 = false\n",
    policy: { multiAgentV2Off: true, agentsOff: true },
  },
];

for (const { name, user, seat: expected, policy } of cases) {
  test(`Codex seat config: ${name}`, () => {
    assert.equal(seatConfigFor(user, policyWith(policy)), expected);
  });
}

test("a user config that is not TOML refuses the runtime and names the file", () => {
  assert.throws(() => seatConfigFor('model = "unclosed\n'), (error: Error) => error.message.includes(userConfig));
});

test("a Codex runtime is rebuilt when the policy changes", () => {
  seatConfigFor('model = "m"\n');
  ensureRuntime(seat, policyWith({ featuresOff: ["multi_agent", "apps"] }));
  assert.match(readFileSync(seatConfig, "utf8"), /^apps = false$/m);
});

test("a Codex runtime is rebuilt when the user's config.toml changes", () => {
  seatConfigFor('model = "old"\n');
  writeFileSync(userConfig, 'model = "new"\n');
  ensureRuntime(seat, policyWith());
  assert.match(readFileSync(seatConfig, "utf8"), /^model = "new"$/m);
});

test("a Codex runtime is left alone when neither the policy nor the user's config changed", () => {
  seatConfigFor('model = "m"\n');
  writeFileSync(seatConfig, "# untouched\n");
  ensureRuntime(seat, policyWith());
  assert.equal(readFileSync(seatConfig, "utf8"), "# untouched\n");
});
