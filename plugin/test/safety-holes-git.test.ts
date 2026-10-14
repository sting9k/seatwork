import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// a git first on the path that logs each call, set before the module under test reads the environment
const REAL = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const base = mkdtempSync(join(tmpdir(), "holes-git-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));
mkdirSync(join(base, "bin"));
const log = join(base, "calls.log");
writeFileSync(join(base, "bin", "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec ${REAL} "$@"\n`);
chmodSync(join(base, "bin", "git"), 0o755);
process.env.PATH = `${join(base, "bin")}:${process.env.PATH}`;
const { runGit } = require("../server/git") as typeof import("../server/git");

const LIMITS = { timeoutMs: 10_000, maxBytes: 1 << 20 };
const calls = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const clearCalls = () => rmSync(log, { force: true });

let repos = 0;
/** A repository whose tracked `a.txt` and `b.bin` changed since the commit `head`, with a marker file a program of the repository leaves when it runs. */
function repo() {
  const dir = join(base, `repo-${(repos += 1)}`);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync(REAL, args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.bin"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "a.txt"), "two, longer than before\n");
  writeFileSync(join(dir, "b.bin"), "two, longer than before\n");
  const marker = join(dir, "..", `marker-${repos}`);
  const program = `sh -c 'echo ran >> ${marker}; cat'`;
  return {
    dir,
    git,
    head,
    program,
    ran: () => existsSync(marker),
    reset: () => rmSync(marker, { force: true }),
  };
}

/** Git calls the room makes in a work tree, and the ones that read the content of a changed file. */
const CALLS = (head: string): string[][] => [
  ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "--no-renames", head, "--"],
  ["diff", "--stat", head],
  ["diff", "--name-only", "-z", head],
  ["status", "--porcelain"],
  ["status", "--porcelain", "--", "a.txt"],
  ["ls-files", "--others", "--exclude-standard", "-z"],
  ["check-ignore", "--", "a.txt"],
];

async function noProgramRuns(r: ReturnType<typeof repo>): Promise<void> {
  r.reset();
  for (const args of CALLS(r.head)) {
    const done = await runGit(r.dir, args, LIMITS);
    assert.ok(done.code === 0 || args[0] === "check-ignore", `${args.join(" ")} ended with ${done.code}`);
    assert.equal(r.ran(), false, `git ${args.join(" ")} ran a program of the repository`);
    r.reset();
  }
}

test("a filter named in .git/info/attributes runs under plain git and under no call of the room", async () => {
  const r = repo();
  writeFileSync(join(r.dir, ".git", "info", "attributes"), "* filter=trap\n");
  r.git("config", "filter.trap.clean", r.program);
  r.git("diff", "--stat", r.head);
  assert.equal(r.ran(), true, "the trap works: any git without the room's settings runs the filter");
  await noProgramRuns(r);
  assert.match((await runGit(r.dir, ["diff", "--name-only", r.head], LIMITS)).out, /a\.txt/);
});

test("a filter in the file core.attributesFile names, or in a .gitattributes git still reads, runs no more", async () => {
  const r = repo();
  const elsewhere = join(base, `attrs-${repos}`);
  writeFileSync(elsewhere, "*.txt filter=trap\n");
  writeFileSync(join(r.dir, ".gitattributes"), "*.bin filter=trap\n");
  r.git("config", "core.attributesFile", elsewhere);
  r.git("config", "filter.trap.clean", r.program);
  r.git("config", "filter.trap.smudge", r.program);
  r.git("diff", "--stat", r.head);
  assert.equal(r.ran(), true, "the trap works");
  await noProgramRuns(r);
});

test("an external diff or a text conversion a driver names does not run, and the diff still reads", async () => {
  const r = repo();
  writeFileSync(join(r.dir, ".git", "info", "attributes"), "*.bin diff=hex\n*.txt diff=hex\n");
  r.git("config", "diff.hex.command", r.program);
  r.git("config", "diff.hex.textconv", r.program);
  r.git("diff", r.head);
  assert.equal(r.ran(), true, "the trap works");
  await noProgramRuns(r);
  const patch = await runGit(r.dir, ["diff", "--no-ext-diff", "--no-textconv", "-U0", r.head], LIMITS);
  assert.equal(patch.code, 0);
  assert.match(patch.out, /\+two, longer/);
});

test("a filter the repository requires does not stop the room's git from reading the change", async () => {
  const r = repo();
  writeFileSync(join(r.dir, ".git", "info", "attributes"), "* filter=lfs\n");
  r.git("config", "filter.lfs.clean", "git-lfs clean -- %f");
  r.git("config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  r.git("config", "filter.lfs.process", "git-lfs filter-process");
  r.git("config", "filter.lfs.required", "true");
  const patch = await runGit(r.dir, CALLS(r.head)[0], LIMITS);
  assert.equal(patch.code, 0);
  assert.match(patch.out, /\+two, longer/);
  assert.equal((await runGit(r.dir, ["status", "--porcelain"], LIMITS)).code, 0);
});

test("a repository's drivers are listed once for a few seconds, then again; git is spawned twice for a new folder and once after", async () => {
  const a = repo();
  const b = repo();
  clearCalls();
  await runGit(a.dir, ["status", "--porcelain"], LIMITS);
  assert.equal(calls().length, 2);
  assert.match(calls()[0], /config --list -z$/);
  await runGit(a.dir, ["status", "--porcelain"], LIMITS);
  await runGit(a.dir, ["diff", "--name-only", a.head], LIMITS);
  assert.equal(calls().length, 4);
  await runGit(b.dir, ["status", "--porcelain"], LIMITS);
  assert.equal(calls().length, 6);
});

test("a repository with more drivers than the room empties is not read at all, and a folder that is not there is not either", async () => {
  const r = repo();
  writeFileSync(join(r.dir, ".git", "info", "attributes"), "* filter=f0\n");
  r.git("config", "filter.f0.clean", r.program);
  for (let i = 1; i <= 100; i += 1) r.git("config", `filter.f${i}.clean`, "cat");
  clearCalls();
  const done = await runGit(r.dir, CALLS(r.head)[1], LIMITS);
  assert.equal(done.code, -1);
  assert.equal(r.ran(), false);
  assert.equal(calls().length, 1);
  assert.equal((await runGit(join(base, "no-such-folder"), ["status"], LIMITS)).code, -1);
});

test("many attribute lines and many drivers cost one listing of the config, whatever the attribute file holds", async () => {
  const r = repo();
  const lines = Array.from({ length: 20_000 }, (_, i) => `*.ext${i} filter=f${i % 50}`);
  writeFileSync(join(r.dir, ".git", "info", "attributes"), `${lines.join("\n")}\n* filter=f0\n`);
  for (let i = 0; i < 50; i += 1) r.git("config", `filter.f${i}.clean`, r.program);
  clearCalls();
  await noProgramRuns(r);
  const listings = calls().filter((line) => line.endsWith("config --list -z"));
  assert.equal(listings.length, 1);
  assert.equal(calls().length, 1 + CALLS(r.head).length);
});
