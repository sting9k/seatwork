import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Safety, type SafetyDeps } from "../server/safety/index";
import type { SafetyPolicy } from "../server/safety/guard";
import { GATE_ENV } from "../server/safety/hooks";
import { redact } from "../server/redact";

shipSql();

const HOME = "/Users/u";
/** Seats in a tree: hq above lead above two peers. */
const PARENT: Record<string, string | null> = { hq: null, lead: "hq", peer: "lead", peer2: "lead" };
const isAncestor = (a: string, b: string): boolean => {
  for (let at = PARENT[b]; at; at = PARENT[at]) if (at === a) return true;
  return false;
};

let rooms = 0;
/** A Safety of its own, with a policy the test can change and the notices it sent. */
function fresh(policy: SafetyPolicy = {}, project: string | null = null) {
  const told: string[] = [];
  const deps: SafetyDeps = {
    dir: join(ROOM_HOME, `safety-${(rooms += 1)}`),
    userHome: HOME,
    policy: () => policy,
    seat: (id) => (id in PARENT ? { role: id.replace(/\d$/, ""), cwd: "/Users/u/proj" } : null),
    projectOf: () => project,
    isAncestor,
    tmpOf: (id) => `/Users/u/.config/room/tmp/${id}`,
    guard: { paths: ["/Users/u/.config/room"], except: [] },
    roomFolder: ".seatwork",
    repeated: (seat, rule, count) => told.push(`${seat} ${rule} ${count}`),
    decider: null,
    log: () => {},
  };
  return { safety: new Safety(deps), told, policy };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/Users/u/proj" });
const verdictOf = async (safety: Safety, command: string, seat = "peer") =>
  safety.guard.check(
    { id: seat, role: "peer", project: null, tmp: null, start: null },
    "claude",
    command,
    "/Users/u/proj",
  );

test("a blocked command gets a code; the same command keeps it; a seat above grants it once, for that seat only", async () => {
  const { safety } = fresh();
  const first = await verdictOf(safety, "git reset --hard");
  assert.equal(first.allow, false);
  assert.match(first.code ?? "", /^\d{6}$/);
  assert.match(first.message ?? "", /reset-hard/);
  assert.match(first.message ?? "", new RegExp(`code ${first.code}`));
  assert.equal((await verdictOf(safety, "git reset --hard")).code, first.code);

  assert.match(safety.grant(first.code!, "peer"), /not under you/, "the blocked seat grants itself nothing");
  assert.match(safety.grant(first.code!, "peer2"), /not under you/, "a sibling is not above it");
  assert.match(safety.grant(first.code!, "lead"), /Granted/);
  assert.equal(
    (await verdictOf(safety, "git reset --hard", "peer2")).allow,
    false,
    "the grant is for the seat that asked",
  );
  assert.equal((await verdictOf(safety, "git reset --hard")).allow, true);
  assert.equal((await verdictOf(safety, "git reset --hard")).allow, false, "it is used once");
  assert.match(safety.grant("000000", "lead"), /No open code/);
});

test("a rule the person keeps for themselves is granted by no seat, however high", async () => {
  const { safety } = fresh();
  const blocked = await verdictOf(safety, "brew install jq");
  assert.equal(blocked.grantor, "human");
  assert.match(blocked.message ?? "", /Only the person/);
  assert.match(safety.grant(blocked.code!, "hq"), /only the person/);
  assert.match(safety.grant(blocked.code!, "human"), /Granted/);
  assert.equal((await verdictOf(safety, "brew install jq")).allow, true);
});

test("the owner's allow entries: a whole command, a prefix with nothing chained after it, a rule in some folders", async () => {
  const { safety } = fresh({
    allow: [
      { command: "git push --force origin release" },
      { prefix: "rm -rf ./generated/" },
      { rule: "core.git:branch-delete", paths: ["/Users/u/proj"] },
      { rule: "core.git:stash-clear", until: "2000-01-01T00:00:00Z" },
    ],
  });
  assert.equal((await verdictOf(safety, "git push --force origin release")).allow, true);
  assert.equal((await verdictOf(safety, "git push --force origin main")).allow, false);
  assert.equal((await verdictOf(safety, "rm -rf ./generated/a")).allow, true);
  assert.equal((await verdictOf(safety, "rm -rf ./generated/a; rm -rf ~")).allow, false);
  assert.equal((await verdictOf(safety, "git branch -d old")).allow, true);
  assert.equal((await verdictOf(safety, "git stash clear")).allow, false, "an entry past its date holds nothing");
});

test("a pack-wide setting never lowers a critical rule, and a project may only tighten", async () => {
  const project = join(ROOM_HOME, "tight-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  writeFileSync(
    join(project, ".seatwork", "safety.json"),
    JSON.stringify({
      packs: { add: ["strict_git"] },
      rules: { "core.git:reset-hard": "warn", "core.git:stash-drop": "deny" },
    }),
  );
  const { safety } = fresh({ rules: { "core.git:*": "warn" } }, project);
  const check = (command: string) =>
    safety.guard.check({ id: "peer", role: "peer", project, tmp: null, start: null }, "claude", command, project);
  assert.equal((await check("git reset --hard")).allow, false, "critical stays blocked under a pack-wide warn");
  assert.equal((await check("git checkout -- a.ts")).allow, true, "a high rule follows the pack-wide warn");
  assert.match((await check("git checkout -- a.ts")).message ?? "", /let this run with a note/);
  assert.equal((await check("git stash drop")).allow, false, "the project raised a medium rule");
  assert.equal((await check("git rebase main")).allow, false, "the project turned strict_git on");
});

test("a seat that keeps running into one rule makes its Owner hear it once", async () => {
  const { safety, told } = fresh({ repeat: { count: 3, minutes: 30 } });
  for (let i = 0; i < 5; i += 1) await verdictOf(safety, `git push --force origin b${i}`);
  assert.deepEqual(told, ["peer core.git:push-force-long 3"]);
});

test("a check keeps nothing: no code, no record, and a grant still works after", async () => {
  const { safety } = fresh();
  assert.match(
    await safety.explain("peer", "git reset --hard", "/Users/u/proj"),
    /blocked this command.*reset --hard|reset-hard/s,
  );
  assert.match(await safety.explain("peer", "ls", "/Users/u/proj"), /Allowed/);
  assert.deepEqual(safety.store().waiting(["peer"]), []);
});

test("Claude and Codex read a deny as hook JSON and nothing for an allow; Pi and OpenCode read a block flag", async () => {
  const { safety } = fresh();
  const deny = JSON.parse((await safety.answer("claude", bash("git clean -fdx"), "peer")).text);
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /clean-force/);
  assert.equal((await safety.answer("codex", bash("git status"), "peer")).text, "");
  const warn = JSON.parse((await safety.answer("claude", bash("git stash drop"), "peer")).text);
  assert.equal(warn.hookSpecificOutput.permissionDecision, undefined);
  assert.match(warn.hookSpecificOutput.additionalContext, /stash-drop/);
  const write = JSON.parse(
    (
      await safety.answer(
        "claude",
        { tool_name: "Write", tool_input: { file_path: `${HOME}/.zshrc` }, cwd: "/x" },
        "peer",
      )
    ).text,
  );
  assert.match(write.hookSpecificOutput.permissionDecisionReason, /credential-file-write/);
  const patch = {
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: .git/config\n*** End Patch" },
    cwd: "/Users/u/proj",
  };
  assert.match(
    JSON.parse((await safety.answer("codex", patch, "peer")).text).hookSpecificOutput.permissionDecisionReason,
    /git-internals-write/,
  );
  assert.deepEqual(
    JSON.parse((await safety.answer("pi", { tool: "bash", input: { command: "ls" }, cwd: "/x" }, "peer")).text),
    { block: false, note: null },
  );
  assert.equal(
    JSON.parse(
      (await safety.answer("opencode", { tool: "shell", input: { command: "rm -rf ~" }, cwd: "/x" }, "peer")).text,
    ).block,
    true,
  );
});

