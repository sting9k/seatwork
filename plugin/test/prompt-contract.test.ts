import { installRoom, PROJECT } from "./support/room";
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
    for (const [name] of text.matchAll(/\bseatwork_[a-z_]+\b/g))
      assert.ok(known.has(name), `${role} on ${harness} names ${name}, which the room does not serve`);
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
