import { posix } from "node:path";
import table from "../../../shared/safety/places.json";
import { componentGlob, type GlobTest } from "./glob";
import { absolute, isTemp, tempPath, within } from "./paths";
import type { Known, Place, Value } from "./types";

/** Where a path lies for the guard's records: the room's own geography, from the seat's tree out to the machine. */

/** A place a file may lie in; null is one where nothing is lost (a temporary folder, a device that holds nothing). */
export type Where =
  "seat" | "built" | "git" | "room" | "startup" | "credentials" | "outside" | "system" | "device" | "unknown";

const lower = (s: string) => s.toLowerCase();
const STARTUP = table.startup.map(lower);
const CREDENTIALS = table.credentials.map(lower);
const OPEN = table.open.map((pattern) => componentPath(lower(pattern)));
const GIT_RUNS = table.gitRuns.map((pattern) => new RegExp(pattern));
const ROOM_FOLDER_OPEN = new Set(table.roomFolderOpen);
const ENV_ROOTS = table.envRoots as Record<string, string>;
const SYSTEM = table.system;
const DISK = /^\/dev\/(r?disk\d|sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|loop\d|md\d|dm-\d|mapper\/)/;
const GLOB = /[*?[]|[@!?*+]\(/;
const HOME_ROOT = /^\/(Users|home)\/[^/]+$/;

/** Each component of a home-relative pattern as a glob test. */
function componentPath(pattern: string): GlobTest[] {
  return pattern.split("/").map(componentGlob);
}

/** Whether a home-relative path is in a list: a file named by it, or anything under a folder of it. */
const listed = (list: readonly string[], rel: string) =>
  list.some((entry) => (entry.endsWith("/") ? `${rel}/`.startsWith(entry) : rel === entry));

/** Whether a home-relative path is one of the open names, which hold no key and run nothing. */
const open = (rel: string) => {
  const parts = rel.split("/");
  return OPEN.some((tests) => tests.length === parts.length && tests.every((test, i) => test(parts[i])));
};

/** The place of a path inside a `.git`: what git reads programs from, or where it names that place (a `.git` file), is startup; the rest is the repository's. */
function gitWhere(inside: string[]): Where {
  return GIT_RUNS.some((test) => test.test(lower(inside.join("/")))) ? "startup" : "git";
}

/** The place of an absolute path. */
export function whereOfPath(path: string, place: Place): Where | null {
  const norm = posix.normalize(path).replace(/(.)\/+$/, "$1");
  if (tempPath(norm) || (place.tmp !== null && norm !== place.tmp && within(norm, place.tmp))) return null;
  if (norm.startsWith("/dev/")) return DISK.test(norm) ? "device" : null;
  if (place.guard?.paths.some((g) => within(norm, g)) && !place.guard.except.some((e) => within(norm, e)))
    return "room";
  const parts = norm.split("/").filter(Boolean);
  if (place.roomFolder) {
    const at = parts.lastIndexOf(place.roomFolder);
    if (at >= 0 && !(at === parts.length - 2 && ROOM_FOLDER_OPEN.has(parts[at + 1]))) return "room";
  }
  const git = parts.findIndex((c) => lower(c) === ".git");
  if (git >= 0) return gitWhere(parts.slice(git + 1));
  const home = lower(place.home);
  const low = lower(norm);
  if (low !== home && within(low, home)) {
    const rel = low.slice(home.length + 1);
    if (listed(STARTUP, rel)) return "startup";
    if (listed(CREDENTIALS, rel) && !open(rel)) return "credentials";
  }
  if (parts.length <= 1 || low === home || HOME_ROOT.test(norm) || SYSTEM.some((root) => within(norm, root)))
    return "system";
  if ([place.project, place.start].some((root) => root !== null && within(norm, root))) return "seat";
  return "outside";
}

/** The place a word names: a path, a pattern, or a path cut short by a part known only at run time, at its worst. */
export function whereOf(value: Value, known: Known): Where | null {
  if (isTemp(value, known)) return null;
  const place = known.place;
  if (value.text === null) {
    const root = /^\$\{?([A-Z_][A-Z0-9_]*)\}?/.exec(value.word.raw);
    if (root && root[1] in ENV_ROOTS && value.prefix === "") {
      const rest = value.word.raw.slice(root[0].length);
      return wherePattern(posix.join(place.home, ENV_ROOTS[root[1]], rest.includes("$") ? "" : rest), true, place);
    }
    const base = absolute({ ...value, text: value.prefix }, known.cwd);
    if (!value.prefix || !base) return "unknown";
    return wherePattern(value.prefix.endsWith("/") ? `${base}/` : base, true, place);
  }
  const text = value.text;
  if (text.startsWith("~")) return text.includes("/") ? "outside" : "system";
  const path = absolute(value, known.cwd);
  const pattern = value.glob || (!value.quoted && /\{[^}]*,/.test(text));
  if (!path) return anchored(text) ?? "unknown";
  return pattern ? wherePattern(path, false, place) : whereOfPath(path, place);
}

/** Whether a word names everything in a folder: a glob that is only stars, or a path cut short right after a slash. */
export function namesAll(value: Value): boolean {
  if (value.text === null) return value.prefix.endsWith("/");
  return value.glob && /(^|\/)\*+\/?$/.test(value.text);
}

/** A relative path read where the folder is not known: a name that only lives in a home or a repository. */
function anchored(text: string): Where | null {
  const parts = text
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter((c) => c && c !== ".");
  const git = parts.findIndex((c) => lower(c) === ".git");
  if (git >= 0) return gitWhere(parts.slice(git + 1));
  const rel = lower(parts.join("/"));
  if (listed(STARTUP, rel)) return "startup";
  if (listed(CREDENTIALS, rel) && !open(rel) && rel.startsWith(".")) return "credentials";
  return null;
}

/** The worst place a pattern may name: a protected entry it may match, everything in a folder, or a name inside one. */
function wherePattern(pattern: string, cut: boolean, place: Place): Where | null {
  const parts = pattern.split("/").filter(Boolean);
  const wild = cut
    ? parts.length - (pattern.endsWith("/") ? 0 : 1)
    : parts.findIndex((c) => GLOB.test(c) || /\{[^}]*,/.test(c));
  if (wild < 0) return whereOfPath(pattern, place);
  const folder = `/${parts.slice(0, wild).join("/")}`;
  const all = cut ? pattern.endsWith("/") : /^\*+$/.test(parts[wild]);
  if (all && whereOfPath(folder, place) === "system") return "system";
  return protectedReach(pattern, cut, place) ?? whereOfPath(posix.join(folder, "\u0000"), place);
}

let entriesFor: { key: string; list: { path: string; where: Where }[] } | null = null;

/** The protected entries of this home and room: the room's folders, startup files, credentials. */
function entries(place: Place): { path: string; where: Where }[] {
  const key = `${place.home}\0${place.guard?.paths.join("\0") ?? ""}`;
  if (entriesFor?.key === key) return entriesFor.list;
  const under = (entry: string) => posix.join(place.home, entry);
  const list = [
    ...(place.guard?.paths ?? []).map((path) => ({ path: `${path}/`, where: "room" as const })),
    ...STARTUP.map((entry) => ({ path: under(entry), where: "startup" as const })),
    ...CREDENTIALS.map((entry) => ({ path: under(entry), where: "credentials" as const })),
  ];
  entriesFor = { key, list };
  return list;
}

const tests = new Map<string, GlobTest>();
const TESTS_KEPT = 512;

/** The protected place a pattern may name: an entry it can match, or one inside a folder it can match; `cut` when the pattern goes on with anything. */
function protectedReach(pattern: string, cut: boolean, place: Place): Where | null {
  const want = pattern.split("/").filter(Boolean);
  const kept = place.guard?.except.some((e) => within(pattern.replace(/\/+$/, ""), e)) ?? false;
  for (const entry of entries(place)) {
    if (kept && entry.where === "room") continue;
    const folder = entry.path.endsWith("/");
    const have = entry.path.split("/").filter(Boolean);
    const reach = cut
      ? lower(entry.path).startsWith(lower(pattern)) || within(lower(pattern), lower(entry.path.replace(/\/$/, "")))
      : want.length >= have.length &&
        (folder || want.length === have.length) &&
        have.every((name, i) => componentTest(want[i])(name));
    if (reach) return entry.where;
  }
  return null;
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

/** The place a path really leads to when a link on the way takes it somewhere else; null when no link does. */
export function throughLinks(path: string, real: (path: string) => string | null): string | null {
  const tail: string[] = [];
  let from = path;
  for (let step = 0; step < 64; step += 1) {
    const target = real(from);
    if (target !== null) {
      const resolved = posix.join(target, ...tail.reverse());
      return resolved === path ? null : resolved;
    }
    const parent = posix.dirname(from);
    if (parent === from) return null;
    tail.push(posix.basename(from));
    from = parent;
  }
  return null;
}
