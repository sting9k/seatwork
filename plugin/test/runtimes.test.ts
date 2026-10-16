import { installRoom, USER_CODEX, USER_HOME, USER_PI } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy, type CodexRuntimePolicy, type RuntimePolicy } from "../server/policy";
import {
  claudeRoleDir,
  ensureRuntime,
  roleSkillNames,
  runtimeDir,
  skillsLoaded,
} from "../server/orchestration/runtimes";
import { parseToml, type TomlTable } from "../server/toml";
import { addSkill, listSkills, removeSkill } from "../server/orchestration/local-skills";
import { LOCAL_SKILLS_DIR } from "../server/paths";

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
  // the guard's hook is laid in by its own test below; these read the stripping alone
  return { codex, safety: { mode: "off" } } as RuntimePolicy;
}

/** The config.toml a new Codex seat gets when the user's own config is `user`. */
function seatConfigFor(user: string, policy = policyWith()): string {
  rmSync(runtimeDir(seat), { recursive: true, force: true });
  writeFileSync(userConfig, user);
  ensureRuntime(seat, policy);
  return readFileSync(seatConfig, "utf8");
}

const OFF = "[features]\nmulti_agent = false\n";
const BUNDLED_OFF = "\n[skills]\n\n[skills.bundled]\nenabled = false\n";

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
    name: "the user's own skills table gives way to the room's",
    user: '[skills]\ninclude_instructions = false\n[[skills.config]]\nname = "x"\nenabled = true\n',
    seat: OFF,
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
    assert.equal(seatConfigFor(user, policyWith(policy)), expected + BUNDLED_OFF);
  });
}

test("a user config that is not TOML refuses the runtime and names the file", () => {
  assert.throws(
    () => seatConfigFor('model = "unclosed\n'),
    (error: Error) => error.message.includes(userConfig),
  );
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

test("a Pi seat's home takes the user's settings without their packages, extensions and skills", () => {
  installRoom(["pi-peer"]);
  const pi = { harness: "pi", role: "peer" } as const;
  writeFileSync(
    join(USER_PI, "settings.json"),
    JSON.stringify({ theme: "dark", packages: ["npm:pi-mcp-adapter", "npm:mine"], extensions: ["-builtin:mcp"] }),
  );

  ensureRuntime(pi, loadPolicy());

  // nothing of the user's may stand in for Pi's own MCP: that is where Paseo puts the room's servers
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir(pi), "settings.json"), "utf8")), {
    theme: "dark",
    packages: [],
    extensions: [],
    skills: [`!${join(USER_HOME, ".agents", "skills")}/**`],
  });
});

test("a Claude seat's skill folder holds the role's skills as they are named now: a link to a skill that is gone is dropped", () => {
  ensureRuntime({ harness: "claude", role: "peer" }, loadPolicy());
  const skills = join(claudeRoleDir("peer"), ".claude", "skills");
  symlinkSync(join(skills, "..", "no-such-skill"), join(skills, "seatwork-hard-cut"));
  ensureRuntime({ harness: "claude", role: "peer" }, loadPolicy());
  assert.deepEqual(readdirSync(skills).sort(), roleSkillNames("peer"));
  assert.ok(existsSync(join(skills, "test-audit", "SKILL.md")));
});

test("a skill several roles share is given to each role the room's map names, and to no other", () => {
  for (const role of ["lead", "peer"]) ensureRuntime({ harness: "claude", role }, loadPolicy());
  const skills = (role: string) => readdirSync(join(claudeRoleDir(role), ".claude", "skills")).sort();
  assert.deepEqual(skills("lead"), ["lenses", "seat-law"]);
  assert.ok(existsSync(join(claudeRoleDir("lead"), ".claude", "skills", "seat-law", "SKILL.md")));
  assert.ok(!skills("peer").includes("seat-law"));
});

test("a seat's home holds the guard's hook when the guard is on: Codex's hooks.json with its trust, Pi's extension, OpenCode's plugin", () => {
  const homes = (mode: "on" | "off") => {
    const policy = {
      ...policyWith(),
      pi: { shareFiles: [], shareDirs: [], settings: { extensions: [], packages: [] } },
      opencode: { shareEntries: [], config: {} },
      safety: { mode },
    } as RuntimePolicy;
    for (const harness of ["codex", "pi", "opencode"] as const) {
      rmSync(runtimeDir({ harness, role: "lead" }), { recursive: true, force: true });
      ensureRuntime({ harness, role: "lead" }, policy);
    }
    return {
      codexHooks: join(runtimeDir({ harness: "codex", role: "lead" }), "hooks.json"),
      codexConfig: readFileSync(join(runtimeDir({ harness: "codex", role: "lead" }), "config.toml"), "utf8"),
      pi: join(runtimeDir({ harness: "pi", role: "lead" }), "extensions", "room-guard.ts"),
      opencode: join(runtimeDir({ harness: "opencode", role: "lead" }), "plugins", "room-guard.ts"),
    };
  };
  writeFileSync(userConfig, "");
  const on = homes("on");
  const [hook] = JSON.parse(readFileSync(on.codexHooks, "utf8")).hooks.PreToolUse;
  assert.equal(hook.matcher, "^(Bash|apply_patch)$");
  assert.match(hook.hooks[0].command, /^\/bin\/sh -c '[\s\S]+' room-guard codex$/);
  assert.match(
    on.codexConfig,
    new RegExp(
      `\\[hooks\\.state\\."${on.codexHooks.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:pre_tool_use:0:0"\\]\\ntrusted_hash = "sha256:[0-9a-f]{64}"`,
    ),
  );
  assert.ok(existsSync(on.pi) && existsSync(on.opencode));
  const off = homes("off");
  assert.ok(!existsSync(off.codexHooks) && !existsSync(off.pi) && !existsSync(off.opencode));
  assert.doesNotMatch(off.codexConfig, /hooks\.state/);
});

