import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { runGit } from "../git";
import type { Tools } from "./gate/evaluate";

/** The guard's questions to the machine: git, a rebase under way, changed files. */

const GIT_TIMEOUT_MS = 400;
const MAX_SCRIPT = 256 * 1024;

function git(args: string[], cwd: string | null): Promise<{ code: number; out: string }> {
  return runGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, maxBytes: 1 << 20 });
}

/** The folder a path lies in that exists, to run git from. */
function existingDir(path: string): string | null {
  let dir = path;
  for (let i = 0; i < 64 && dir !== "/"; i += 1) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    dir = dirname(dir);
  }
  return null;
}

/** A small cache of answers that may change: at most `size` keys, each kept `ttlMs`. */
class Recent<T> {
  private readonly items = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly size: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const found = this.items.get(key);
    if (!found || Date.now() - found.at > this.ttlMs) return undefined;
    return found.value;
  }

  set(key: string, value: T): void {
    this.items.delete(key);
    if (this.items.size >= this.size) this.items.delete(this.items.keys().next().value!);
    this.items.set(key, { value, at: Date.now() });
  }
}

const aliases = new Recent<string | null>(256, 60_000);
const unchanged = new Recent<true>(256, 10_000);

/** Whether git sees a file as new or changed; one it saw unchanged is not asked about again for a few seconds. */
async function differsFromCommit(path: string, stat: Stats): Promise<boolean> {
  const key = `${path}\0${stat.mtimeMs}\0${stat.size}`;
  if (unchanged.get(key)) return false;
  const done = await git(["status", "--porcelain", "--", path], dirname(path));
  if (done.code !== 0) return false;
  if (done.out.trim()) return true;
  unchanged.set(key, true);
  return false;
}

/** Tools for one seat: `since` is when it started; a file written after it may be the seat's own. */
export function machineTools(since: () => number | null): Tools {
  return {
    async ignored(paths) {
      const dir = paths.length ? existingDir(dirname(paths[0])) : null;
      if (!dir) return new Set();
      const done = await git(["check-ignore", "--", ...paths], dir);
      return new Set(done.out.split("\n").filter(Boolean));
    },
    exempt: () => false,
    async alias(name, cwd) {
      const key = `${cwd ?? ""}\0${name}`;
      const known = aliases.get(key);
      if (known !== undefined) return known;
      const done = await git(["config", "--get", `alias.${name}`], cwd && existsSync(cwd) ? cwd : null);
      const value = done.code === 0 ? done.out.trim() : null;
      aliases.set(key, value);
      return value;
    },
    async external(name) {
      for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        try {
          accessSync(join(dir, `git-${name}`), constants.X_OK);
          return true;
        } catch {
          continue;
        }
      }
      return false;
    },
    async rebasing(cwd) {
      if (!cwd || !existsSync(cwd)) return false;
      const done = await git(["rev-parse", "--git-dir"], cwd);
      if (done.code !== 0) return false;
      const gitDir = done.out.trim();
      const abs = gitDir.startsWith("/") ? gitDir : join(cwd, gitDir);
      return existsSync(join(abs, "rebase-merge")) || existsSync(join(abs, "rebase-apply"));
    },
    stat(path) {
      try {
        const s = lstatSync(path);
        return { exists: true, link: s.isSymbolicLink(), dir: s.isDirectory() };
      } catch {
        return { exists: false, link: false, dir: false };
      }
    },
    real(path) {
      try {
        return realpathSync.native(path);
      } catch {
        return null;
      }
    },
    async changed(path) {
      try {
        const s = statSync(path);
        if (!s.isFile() || s.size > MAX_SCRIPT) return null;
        const start = since();
        const written = start !== null && s.mtimeMs >= start;
        if (!written && !(await differsFromCommit(path, s))) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}
