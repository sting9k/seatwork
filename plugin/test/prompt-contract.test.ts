import { installRoom, PROJECT, ROOM_HOME, USER_HOME } from "./support/room";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOME } from "../server/paths";
import { runtimeDir } from "../server/orchestration/runtimes";
import { refusedCaller } from "../server/room/tool-table";
import { incidentOf } from "../server/operations/lines";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import tools from "../shared/tools.json";
import { ROLES } from "../shared/workflow";
import { roleSkillNames } from "../server/orchestration/runtimes";
import { HARNESSES, knownSpecs, rolePrompt } from "../server/orchestration/seats";
import { loadPolicy } from "../server/policy";
import { launch } from "../server/room/launch";

/** What a seat is told holds: every placeholder filled, every room tool real, every skill named its own. */

before(() => installRoom(["claude-hq", "claude-supervisor", "claude-lead", "claude-peer"]));

const params = () => loadPolicy().room.params;
const prompts = () =>
  ROLES.flatMap((role) =>
    HARNESSES.map((harness) => ({ role, harness, text: rolePrompt(role, { harness, params: params() }) })),
  );

test("every role's prompt on every agent CLI is filled in and names only the room's real tools", () => {
  const known = new Set(Object.keys(tools.tools));
  for (const { role, harness, text } of prompts()) {
    assert.doesNotMatch(text, /\{\{/, `${role} on ${harness}`);
    for (const [name] of text.matchAll(/\bseatwork_[a-z_]+\b/g)) {
      assert.ok(known.has(name), `${role} on ${harness} names ${name}, which the room does not serve`);
      assert.equal(refusedCaller(name, role), null, `${role} is told of ${name}, which it may not call`);
    }
  }
});

test("a role's prompt names only skills that role is given", () => {
  const all = new Set(ROLES.flatMap((role) => roleSkillNames(role)));
  for (const role of ROLES) {
    const own = new Set(roleSkillNames(role));
    const text = rolePrompt(role, { harness: "claude", params: params() });
    for (const [, name] of text.matchAll(/`([a-z][a-z-]*)`/g))
      if (all.has(name)) assert.ok(own.has(name), `the ${role} prompt names ${name}, a skill the ${role} is not given`);
  }
});

test("the specs the Lead may open all have a sheet, and a seat on a spec the room lacks is refused with the ones it has", async () => {
  const lead = rolePrompt("lead", { harness: "claude", params: params() });
  const named = /The spec is ((?:`[a-z-]+`(?:, | or )?)+)/.exec(lead)?.[1] ?? "";
  const specs = [...named.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, "the Lead's prompt names its specs");
  for (const spec of specs) assert.ok(knownSpecs().includes(spec), spec);

  await assert.rejects(
    launch({ provider: "claude-peer", cwd: PROJECT, title: "[Peer:research] the cache" }, loadPolicy(), () => {}),
    /no specialization "research"\. The room has: arch, review, scout, search\./,
  );
  const ok = await launch(
    { provider: "claude-peer", cwd: PROJECT, title: "[Peer:search] the cache" },
    loadPolicy(),
    () => {},
  );
  assert.match(ok.systemPrompt, /# Seat: peer \(specialization: search\)[\s\S]*Answer one question with evidence/);
});

test("the room's instruction files reach a seat on any agent CLI, and the user's own reach none unless listed", async () => {
  const providers = ["claude-peer", "codex-peer"];
  installRoom(providers);
  writeFileSync(join(ROOM_HOME, "AGENTS.md"), "ROOM-RULE: a commit names its issue.");
  mkdirSync(CLAUDE_HOME, { recursive: true });
  writeFileSync(join(CLAUDE_HOME, "CLAUDE.md"), "PERSONAL-RULE: answer in Vietnamese.");
  mkdirSync(join(USER_HOME, "notes"), { recursive: true });
  writeFileSync(join(USER_HOME, "notes", "rules.md"), "LISTED-RULE: run the linter.");
  const prompt = async (provider: string, policy = loadPolicy()) =>
    (await launch({ provider, cwd: PROJECT, title: "[Peer] the cache" }, policy, () => {})).systemPrompt;
  for (const provider of providers) {
    const text = await prompt(provider);
    assert.match(text, /ROOM-RULE/, provider);
    assert.doesNotMatch(text, /PERSONAL-RULE/, provider);
  }
  assert.equal(existsSync(join(runtimeDir({ harness: "codex", role: "peer" }), "AGENTS.md")), false);
  const listed = loadPolicy();
  listed.room.instructions = ["AGENTS.md", "~/notes/rules.md"];
  assert.match(await prompt("codex-peer", listed), /ROOM-RULE[\s\S]*LISTED-RULE/);
});

test("a project skill named like one the room gives the role is told once, as an incident", async () => {
  installRoom(["claude-peer"]);
  mkdirSync(join(PROJECT, ".claude", "skills", "test-audit"), { recursive: true });
  writeFileSync(
    join(PROJECT, ".claude", "skills", "test-audit", "SKILL.md"),
    "---\nname: test-audit\ndescription: ours\n---\n",
  );
  const lines: string[] = [];
  const start = () =>
    launch({ provider: "claude-peer", cwd: PROJECT, title: "[Peer] the cache" }, loadPolicy(), (line) =>
      lines.push(line),
    );
  await start();
  await start();
  const told = lines.filter((line) => line.startsWith("skills:"));
  assert.equal(told.length, 1);
  assert.match(
    told[0],
    /has its own "test-audit" in "\.claude\/skills", so its Claude seats cannot see the room's "test-audit"/,
  );
  assert.ok(incidentOf(told[0]));
});
