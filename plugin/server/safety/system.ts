import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { runGit } from "../git";
import type { Rc, Tools } from "./gate/evaluate";
import { CLAUDE_HOME } from "../paths";

/** The guard's questions to the machine: git, a rebase under way, changed files. */

const GIT_TIMEOUT_MS = 400;
const MAX_SCRIPT = 256 * 1024;
const MAX_SNAPSHOT = 1024 * 1024;
const FRESH_MS = 2000;

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
const commonDirs = new Recent<string | null>(256, 60_000);

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

interface Newest {
  file: string;
  mtimeMs: number;
}

let snapshot: (Newest & { rc: Rc }) | null = null;
let listing: { dir: string; mtimeMs: number; newest: Newest | null } | null = null;

/** Whether a snapshot file is as it was listed: there, unchanged and small enough. */
function asListed(newest: Newest): boolean {
  try {
    const stat = statSync(newest.file);
    return stat.mtimeMs === newest.mtimeMs && stat.size <= MAX_SNAPSHOT;
  } catch {
    return false;
  }
}

/** The newest snapshot file of a folder, listed again only when the folder's timestamp moved or is too fresh to tell: every command asks. */
function newestIn(dir: string): Newest | null {
  const folder = statSync(dir);
  if (
    listing?.dir === dir &&
    listing.mtimeMs === folder.mtimeMs &&
    Date.now() - folder.mtimeMs > FRESH_MS &&
    (!listing.newest || asListed(listing.newest))
  )
    return listing.newest;
  let newest: Newest | null = null;
  for (const name of readdirSync(dir)) {
    if (!/^snapshot-.+\.sh$/.test(name)) continue;
    const stat = statSync(join(dir, name));
    if (stat.size <= MAX_SNAPSHOT && (!newest || stat.mtimeMs > newest.mtimeMs))
      newest = { file: join(dir, name), mtimeMs: stat.mtimeMs };
  }
  listing = { dir, mtimeMs: folder.mtimeMs, newest };
  return newest;
}

/** The aliases and functions in the newest shell snapshot Claude Code took of the user's rc, which its seats' shells start from; null when there is none. */
export function claudeRc(dir = join(CLAUDE_HOME, "shell-snapshots")): Rc | null {
  let newest: Newest | null;
  try {
    newest = newestIn(dir);
  } catch {
    return null;
  }
  if (!newest) return null;
  if (snapshot?.file === newest.file && snapshot.mtimeMs === newest.mtimeMs) return snapshot.rc;
  const text = readFileSync(newest.file, "utf8");
  const aliases = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/^alias (?:-- )?([^=\s]+)=(.*)$/gm))
    aliases.set(
      name,
      value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("'\\''", "'") : value,
    );
  const functions = /^# Functions\n([\s\S]*?)^# /m.exec(text)?.[1] ?? "";
  snapshot = { ...newest, rc: { aliases, functions } };
  return snapshot.rc;
}

/** Whether a committed file differs from the commit the room first saw its repository at: then the room's seats wrote it. */
async function differsFromBase(
  path: string,
  stat: Stats,
  baseOf: (commonDir: string) => string | null,
): Promise<boolean> {
  const dir = dirname(path);
  let common = commonDirs.get(dir);
  if (common === undefined) {
    const done = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
    common = done.code === 0 ? done.out.trim() || null : null;
    commonDirs.set(dir, common);
  }
  const base = common ? baseOf(common) : null;
  if (!base) return false;
  const key = `${path}\0${stat.mtimeMs}\0${stat.size}\0${base}`;
  if (unchanged.get(key)) return false;
  const done = await git(["diff", "--quiet", base, "--", path], dir);
  if (done.code === 1) return true;
  unchanged.set(key, true);
  return false;
}

/** Tools for one seat: `since` is when it started, a file written after it may be the seat's own; `baseOf` gives the commit the room first saw a repository at, whose later changes are the seats'. */
export function machineTools(since: () => number | null, baseOf?: (commonDir: string) => string | null): Tools {
  return {
    async ignored(paths) {
      const dir = paths.length ? existingDir(dirname(paths[0])) : null;
      if (!dir) return new Set();
      const done = await git(["check-ignore", "--", ...paths], dir);
      return new Set(done.out.split("\n").filter(Boolean));
    },
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
    stat(path) {
      try {
        const s = lstatSync(path);
        return { exists: true, link: s.isSymbolicLink(), dir: s.isDirectory() };
      } catch {
        return { exists: false, link: false, dir: false };
      }
    },
    rc: () => claudeRc(),
    folder(path) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    real(path) {
      try {
        return realpathSync.native(path);
      } catch {
        return null;
      }
    },
    program(word, cwd, path) {
      const spots = word.includes("/")
        ? [isAbsolute(word) || cwd ? resolve(cwd ?? "/", word) : null]
        : (path ?? process.env.PATH ?? "")
            .split(delimiter)
            .map((dir) => (isAbsolute(dir) ? join(dir, word) : cwd ? join(resolve(cwd, dir || "."), word) : null));
      for (const spot of spots) {
        if (!spot) continue;
        try {
          accessSync(spot, constants.X_OK);
          return realpathSync.native(spot);
        } catch {
          continue;
        }
      }
      return null;
    },
    file(path) {
      try {
        const s = statSync(path);
        return s.isFile() && s.size <= MAX_SCRIPT ? readFileSync(path, "utf8") : null;
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
        if (!written && !(await differsFromCommit(path, s)) && !(baseOf && (await differsFromBase(path, s, baseOf))))
          return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
}
