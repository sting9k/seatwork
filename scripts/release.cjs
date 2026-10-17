#!/usr/bin/env node
/** A release on main from dev/main: its tree without tests, evals and dev tools, checked to compile, committed on top of main's history. Usage: node scripts/release.cjs [--push] [--trailer "<line>"]... */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SOURCE = "dev/main";
const TARGET = "main";
const DROP = ["plugin/test", "plugin/tools", "evals", "scripts"];

/** Runs git; what it printed, trimmed. */
const git = (args, env = process.env) => execFileSync("git", args, { encoding: "utf8", env }).trim();

/** The lines given after each --trailer. */
function trailers(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === "--trailer" && argv[i + 1]) out.push(argv[(i += 1)]);
  return out;
}

/** A JSON file of the release with lines whose text matches `drop` taken out; still valid JSON, or the release stops. */
function trimmed(source, file, drop) {
  const text = git(["show", `${source}:${file}`]);
  const kept = text
    .split("\n")
    .filter((line) => !drop.test(line))
    .join("\n")
    .replace(/,(\s*[\]}])/g, "$1");
  JSON.parse(kept);
  return `${kept}\n`;
}

/** Puts a file's new text into the index the release is built in. */
function stage(env, file, text) {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: text, encoding: "utf8" }).trim();
  git(["update-index", "--cacheinfo", `100644,${blob},${file}`], env);
}

/** Unpacks a tree into `dir` and type-checks its plugin with the dev tree's node_modules; throws when it does not compile. */
function compiles(tree, dir, root) {
  const tar = path.join(dir, "tree.tar");
  git(["archive", "--format=tar", "-o", tar, tree]);
  const out = path.join(dir, "tree");
  fs.mkdirSync(out);
  execFileSync("tar", ["-xf", tar, "-C", out]);
  fs.symlinkSync(path.join(root, "plugin", "node_modules"), path.join(out, "plugin", "node_modules"));
  execFileSync(path.join(root, "plugin", "node_modules", ".bin", "tsc"), ["--noEmit", "-p", "."], {
    cwd: path.join(out, "plugin"),
    stdio: "inherit",
  });
}

/** Builds the release in an index of its own, so the working tree is not touched, and moves main to it; with --push, pushes main. */
function main() {
  const root = git(["rev-parse", "--show-toplevel"]);
  process.chdir(root);
  const checkedOut = git(["worktree", "list", "--porcelain"]).split("\n");
  if (checkedOut.includes(`branch refs/heads/${TARGET}`))
    throw new Error(`${TARGET} is checked out in a worktree: switch it to ${SOURCE} first`);
  const source = git(["rev-parse", `${SOURCE}^{commit}`]);
  const parent = git(["rev-parse", `${TARGET}^{commit}`]);
  const version = JSON.parse(git(["show", `${source}:plugin/package.json`])).version;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seatwork-release-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    git(["read-tree", source], env);
    git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...DROP], env);
    stage(env, "plugin/package.json", trimmed(source, "plugin/package.json", /^\s*"test":/));
    stage(env, "plugin/tsconfig.json", trimmed(source, "plugin/tsconfig.json", /^\s*"(test|tools)\/\*\*\/\*\.ts",?$/));
    const tree = git(["write-tree"], env);
    if (tree === git(["rev-parse", `${parent}^{tree}`])) {
      console.log(`${TARGET} already holds ${SOURCE} ${source.slice(0, 7)}: nothing to release`);
      return;
    }
    compiles(tree, dir, root);
    const message = [`Release ${version}, from ${SOURCE} ${source.slice(0, 7)}`, ...trailers(process.argv.slice(2))];
    const commit = git(["commit-tree", tree, "-p", parent, ...message.flatMap((line) => ["-m", line])]);
    git(["update-ref", `refs/heads/${TARGET}`, commit, parent]);
    console.log(`${TARGET} ${commit.slice(0, 7)}: release ${version} from ${SOURCE} ${source.slice(0, 7)}`);
    if (process.argv.includes("--push")) git(["push", "origin", TARGET]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
