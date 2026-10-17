import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { GIT_SAFE_ARGS, GIT_SAFE_ENV, runGit } from "../git";
import { changesSince, isTestPath } from "./handin";

/** A control for a candidate's tests: the project as it was when the writer started, with only the candidate's tests laid in. */

const ARCHIVE_MS = 60_000;
const SHARED = ["node_modules", ".venv", "venv"];

/** What a control holds: its folder, the commit it stands on, the tests laid in, and the changed sources left as they were. */
interface Control {
  path: string;
  base: string;
  tests: string[];
  sources: string[];
}

/** Writes the tree of `head` into `to` with git's own archive, so the project's index and work tree are left alone. */
async function archive(cwd: string, head: string, to: string): Promise<void> {
  const git = spawn("git", [...GIT_SAFE_ARGS, "-C", cwd, "archive", "--format=tar", head], {
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_SAFE_ENV,
  });
  const tar = spawn("tar", ["-x", "-C", to], { stdio: ["pipe", "ignore", "pipe"] });
  git.stdout.pipe(tar.stdin);
  let said = "";
  for (const child of [git, tar]) child.stderr.on("data", (chunk) => (said += chunk));
  const timer = setTimeout(() => {
    git.kill("SIGKILL");
    tar.kill("SIGKILL");
  }, ARCHIVE_MS);
  const exit = (child: typeof git | typeof tar) =>
    new Promise<number | null>((done) => {
      child.on("error", () => done(null));
      child.on("close", (code) => done(code));
    });
  const [gitCode, tarCode] = await Promise.all([exit(git), exit(tar)]).finally(() => clearTimeout(timer));
  if (gitCode !== 0 || tarCode !== 0)
    throw new Error(
      `the copy of ${head.slice(0, 8)} failed: ${said.trim().slice(0, 300) || `exit ${gitCode}/${tarCode}`}`,
    );
}

/** Builds a control in `to` for the work in `cwd` since `head`: the whole repository, its tests run from `cwd`'s place in it, its installed dependency folders linked and nothing installed; a string says why there is none. */
export async function buildControl(cwd: string, head: string, to: string): Promise<Control | string> {
  const changes = await changesSince(cwd, head);
  if (typeof changes === "string") return changes;
  const up = await runGit(cwd, ["rev-parse", "--show-cdup"], { timeoutMs: ARCHIVE_MS, maxBytes: 1 << 16 });
  if (up.code !== 0) return "git rev-parse failed";
  const root = resolve(cwd, up.out.trim());
  const here = join(to, relative(root, cwd));
  const tests = changes.filter((change) => isTestPath(change.path));
  const sources = changes.filter((change) => !isTestPath(change.path)).map((change) => change.path);
  if (tests.length === 0) return "the work changed no test: there is nothing to run against the base";
  mkdirSync(to, { recursive: true });
  try {
    await archive(root, head, to);
    for (const test of tests) {
      const target = join(to, test.path);
      if (test.deleted) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, test.text ?? readFileSync(test.file));
      }
    }
    for (const name of SHARED)
      if (existsSync(join(cwd, name)) && !existsSync(join(here, name))) symlinkSync(join(cwd, name), join(here, name));
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
  return { path: here, base: head, tests: tests.map((test) => test.path).sort(), sources: sources.sort() };
}
