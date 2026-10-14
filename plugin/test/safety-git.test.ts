import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runGit } from "../server/git";
import { packsInForce } from "../server/safety/gate/packs";
import { inspectHandIn } from "../server/safety/handin";
import { SafetyStore } from "../server/safety/store";
import { machineTools } from "../server/safety/system";

shipSql();

const [major, minor] = execFileSync("git", ["--version"], { encoding: "utf8" })
  .match(/(\d+)\.(\d+)/)!
  .slice(1)
  .map(Number);
const attrSource = major > 2 || (major === 2 && minor >= 40);

let repos = 0;
/** A repository whose tracked file `a.txt` changed since its commit, and whose config names a clean filter that leaves a marker file when it runs. */
function trapped() {
  const dir = join(ROOM_HOME, `git-trap-${(repos += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), ".store/\nMARKER\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  const head = git("rev-parse", "HEAD");
  const marker = join(dir, "MARKER");
  writeFileSync(join(dir, ".gitattributes"), "* filter=trap\n");
  git("config", "filter.trap.clean", `sh -c 'echo ran > ${marker}; cat'`);
  writeFileSync(join(dir, "a.txt"), "two, longer than before\n");
  return { dir, git, head, marker, ran: () => existsSync(marker), reset: () => rmSync(marker, { force: true }) };
}

test("a filter a repository declares runs under plain git, which is why the room's git is told not to read attributes", () => {
  const { git, ran, reset } = trapped();
  git("diff", "HEAD", "--stat");
  assert.equal(ran(), true, "the trap works: any git without the room's flags runs the filter");
  reset();
});

test("the room's git calls run no filter a repository declares", { skip: !attrSource }, async () => {
  const { dir, head, ran, reset } = trapped();
  const limits = { timeoutMs: 5000, maxBytes: 1 << 20 };
  for (const args of [
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", head, "--"],
    ["diff", "--name-only", "-z", head],
    ["status", "--porcelain"],
    ["status", "--porcelain", "--", "a.txt"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["check-ignore", "--", "a.txt"],
  ]) {
    const done = await runGit(dir, args, limits);
    assert.ok(done.code === 0 || args[0] === "check-ignore", `${args[0]} ran: ${done.code}`);
    assert.equal(ran(), false, `git ${args.join(" ")} ran the filter`);
    reset();
  }
  // the room still sees the change: attributes only decide how a file is converted
  assert.match((await runGit(dir, ["diff", "--name-only", head], limits)).out, /a\.txt/);
});

test(
  "the hand-in check reads a repository's change without running a filter it declares",
  { skip: !attrSource },
  async () => {
    const { dir, git, head, ran } = trapped();
    const store = new SafetyStore(join(dir, ".store"), 1000);
    store.noteStart("seat", dir, head);
    const result = await inspectHandIn("seat", store, {
      place: { home: "/Users/u", project: dir, tmp: null, start: dir, guard: null, roomFolder: ".seatwork" },
      config: { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
      tools: machineTools(() => null),
    });
    assert.notEqual(result.state, "partial", result.why ?? "");
    assert.equal(result.files, 2);
    assert.equal(ran(), false);
    assert.ok(git("status", "--porcelain").length > 0);
  },
);

test("a .gitattributes line that names a filter or a driver of the repository's own sends the hand-in back", async () => {
  const dir = join(ROOM_HOME, `git-attributes-${(repos += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), ".store/\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  const store = new SafetyStore(join(dir, ".store"), 1000);
  store.noteStart("seat", dir, git("rev-parse", "HEAD"));
  const gate = {
    place: { home: "/Users/u", project: dir, tmp: null, start: dir, guard: null, roomFolder: ".seatwork" },
    config: { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  };
  writeFileSync(
    join(dir, ".gitattributes"),
    [
      "* text=auto",
      "*.png binary",
      "*.lock -diff",
      "*.go diff=golang",
      "*.md diff=markdown",
      "yarn.lock merge=union",
      "*.sh eol=lf",
      "*.bin filter=trap",
      "*.dat diff=hex",
      "*.json merge=custom",
      "docs/** filter=lfs diff=lfs merge=lfs -text",
    ].join("\n") + "\n",
  );
  writeFileSync(join(dir, "notes.txt"), "* filter=mentioned in a file that is no attributes file\n");
  const result = await inspectHandIn("seat", store, gate);
  assert.equal(result.state, "blocked");
  assert.deepEqual(
    result.open.map((row) => `${row.rule} ${row.path}:${row.line}`),
    ["attributes-driver .gitattributes:8", "attributes-driver .gitattributes:9", "attributes-driver .gitattributes:10"],
  );
});
