import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Safety, type SafetyDeps } from "../server/safety/index";
import type { SafetyPolicy } from "../server/safety/guard";
import { GATE_ENV } from "../server/safety/hooks";
import { machineTools } from "../server/safety/system";

const gitModule = require("../server/git") as typeof import("../server/git");

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
    daemon: "127.0.0.1:6767",
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

test("the owner's allow entries: a whole command, a prefix with nothing chained or leading out after it, a rule in some folders", async () => {
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
  for (const out of ["../../.ssh", "a/../../..", "a ~", "a /", "$HOME", "*"])
    assert.equal(
      (await verdictOf(safety, `rm -rf ./generated/${out}`)).allow,
      false,
      `the tail ${out} leaves the prefix`,
    );
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
    tool_input: { command: "*** Begin Patch\n*** Update File: .git/HEAD\n*** End Patch" },
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

test("every statement the safety store runs uses an index", async () => {
  const { safety } = fresh();
  const blocked = await verdictOf(safety, "git reset --hard");
  safety.grant(blocked.code!, "lead");
  await verdictOf(safety, "git reset --hard");
  for (let i = 0; i < 3; i += 1) await verdictOf(safety, `git push --force origin x${i}`);
  safety.waitingUnder("lead", ["peer", "peer2"]);
  safety.forPerson(50);
  safety.blocksLine("peer");
  const store = safety.store();
  store.noteStart("peer", "/x", "abc");
  store.inherit("peer", "peer9");
  store.seen("peer9");
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
  const plans = store.plans().map(({ plan }) => plan);
  const indexes = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'council_%'",
    )
    .all() as { name: string }[];
  assert.deepEqual(
    indexes.map(({ name }) => name).filter((name) => !plans.some((plan) => plan.includes(name))),
    [],
    "an index no statement uses costs a write for nothing",
  );
});

const writeOf = (safety: Safety, path: string, cwd = "/Users/u/proj") =>
  safety.guard.checkWrite({ id: "peer", role: "peer", project: null, tmp: null, start: null }, "claude", path, cwd);

test("a code granted for a blocked file write lets that write through once, as for a command", async () => {
  const { safety } = fresh();
  const blocked = await writeOf(safety, `${HOME}/.zshrc`);
  assert.equal(blocked.allow, false);
  assert.match(safety.grant(blocked.code!, "lead"), /Granted/);
  assert.equal((await writeOf(safety, `${HOME}/.zshrc`)).allow, true);
  assert.equal((await writeOf(safety, `${HOME}/.zshrc`)).allow, false, "it is used once");
});

test("the owner's allow entries lift a rule for a file write as they do for a command", async () => {
  const { safety } = fresh({
    allow: [{ rule: "core.filesystem:credential-file-write", paths: ["/Users/u/proj"] }],
  });
  assert.equal((await writeOf(safety, `${HOME}/.zshrc`)).allow, true);
  assert.equal((await writeOf(safety, `${HOME}/.zshrc`, "/Users/u/other")).allow, false, "only in the folders named");
});

test("a script the seat wrote after it started is read before it runs, in a repository or not", async () => {
  const { safety } = fresh();
  const dir = join(ROOM_HOME, "script-room");
  mkdirSync(dir, { recursive: true });
  await safety.started("peer", dir);
  writeFileSync(join(dir, "wipe.sh"), "rm -rf ~\n");
  writeFileSync(join(dir, "clean.sh"), "echo hi\n");
  const check = (command: string) =>
    safety.guard.check({ id: "peer", role: "peer", project: null, tmp: null, start: null }, "claude", command, dir);
  const wipe = await check(`bash ${dir}/wipe.sh`);
  assert.equal(wipe.allow, false);
  assert.match(wipe.message ?? "", /rm-rf/);
  assert.equal((await check(`bash ${dir}/clean.sh`)).allow, true);
});

test("the guard's gate settings are the policy's, with the packs the project adds", () => {
  const project = join(ROOM_HOME, "config-project");
  mkdirSync(join(project, ".seatwork"), { recursive: true });
  writeFileSync(join(project, ".seatwork", "safety.json"), JSON.stringify({ packs: { add: ["strict_git"] } }));
  const place = { home: HOME, project, tmp: null, start: null, guard: null, roomFolder: ".seatwork" };
  const plain = fresh({ packs: { add: ["containers"] } }).safety.guard.gateConfig({ ...place, project: null });
  assert.deepEqual([plain.packs.has("strict_git"), plain.packs.has("containers")], [false, true]);
  assert.deepEqual([plain.budgetMs, plain.maxBytes], [1000, 65536]);
  const set = fresh({ packs: { add: ["containers"] }, budgetMs: 300, maxBytes: 4096 }).safety.guard.gateConfig(place);
  assert.deepEqual([set.packs.has("strict_git"), set.packs.has("containers")], [true, true]);
  assert.deepEqual([set.budgetMs, set.maxBytes], [300, 4096]);
});

test("a script git says is unchanged is asked about once in a while, not at every run", async () => {
  const dir = join(ROOM_HOME, "unchanged-room");
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  writeFileSync(join(dir, "ok.sh"), "echo ok\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const tools = machineTools(() => null);
  const real = gitModule.runGit;
  let asked = 0;
  gitModule.runGit = (...args: Parameters<typeof real>) => ((asked += 1), real(...args));
  try {
    for (let i = 0; i < 5; i += 1) assert.equal(await tools.changed(join(dir, "ok.sh")), null);
    assert.equal(asked, 1);
    writeFileSync(join(dir, "ok.sh"), "echo changed\n");
    utimesSync(join(dir, "ok.sh"), new Date(), new Date(Date.now() + 5000));
    assert.equal(
      await tools.changed(join(dir, "ok.sh")),
      "echo changed\n",
      "a file that was touched is looked at again",
    );
  } finally {
    gitModule.runGit = real;
  }
});

test("a script a seat committed is read when another seat runs it; one the repository had before the room is its own", async () => {
  const repo = join(ROOM_HOME, "based-repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q");
  writeFileSync(join(repo, "tidy.sh"), "rm -rf ~/Documents\n");
  git("add", "-A");
  git("commit", "-qm", "the owner's");
  const { safety } = fresh();
  await safety.started("peer", repo);
  writeFileSync(join(repo, "wipe.sh"), "rm -rf ~/Documents\n");
  git("add", "-A");
  git("commit", "-qm", "a seat's");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(repo, "wipe.sh"), past, past);
  await safety.started("peer2", repo);
  const run = (command: string) =>
    safety.guard.check({ id: "peer2", role: "peer", project: null, tmp: null, start: repo }, "claude", command, repo);
  assert.equal((await run("bash wipe.sh")).allow, false, "the seats' committed script is read");
  assert.equal((await run("bash tidy.sh")).allow, true, "the repository's own script stays its own");
});

test("a patch that touches several files carries the note of any file the guard let through with one", async () => {
  const { safety } = fresh({ rules: { "core.filesystem:credential-file-write": "warn" } });
  const patch = {
    tool_name: "apply_patch",
    tool_input: {
      command: "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: /Users/u/.zshrc\n*** End Patch",
    },
    cwd: "/Users/u/proj",
  };
  assert.match((await safety.answer("codex", patch, "peer")).text, /let this run with a note.*credential-file-write/);
});
