import { posix } from "node:path";
import table from "../../../../shared/safety/protected.json";
import { componentGlob, type GlobTest } from "../glob";
import { absolute, within } from "../paths";
import type { Scene, Value } from "../types";

/** The files a write must not reach (DCG's credential table), and the room's own files. */

type GuardRule = "credential-file-write" | "git-internals-write" | "git-config-write" | "room-file-write";

/** A protected path a write reaches, with the pack and rule that judge it. */
export interface Guarded {
  pack: "core.filesystem" | "room.guard";
  rule: GuardRule;
  path: string;
}

export type WriteMode = "write" | "append" | "remove";

const lower = (s: string) => s.toLowerCase();
const HOME_DIRS = table.homeDirs.map(lower);
const HOME_FILES = table.homeFiles.map(lower);
const ETC_DIRS = table.etcDirs.map(lower);
const ETC_FILES = table.etcFiles.map(lower);
const APPEND = table.append.map(lower);
const FREE = table.free.map(
  (glob) =>
    new RegExp(
      `^${lower(glob)
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")}$`,
    ),
);
const ANCHORS = table.anchors.map(lower);
const ANCHOR_FILES = table.anchorFiles.map(lower);
const ROOM_HOME_FILES = table.roomHomeFiles.map(lower);
const ROOM_FOLDER_OPEN = new Set(table.roomFolderOpen);
const ENV_ROOTS = table.envRoots as Record<string, string>;
const GIT_RUNS = table.gitRuns.map((pattern) => new RegExp(pattern));

/** The guard for a path with a `.git` folder in it: what git reads programs from is the room's, the rest of the repository is the owner's. */
function gitGuard(parts: string[], path: string): Guarded | null {
  const at = parts.findIndex((c) => lower(c) === ".git");
  if (at < 0) return null;
  const inside = lower(parts.slice(at + 1).join("/"));
  return GIT_RUNS.some((test) => test.test(inside))
    ? { pack: "room.guard", rule: "git-config-write", path }
    : { pack: "core.filesystem", rule: "git-internals-write", path };
}

