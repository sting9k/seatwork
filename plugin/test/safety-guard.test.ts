import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Safety, type SafetyDeps } from "../server/safety/index";
import type { SafetyPolicy } from "../server/safety/guard";
import { GATE_ENV } from "../server/safety/hooks";
import { keptRules } from "./support/kept";
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
/** A Safety of its own, with a policy the test can change. */
function fresh(policy: SafetyPolicy = {}, project: string | null = null) {
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
    decider: null,
    log: () => {},
  };
  return { safety: new Safety(deps), policy };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/Users/u/proj" });
const verdictOf = async (safety: Safety, command: string, seat = "peer") =>
  safety.guard.check(
    { id: seat, role: "peer", project: null, tmp: null, start: null },
    "claude",
    command,
    "/Users/u/proj",
  );

test("a call a rule holds for runs and is kept: Claude and Codex read nothing, Pi and OpenCode no block", async () => {
  const { safety } = fresh();
  assert.equal((await safety.answer("claude", bash("git clean -fdx"), "peer")).text, "");
  assert.equal((await safety.answer("codex", bash("git status"), "peer")).text, "");
  assert.equal(
    (
      await safety.answer(
        "claude",
        { tool_name: "Write", tool_input: { file_path: `${HOME}/.zshrc` }, cwd: "/x" },
        "peer",
      )
    ).text,
    "",
  );
  const patch = {
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Update File: .git/HEAD\n*** End Patch" },
    cwd: "/Users/u/proj",
  };
  assert.equal((await safety.answer("codex", patch, "peer")).text, "");
  assert.equal(
    (await safety.answer("opencode", { tool: "shell", input: { command: "rm -rf ~" }, cwd: "/x" }, "peer")).text,
    "",
  );
  assert.deepEqual(keptRules(safety.store(), "peer"), [
    "core.git:clean-force",
    "core.filesystem:credential-file-write",
    "core.filesystem:git-internals-write",
    "core.filesystem:rm-rf-root-home",
  ]);
});

test("with the guard off nothing is checked, and a seat still gets the guard's address for a hook it kept", async () => {
  const { safety } = fresh({ mode: "off" });
  assert.equal((await safety.answer("claude", bash("rm -rf ~"), "peer")).text, "");
  assert.deepEqual(safety.env("peer", "http://x"), { [GATE_ENV.url]: "http://x", [GATE_ENV.seat]: "peer" });
});

test("what the guard kept reads back as its audit log: the calls each rule held for, then the newest calls", async () => {
  const { safety } = fresh();
  assert.deepEqual(safety.guardLines(1, 5), []);
  await verdictOf(safety, "git reset --hard");
  await verdictOf(safety, "ls");
  await verdictOf(safety, "git reset --hard HEAD~1");
  const [counts, ...newest] = safety.guardLines(1, 5);
  assert.equal(counts, "guard, last 1 days: core.git:reset-hard 2");
  assert.equal(newest.length, 2);
  assert.match(newest[0], /core\.git:reset-hard \(critical\): git reset --hard HEAD~1$/);
});

test("every statement the safety store runs uses an index", async () => {
  const { safety } = fresh();
  await verdictOf(safety, "git reset --hard");
  const store = safety.store();
  store.noteStart("peer", "/x", "abc");
  store.inherit("peer", "peer9");
  store.seen("peer9");
  store.startOf("peer9");
  store.noteFindings("peer", [
    { fingerprint: "f1", rule: "debugger", severity: "block", path: "a.ts", line: 1, text: "debugger" },
  ]);
  store.acknowledge("peer", "f1", "kept on purpose for the demo");
  store.kept("", 5, "peer");
  store.keptCounts("");
  store.expire(new Date(0));
  const scans = store.plans().filter(({ plan }) => /\bSCAN (decisions|seats|findings)\b(?! USING)/.test(plan));
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

test("a script the seat wrote after it started is read before it runs, in a repository or not", async () => {
  const { safety } = fresh();
  const dir = join(ROOM_HOME, "script-room");
  mkdirSync(dir, { recursive: true });
  await safety.started("peer", dir);
  writeFileSync(join(dir, "wipe.sh"), "rm -rf ~\n");
  writeFileSync(join(dir, "clean.sh"), "echo hi\n");
  const check = (command: string) =>
    safety.guard.check({ id: "peer", role: "peer", project: null, tmp: null, start: null }, "claude", command, dir);
  await check(`bash ${dir}/wipe.sh`);
  await check(`bash ${dir}/clean.sh`);
  assert.deepEqual(keptRules(safety.store(), "peer"), ["core.filesystem:rm-rf-root-home"]);
});

test("the guard's gate settings are the policy's", () => {
  const plain = fresh({ packs: { add: ["containers"] } }).safety.guard.gateConfig();
  assert.deepEqual([plain.packs.has("strict_git"), plain.packs.has("containers")], [false, true]);
  assert.deepEqual([plain.budgetMs, plain.maxBytes], [1000, 65536]);
  const set = fresh({ packs: { add: ["containers"] }, budgetMs: 300, maxBytes: 4096 }).safety.guard.gateConfig();
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
  await run("bash wipe.sh");
  assert.equal(keptRules(safety.store(), "peer2").length, 1, "the seats' committed script is read");
  await run("bash tidy.sh");
  assert.equal(keptRules(safety.store(), "peer2").length, 1, "the repository's own script stays its own");
});
