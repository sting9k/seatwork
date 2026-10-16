import { statSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../../git";
import { NOT_ROOM_FOLDER } from "../../paths";

/** What git says of a seat's folder: where its work tree starts, the commit a turn began on, the files it changed. */

const GIT_MS = 5000;
const MOST_FILES = 5000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  const ran = await runGit(cwd, args, { timeoutMs: GIT_MS, maxBytes: 8 * 1024 * 1024 });
  return ran.code === 0 ? ran.out : null;
}

/** Where a turn began: the work tree's top, its HEAD, and the hash of each file that already differed from it. */
export interface Snapshot {
  root: string;
  head: string;
  dirty: ReadonlyMap<string, string>;
}

/** The work tree's top and its HEAD, with what was already changed; null outside a repository or before its first commit. */
export async function snapshot(cwd: string): Promise<Snapshot | null> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel", "HEAD"]);
  const [root, head] = out?.trim().split("\n") ?? [];
  if (!root || !head) return null;
  const changed = await differing(root, head);
  return { root, head, dirty: changed ? await hashes(root, changed) : new Map() };
}

/** Every file that differs from `head` now, committed or not, and every new file git does not ignore, the room's folder aside. */
async function differing(root: string, head: string): Promise<string[] | null> {
  const [diff, untracked] = await Promise.all([
    git(root, ["diff", "--name-only", "-z", "--no-renames", head, "--", NOT_ROOM_FOLDER]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", NOT_ROOM_FOLDER]),
  ]);
  if (diff === null || untracked === null) return null;
  return [...new Set([...diff.split("\0"), ...untracked.split("\0")].filter(Boolean))].slice(0, MOST_FILES);
}

/** The content hash of each of these files that is there; none when git cannot say. */
async function hashes(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const there = paths.filter((path) => {
    try {
      return statSync(join(root, path)).isFile();
    } catch {
      return false;
    }
  });
  if (there.length === 0) return new Map();
  const out = await git(root, ["hash-object", "--", ...there]);
  const lines = out?.trim().split("\n") ?? [];
  return lines.length === there.length ? new Map(there.map((path, at) => [path, lines[at]])) : new Map();
}

/** The files a turn changed: what differs from its HEAD now, less what was already so and is still as it was. */
export async function changedSince(found: Snapshot): Promise<string[] | null> {
  const files = await differing(found.root, found.head);
  if (!files || found.dirty.size === 0) return files;
  const now = await hashes(
    found.root,
    files.filter((path) => found.dirty.has(path)),
  );
  return files.filter((path) => !found.dirty.has(path) || now.get(path) !== found.dirty.get(path));
}
