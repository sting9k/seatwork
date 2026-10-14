import { runGit } from "../../git";

/** What git says of a seat's folder: where its work tree starts, the commit a turn began on, the files it changed. */

const GIT_MS = 5000;
const MOST_FILES = 5000;

async function git(cwd: string, args: string[]): Promise<string | null> {
  const ran = await runGit(cwd, args, { timeoutMs: GIT_MS, maxBytes: 8 * 1024 * 1024 });
  return ran.code === 0 ? ran.out : null;
}

export interface Snapshot {
  root: string;
  head: string;
}

/** The work tree's top and its HEAD; null outside a repository or before its first commit. */
export async function snapshot(cwd: string): Promise<Snapshot | null> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel", "HEAD"]);
  const [root, head] = out?.trim().split("\n") ?? [];
  return root && head ? { root, head } : null;
}

/** Every file that differs from `head` now, committed or not, and every new file git does not ignore. */
export async function changedSince(found: Snapshot): Promise<string[] | null> {
  const [diff, untracked] = await Promise.all([
    git(found.root, ["diff", "--name-only", "--no-renames", found.head]),
    git(found.root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (diff === null || untracked === null) return null;
  return [...new Set([...diff.split("\n"), ...untracked.split("\n")].filter(Boolean))].slice(0, MOST_FILES);
}