/** What guards an absolute path, if anything. */
export function guardOfPath(path: string, mode: WriteMode, scene: Pick<Scene, "place">): Guarded | null {
  const place = scene.place;
  const norm = posix.normalize(path);
  const low = lower(norm);
  if (place.guard) {
    const exempt = place.guard.except.some((e) => within(norm, e));
    if (!exempt && place.guard.paths.some((g) => within(norm, g)))
      return { pack: "room.guard", rule: "room-file-write", path: norm };
  }
  const parts = norm.split("/").filter(Boolean);
  if (place.roomFolder && parts.includes(place.roomFolder)) {
    const open = parts.at(-2) === place.roomFolder && ROOM_FOLDER_OPEN.has(parts.at(-1)!);
    if (!open) return { pack: "room.guard", rule: "room-file-write", path: norm };
  }
  const git = gitGuard(parts, norm);
  if (git) return git;
  const home = lower(place.home);
  if (within(low, home)) {
    const rel = low.slice(home.length + 1);
    if (ROOM_HOME_FILES.includes(rel)) return { pack: "room.guard", rule: "room-file-write", path: norm };
    if (homeEntry(rel, mode)) return { pack: "core.filesystem", rule: "credential-file-write", path: norm };
  }
  for (const etc of ["/etc", "/private/etc"]) {
    if (!within(low, etc) || low === etc) continue;
    const rel = low.slice(etc.length + 1);
    if (ETC_FILES.includes(rel) || ETC_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`)))
      return { pack: "core.filesystem", rule: "credential-file-write", path: norm };
  }
  return null;
}

/** True for a path under home a write must not reach, bar the `free` ones and an append to the `append` ones. */
function homeEntry(rel: string, mode: WriteMode): boolean {
  if (FREE.some((free) => free.test(rel))) return false;
  if (mode === "append" && APPEND.includes(rel)) return false;
  return HOME_FILES.includes(rel) || HOME_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** A relative path that names a protected tree (`.ssh/x`, `.git/config`), read as under home. */
function anchored(rel: string, mode: WriteMode, scene: Pick<Scene, "place">): Guarded | null {
  const parts = rel
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter((c) => c && c !== ".");
  if (parts.length === 1 && ANCHOR_FILES.includes(lower(parts[0])))
    return guardOfPath(posix.join(scene.place.home, parts[0]), mode, scene);
  const at = parts.findIndex((c, i) => ANCHORS.includes(lower(c)) && i < parts.length - 1);
  if (at < 0) return null;
  if (lower(parts[at]) === ".git") return gitGuard(parts.slice(at), rel);
  return guardOfPath(posix.join(scene.place.home, ...parts.slice(at)), mode, scene);
}

/** What guards the path a word names; a pattern counts if any protected file could match. */
export function guardOf(value: Value, mode: WriteMode, scene: Pick<Scene, "place" | "cwd">): Guarded | null {
  let text = value.text;
  if (text === null) {
    const root = /^\$\{?([A-Z_][A-Z0-9_]*)\}?/.exec(value.word.raw);
    if (root && root[1] in ENV_ROOTS && value.prefix === "") {
      const rest = value.word.raw.slice(root[0].length);
      text = posix.join(scene.place.home, ENV_ROOTS[root[1]], rest.includes("$") ? "" : rest);
      return guardOfPath(text, mode, scene) ?? mayBe(text, mode, scene);
    }
    return mayBe(value.prefix, mode, scene, true);
  }
  if (value.glob || (!value.quoted && /\{[^}]*,/.test(text))) return mayBe(text, mode, scene);
  const path = absolute(value, scene.cwd);
  if (path) {
    const found = guardOfPath(path, mode, scene);
    if (found) return found;
  }
  if (!text.startsWith("/") && !text.startsWith("~")) return anchored(text, mode, scene);
  return text.startsWith("/") ? anchored(text, mode, scene) : null;
}

/** For a glob or a path cut short by a run-time part: the first protected entry it could reach. */
function mayBe(pattern: string, mode: WriteMode, scene: Pick<Scene, "place" | "cwd">, open = false): Guarded | null {
  if (!pattern) return null;
  const base = pattern.startsWith("/") ? pattern : scene.cwd ? posix.join(scene.cwd, pattern) : null;
  if (!base) return null;
  // a path that opens inside a folder the room lets seats write stays in it, as a seat's temporary folder
  const inside = (folder: string) => base.length > folder.length && within(base, folder) && !base.includes("..");
  if (open && scene.place.guard?.except.some(inside)) return null;
  for (const entry of entries(scene)) {
    if (mode === "append" && APPEND.some((a) => lower(entry.path).endsWith(`/${a}`))) continue;
    const reach = open
      ? lower(entry.path).startsWith(lower(base)) || within(lower(base), lower(entry.path))
      : reaches(base, entry.path, entry.dir);
    if (reach) return { ...entry.guard, path: pattern };
  }
  return null;
}

let entriesFor: { key: string; list: Entry[] } | null = null;

/** The protected paths for this home and room, made once per change of either. */
function entries(scene: Pick<Scene, "place">): Entry[] {
  const home = scene.place.home;
  const key = `${home}\0${scene.place.guard?.paths.join("\0") ?? ""}`;
  if (entriesFor?.key === key) return entriesFor.list;
  const credential = { pack: "core.filesystem" as const, rule: "credential-file-write" as const };
  const room = { pack: "room.guard" as const, rule: "room-file-write" as const };
  const list: Entry[] = [
    ...table.homeDirs.map((d) => ({ path: posix.join(home, d), dir: true, guard: credential })),
    ...table.homeFiles.map((f) => ({ path: posix.join(home, f), dir: false, guard: credential })),
    ...table.etcFiles.map((f) => ({ path: posix.join("/etc", f), dir: false, guard: credential })),
    ...table.etcDirs.map((d) => ({ path: posix.join("/etc", d), dir: true, guard: credential })),
    ...table.roomHomeFiles.map((f) => ({ path: posix.join(home, f), dir: false, guard: room })),
    ...(scene.place.guard?.paths ?? []).map((p) => ({ path: p, dir: true, guard: room })),
  ];
  entriesFor = { key, list };
  return list;
}

interface Entry {
  path: string;
  dir: boolean;
  guard: Omit<Guarded, "path">;
}

const tests = new Map<string, GlobTest>();
const TESTS_KEPT = 512;

/** True when a shell pattern can name the entry, or a path inside an entry folder. */
function reaches(pattern: string, entry: string, dir: boolean): boolean {
  const want = pattern.split("/").filter(Boolean);
  const have = entry.split("/").filter(Boolean);
  if (want.length < have.length || (!dir && want.length !== have.length)) return false;
  return have.every((name, i) => componentTest(want[i])(name));
}

/** The test for one path component, kept for the next call; the oldest is dropped past the limit. */
function componentTest(pattern: string): GlobTest {
  const kept = tests.get(pattern);
  if (kept) return kept;
  const test = componentGlob(pattern);
  if (tests.size >= TESTS_KEPT) tests.delete(tests.keys().next().value!);
  tests.set(pattern, test);
  return test;
}

/** The protected file a non-recursive rm names, for DCG's rm-protected-file. */
export function protectedTarget(value: Value, scene: Pick<Scene, "place" | "cwd">): string | null {
  return guardOf(value, "remove", scene)?.path ?? null;
}