test("a Codex, Pi or OpenCode seat is shown the room's skills only: the user's own, nested ones too, and Codex's bundled ones are off", () => {
  installRoom(["codex-peer", "pi-peer", "opencode-peer"]);
  const mine = join(USER_HOME, ".agents", "skills");
  const home = (harness: "codex" | "pi" | "opencode") => runtimeDir({ harness, role: "peer" });
  const build = () => {
    for (const harness of ["codex", "pi", "opencode"] as const) ensureRuntime({ harness, role: "peer" }, loadPolicy());
  };
  const codexSkills = () =>
    parseToml(readFileSync(join(home("codex"), "config.toml"), "utf8")).get("skills") as TomlTable;
  writeFileSync(userConfig, "");
  try {
    build();
    assert.equal(codexSkills().get("config"), undefined);

    // a skill the user adds after the home was built reaches the next seat's config
    for (const dir of ["mine", "group/deep"]) {
      mkdirSync(join(mine, dir), { recursive: true });
      writeFileSync(join(mine, dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
    }
    build();

    assert.deepEqual((codexSkills().get("bundled") as TomlTable).get("enabled"), "false");
    assert.deepEqual(
      (codexSkills().get("config") as TomlTable[]).map((entry) => [entry.get("path"), entry.get("enabled")]),
      [
        [JSON.stringify(join(mine, "group", "deep", "SKILL.md")), "false"],
        [JSON.stringify(join(mine, "mine", "SKILL.md")), "false"],
      ],
    );
    assert.deepEqual(JSON.parse(readFileSync(join(home("pi"), "settings.json"), "utf8")).skills, [`!${mine}/**`]);
    assert.deepEqual(JSON.parse(readFileSync(join(home("opencode"), "opencode.json"), "utf8")).permission, {
      task: "deny",
      skill: { "*": "deny", "blast-radius": "allow", "test-audit": "allow" },
    });
  } finally {
    rmSync(join(USER_HOME, ".agents"), { recursive: true, force: true });
  }
});

test("a skill the room's seat adds reaches its role's seats and no other's, keeps its source, and leaves by being set aside", () => {
  installRoom(["claude-peer", "claude-lead"]);
  const base = {
    role: "peer",
    name: "flaky-retry",
    files: {
      "SKILL.md": "---\nname: flaky-retry\ndescription: A test that passes only on a retry.\n---\nFind the race.\n",
      "references/notes.md": "Notes.\n",
    },
    source: { license: "own" },
    why: "Peers retried a flaky test three times in one task",
    by: "hq-1",
  };
  assert.deepEqual(addSkill(base), { added: "peer/flaky-retry", files: ["SKILL.md", "references/notes.md"] });
  for (const role of ["peer", "lead"]) ensureRuntime({ harness: "claude", role }, loadPolicy());
  const link = join(claudeRoleDir("peer"), ".claude", "skills", "flaky-retry");
  assert.ok(existsSync(join(link, "SKILL.md")));
  assert.ok(roleSkillNames("peer").includes("flaky-retry") && !roleSkillNames("lead").includes("flaky-retry"));

  const refused = (over: Record<string, unknown>, why: RegExp) =>
    assert.throws(() => addSkill({ ...base, ...over }), why);
  refused({ name: "test-audit" }, /the room ships a skill named test-audit/);
  refused({ files: { ...base.files, "run.sh": "rm -rf ~" } }, /run\.sh: a skill holds \.md and \.txt files/);
  refused({ files: { "SKILL.md": "Find the race." } }, /opens with front matter/);
  refused({ files: { "SKILL.md": "---\nname: flaky-retry\ndescription: Tìm chỗ tranh chấp.\n---\n" } }, /in English/);
  refused({ source: { license: "MIT" } }, /names source\.repo and source\.commit/);
  refused({ role: "boss" }, /no role boss/);

  writeFileSync(join(LOCAL_SKILLS_DIR, "peer", "flaky-retry", "SKILL.md"), "changed by hand");
  assert.deepEqual(
    listSkills().map(({ skill, intact, source, by }) => [skill, intact, source.license, by]),
    [["peer/flaky-retry", false, "own", "hq-1"]],
  );
  removeSkill("peer", "flaky-retry");
  ensureRuntime({ harness: "claude", role: "peer" }, loadPolicy());
  assert.ok(!existsSync(link));
  assert.deepEqual(listSkills(), []);
  assert.equal(readdirSync(join(LOCAL_SKILLS_DIR, "removed")).length, 1);
});

test("a turn's skill loads are read each agent CLI's way: Claude's and OpenCode's skill tools, a SKILL.md Codex reads in a shell or Pi reads", () => {
  const done = "completed" as const;
  assert.deepEqual(
    skillsLoaded([
      { kind: "tool", name: "Skill", label: "test-audit", status: done },
      { kind: "tool", name: "skill", label: "lenses", status: done },
      {
        kind: "shell",
        command: "sed -n 1,80p /h/runtimes/codex/peer/skills/blast-radius/SKILL.md",
        exitCode: 0,
        output: "",
        status: done,
      },
      { kind: "read", path: "/h/runtimes/pi/lead/skills/seat-law/SKILL.md" },
      { kind: "read", path: "/repo/src/SKILL.mdx" },
      { kind: "tool", name: "Read", label: "SKILL.md", status: done },
    ]),
    ["blast-radius", "lenses", "seat-law", "test-audit"],
  );
});
