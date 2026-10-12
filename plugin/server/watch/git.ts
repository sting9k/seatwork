import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** What git knows of a working tree at one moment: enough to say afterwards which files a turn changed. */
export interface TreeSnapshot {
  root: string;
  head: string;
  dirty: Map<string, string>;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

export async function snapshot(cwd: string): Promise<TreeSnapshot | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel", "HEAD"]);
  const status = top ? await git(cwd, ["status", "--porcelain=v1", "-z", "-uall"]) : null;
  if (!top || status === null) return null;
  const [root, head] = top.trim().split("\n");
  const dirty = new Map<string, string>();
  const records = status.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i];
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    // a rename is followed by its old path as a record of its own
    if (entry[0] === "R" || entry[0] === "C") i += 1;
    dirty.set(path, stamp(join(root, path)));
  }
  return { root, head: head ?? "", dirty };
}

function stamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "gone";
  }
}

/** Files that changed between two snapshots of one tree: the dirty set's differences plus new commits. */
export async function changedBetween(before: TreeSnapshot, after: TreeSnapshot): Promise<string[]> {
  const changed = new Set<string>();
  for (const [path, mark] of after.dirty) if (before.dirty.get(path) !== mark) changed.add(path);
  for (const path of before.dirty.keys()) if (!after.dirty.has(path)) changed.add(path);
  if (before.head !== after.head) {
    const committed = await git(after.root, ["diff", "--name-only", "-z", before.head, after.head]);
    for (const path of committed?.split("\0") ?? []) if (path) changed.add(path);
  }
  return [...changed].sort();
}