test("with the guard off nothing is checked, and a seat still gets the guard's address for a hook it kept", async () => {
  const { safety } = fresh({ mode: "off" });
  assert.equal((await safety.answer("claude", bash("rm -rf ~"), "peer")).text, "");
  assert.deepEqual(safety.env("peer", "http://x"), { [GATE_ENV.url]: "http://x", [GATE_ENV.seat]: "peer" });
});

test("what the guard keeps hides secrets: tokens, passwords, auth headers, key variables", () => {
  const shown = redact(
    "curl -H 'Authorization: Bearer abc.def.ghi' -u me:pw https://me:hunter2@host/x --password s3cret && OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa node x.js ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
  );
  for (const secret of ["abc.def.ghi", "hunter2", "s3cret", "sk-proj-aaaa", "ghp_aaaa"])
    assert.ok(!shown.includes(secret), `${secret} in ${shown}`);
});

test("every statement the safety store runs uses an index", async () => {
  const { safety } = fresh();
  const blocked = await verdictOf(safety, "git reset --hard");
  safety.grant(blocked.code!, "lead");
  await verdictOf(safety, "git reset --hard");
  for (let i = 0; i < 3; i += 1) await verdictOf(safety, `git push --force origin x${i}`);
  safety.waitingUnder("lead", ["peer", "peer2"]);
  safety.blocksLine("peer");
  const store = safety.store();
  store.noteStart("peer", "/x", "abc");
  store.inherit("peer", "peer9");
  store.startOf("peer9");
  store.noteFindings("peer", [
    { fingerprint: "f1", rule: "debugger", severity: "block", path: "a.ts", line: 1, text: "debugger" },
  ]);
  store.acknowledge("peer", "f1", "kept on purpose for the demo");
  store.expire(new Date(0));
  const scans = store
    .plans()
    .filter(({ plan }) => /\bSCAN (decisions|codes|escalations|seats|findings)\b(?! USING)/.test(plan));
  assert.deepEqual(scans, []);
});
