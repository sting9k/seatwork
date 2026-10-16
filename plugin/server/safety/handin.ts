import { runGit } from "../git";
import { NOT_ROOM_FOLDER } from "../paths";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import table from "../../shared/safety/handin.json";
import type { Manager } from "./registry";
import { ASSERTION, gamingOf, type GamingEvidence } from "./council/gaming";
import { evaluate, type GateConfig, type Tools } from "./gate/evaluate";
import type { Place } from "./gate/types";
import type { FindingRow, SafetyStore } from "./store";

/** The hand-in check: what a seat changed since it started, read for agents' mistakes. */

type Level = "block" | "warn";

/** One mistake the check found on an added line, with the hint a seat reads. */
interface Found {
  rule: string;
  level: Level;
  path: string;
  line: number;
  text: string;
  hint: string;
}

/** The check's result for a seat; `partial` is never read as clean; `left`: findings past the most one pass keeps, by level; `gaming`: tests bent to pass; `related`: unchanged tests naming a change. */
export interface HandIn {
  state: "clean" | "blocked" | "partial" | "empty";
  files: number;
  open: FindingRow[];
  acknowledged: FindingRow[];
  warnings: FindingRow[];
  why: string | null;
  left?: Record<Level, number>;
  gaming?: GamingEvidence | null;
  related?: string[];
  tests?: TestCount;
  dependencies?: Dependency[];
}

/** The test lines a hand-in added and removed, in how many test files, beside how many changed source files. */
interface TestCount {
  added: number;
  removed: number;
  files: number;
  sources: number;
}

/** A dependency the hand-in adds to a manifest; `firstRelease` when its registry said. */
export interface Dependency {
  manager: Manager;
  name: string;
  firstRelease: string | null;
}

/** What the hand-in may ask outside the machine: a package's first release on its registry. */
export interface Lookups {
  firstRelease?: (manager: Manager, name: string) => Promise<string | null>;
}

/** A rule of the table: a pattern read on one part of an added line (`in`) of the files of a language and kind. */
interface Rule {
  id: string;
  level: Level;
  languages: string[];
  in: "code" | "comment" | "string" | "line";
  files: "test" | "source" | "any";
  path?: string;
  pattern: string;
  flags?: string;
  hint: string;
}

/** A file's changes since the start: its added lines with their numbers, its removed lines, whether it is gone; `path` is the work tree's own, `file` is where it is read. */
export interface Change {
  path: string;
  file: string;
  added: [number, string][];
  removed: string[];
  deleted: boolean;
  text?: string;
}

type Gate = { place: Place; config: GateConfig; tools: Tools };
type Layer = "code" | "string" | "comment";

const RULES = (table.rules as Rule[]).map((r) => ({
  ...r,
  test: new RegExp(r.pattern, r.flags ?? ""),
  where: r.path ? new RegExp(r.path) : null,
}));
const SKIP = table.skip.map((p) => new RegExp(p));
const TESTS = table.tests.map((p) => new RegExp(p));
export const isTestPath = (path: string): boolean => TESTS.some((p) => p.test(path));
const CHECK_CONFIG = table.checkConfig.map((p) => new RegExp(p));
const CHECK_KEYS = new RegExp(table.checkKeys);
const MANIFEST =
  /(^|\/)(package\.json|composer\.json|pom\.xml|(build|settings)\.gradle(\.kts)?|Gemfile|Package\.swift|go\.mod|Cargo\.toml|pyproject\.toml|Directory\.Packages\.props|requirements[^/]*\.(txt|in))$|\.(csproj|fsproj|vbproj)$/;
const LITERAL = /"(?:[^"\\\n]|\\.){2,}"|'(?:[^'\\\n]|\\.){2,}'|\b\d{3,}(?:\.\d+)?\b|\b\d+\.\d+\b/g;
const ASSERTIONS_MOST = 2000;
const DEPENDENCIES_MOST = 30;
const LOOKUPS_MOST = 10;
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const EXTENSIONS = new Map(
  Object.entries(table.languages as Record<string, string[]>).flatMap(([lang, exts]) =>
    exts.map((e) => [e, lang] as const),
  ),
);
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 2000;
const FINDINGS_MOST = 500;
const MAX_BYTES = 32 * 1024 * 1024;
const GIT_MS = 15_000;
const SHOWN = 20;
const RELATED_SOURCES = 30;
const RELATED_MOST = 50;
const GENERIC_STEMS = new Set([
  "index",
  "main",
  "mod",
  "lib",
  "init",
  "__init__",
  "types",
  "util",
  "utils",
  "helpers",
  "common",
  "config",
  "constants",
]);
const SECRET_SHAPES =
  /(AKIA[0-9A-Z]{16}|\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const SECRET_NAME =
  /(secret|token|passw(or)?d|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)\w*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i;
const PLACEHOLDER =
  /example|sample|dummy|placeholder|changeme|your[_-]|xxx|fake|test|<|\$\{|process\.env|os\.environ|getenv/i;
const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)/;

async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const ran = await runGit(cwd, args, { timeoutMs: GIT_MS, maxBytes: 64 << 20 });
  return { ok: ran.code === 0, out: ran.out };
}

/** A regular file small enough to read, as its text and size; null for a link, a device, a folder, a big file or one unreadable. */
function readFile(path: string): { text: string; size: number } | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    return { text: readFileSync(path, "utf8"), size: stat.size };
  } catch {
    return null;
  }
}

/** A change's file text, read once per pass; an untracked file brought its own, and "" stands for one that cannot be read. */
function textOf(change: Change): string {
  return (change.text ??= readFile(change.file)?.text ?? "");
}

/** The tracked files' added and removed lines out of a unified diff with no context lines; git names them from the work tree's top, `root`. */
function parseDiff(diff: string, root: string): Map<string, Change> {
  const changes = new Map<string, Change>();
  let current: Change | null = null;
  let inHunk = false;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // a path git still quotes does not match; its lines are dropped rather than given to the file before it
      const path = DIFF_HEADER.exec(raw)?.[2];
      current =
        path && !SKIP.some((p) => p.test(path))
          ? { path, file: join(root, path), added: [], removed: [], deleted: false }
          : null;
      if (current) changes.set(current.path, current);
      inHunk = false;
    } else if (!current) continue;
    else if (raw.startsWith("@@")) {
      const hunk = HUNK_HEADER.exec(raw);
      if (hunk) line = Number(hunk[1]);
      inHunk = true;
    } else if (!inHunk) {
      if (raw.startsWith("deleted file mode")) current.deleted = true;
    } else if (raw.startsWith("+")) current.added.push([line++, raw.slice(1)]);
    else if (raw.startsWith("-")) current.removed.push(raw.slice(1));
  }
  return changes;
}

/** The changes since a commit: tracked edits, and new files git does not ignore; every path is named from the work tree's top. */
export async function changesSince(cwd: string, head: string): Promise<Change[] | string> {
  const [diff, untracked, up] = await Promise.all([
    git(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-U0",
        "--no-renames",
        head,
        "--",
        NOT_ROOM_FOLDER,
      ],
      cwd,
    ),
    git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", NOT_ROOM_FOLDER], cwd),
    git(["rev-parse", "--show-cdup"], cwd),
  ]);
  if (!diff.ok) return `git diff from ${head.slice(0, 8)} failed`;
  if (!untracked.ok) return "git ls-files failed";
  if (!up.ok) return "git rev-parse failed";
  const root = resolve(cwd, up.out.trim());
  const changes = parseDiff(diff.out, root);
  const fresh = untracked.out.split("\0").filter((path) => path && !SKIP.some((p) => p.test(path)));
  if (changes.size + fresh.length > MAX_FILES) return `more than ${MAX_FILES} files changed`;
  let bytes = diff.out.length;
  for (const path of fresh) {
    const file = join(root, path);
    const read = readFile(file);
    if (!read) continue;
    bytes += read.size;
    if (bytes > MAX_BYTES) return `more than ${MAX_BYTES >> 20} MB changed`;
    // a binary file counts as a change but has no lines to read
    const lines = read.text.includes("\0") ? [] : read.text.replace(/\n$/, "").split("\n");
    changes.set(path, {
      path,
      file,
      added: lines.map((l, i) => [i + 1, l]),
      removed: [],
      deleted: false,
      text: read.text,
    });
  }
  return [...changes.values()];
}

const CODE = 0;
const STRING = 1;
const COMMENT = 2;
const HASH = 35;
const SLASH = 47;
const STAR = 42;
const DOUBLE = 34;
const SINGLE = 39;
const TICK = 96;
const TRIPLES = ['"""', "'''"];

/** For each character of a file: code, string or comment, by the language's own rules. */
function maskOf(language: string, text: string): Uint8Array {
  const length = text.length;
  const out = new Uint8Array(length);
  const paint = (from: number, to: number, kind: number): number => {
    out.fill(kind, from, Math.min(to, length));
    return to;
  };
  const hash = ["python", "ruby", "shell", "php"].includes(language);
  const slash = ["javascript", "go", "rust", "java", "c", "php"].includes(language);
  const triples = language === "python" || language === "java";
  const ticks = language === "javascript" || language === "go";
  let i = 0;
  while (i < length) {
    const c = text.charCodeAt(i);
    // only these five characters open a comment or a string
    if (c !== HASH && c !== SLASH && c !== DOUBLE && c !== SINGLE && c !== TICK) {
      i += 1;
      continue;
    }
    if (
      (hash && c === HASH && (language !== "shell" || i === 0 || /\s/.test(text[i - 1]))) ||
      (slash && c === SLASH && text.charCodeAt(i + 1) === SLASH)
    ) {
      const end = text.indexOf("\n", i);
      i = paint(i, end < 0 ? length : end, COMMENT);
      continue;
    }
    if (slash && c === SLASH && text.charCodeAt(i + 1) === STAR) {
      const end = text.indexOf("*/", i + 2);
      i = paint(i, end < 0 ? length : end + 2, COMMENT);
      continue;
    }
    const triple = triples ? TRIPLES.find((q) => text.startsWith(q, i)) : undefined;
    if (triple) {
      const end = text.indexOf(triple, i + 3);
      i = paint(i, end < 0 ? length : end + 3, STRING);
      continue;
    }
    if (c === DOUBLE || c === SINGLE || (c === TICK && ticks)) {
      if (c === SINGLE && language === "rust" && !/^'(\\.|[^\\'])'/.test(text.slice(i, i + 4))) {
        i += 1;
        continue;
      }
      const quote = text[i];
      let j = i + 1;
      while (j < length && text[j] !== quote && (c === TICK || text[j] !== "\n"))
        j += text[j] === "\\" && c !== TICK ? 2 : 1;
      i = paint(i, j + 1, STRING);
      continue;
    }
    i += 1;
  }
  return out;
}

/** The file's text with only its code, its strings or its comments kept and all else turned to spaces. */
function layerOf(text: string, mask: Uint8Array, layer: Layer): string {
  const kind = layer === "code" ? CODE : layer === "string" ? STRING : COMMENT;
  const units = new Uint16Array(text.length);
  for (let k = 0; k < units.length; k += 1) units[k] = mask[k] === kind ? text.charCodeAt(k) : 32;
  return Buffer.from(units.buffer, units.byteOffset, units.byteLength).toString("utf16le");
}

const fingerprint = (rule: string, path: string, text: string, ordinal: number) =>
  createHash("sha256")
    .update(`${rule}\0${path}\0${text.trim().replace(/\s+/g, " ")}\0${ordinal}`)
    .digest("hex")
    .slice(0, 12);

/** Reads what a seat changed since its starting commit and stores what it finds. */
export async function inspectHandIn(
  seat: string,
  store: SafetyStore,
  gate: Gate,
  lookups: Lookups = {},
): Promise<HandIn> {
  const start = store.startOf(seat);
  const base = { files: 0, open: [], acknowledged: [], warnings: [] };
  if (!start) return { ...base, state: "partial", why: "the room has no record of where this seat started" };
  if (!start.start_head)
    return { ...base, state: "partial", why: `${start.cwd} was not a git repository when the seat started` };
  const changes = await changesSince(start.cwd, start.start_head);
  if (typeof changes === "string") return { ...base, state: "partial", why: changes };
  store.noteHandIn(seat, digestOf(changes));
  if (!changes.length) return { ...base, state: "empty", why: null };
  const found: Found[] = [];
  const seen: Record<Level, number> = { block: 0, warn: 0 };
  let skipped = 0;
  const keep = (one: Found) => {
    if (one.rule === "test-skipped" || one.rule === "test-focused") skipped += 1;
    if ((seen[one.level] += 1) <= FINDINGS_MOST) found.push(one);
  };
  for (const change of changes) for (const one of await inspectFile(change, start.cwd, gate)) keep(one);
  for (const change of changes) checkConfigFindings(change).forEach(keep);
  answersInSource(changes).forEach(keep);
  const left: Record<Level, number> = {
    block: Math.max(0, seen.block - FINDINGS_MOST),
    warn: Math.max(0, seen.warn - FINDINGS_MOST),
  };
  const ordinals = new Map<string, number>();
  const rows = store.noteFindings(
    seat,
    found.map((f) => {
      const key = `${f.rule}\0${f.path}\0${f.text.trim()}`;
      const n = (ordinals.get(key) ?? 0) + 1;
      ordinals.set(key, n);
      return {
        fingerprint: fingerprint(f.rule, f.path, f.text, n),
        rule: f.rule,
        severity: f.level,
        path: f.path,
        line: f.line,
        text: `${f.text.trim()} :: ${f.hint}`,
      };
    }),
  );
  const open = rows.filter((r) => r.severity === "block" && !r.ack);
  const [related, dependencies] = await Promise.all([
    testsNaming(changes, start.cwd),
    newDependencies(changes, start.cwd, start.start_head, lookups),
  ]);
  return {
    state: open.length ? "blocked" : left.block ? "partial" : "clean",
    files: changes.length,
    open,
    acknowledged: rows.filter((r) => r.severity === "block" && r.ack),
    warnings: rows.filter((r) => r.severity === "warn"),
    why:
      open.length || !left.block
        ? null
        : `${left.block} blocking finding(s) past the first ${FINDINGS_MOST} were left out`,
    left,
    gaming: gamingOf(
      changes.map((change) => ({
        path: change.path,
        test: isTestPath(change.path),
        deleted: change.deleted,
        added: change.added.map(([, line]) => line),
        removed: change.removed,
      })),
      skipped,
    ),
    related,
    tests: testCount(changes),
    dependencies,
  };
}

/** The test lines the changes add and remove, and the source files beside them. */
function testCount(changes: readonly Change[]): TestCount {
  const count = { added: 0, removed: 0, files: 0, sources: 0 };
  for (const change of changes) {
    if (!isTestPath(change.path)) {
      if (
        EXTENSIONS.has(extname(change.path)) &&
        !MANIFEST.test(change.path) &&
        !CHECK_CONFIG.some((p) => p.test(change.path))
      )
        count.sources += 1;
      continue;
    }
    count.files += 1;
    count.added += change.added.length;
    count.removed += change.removed.length;
  }
  return count;
}

/** A change to what decides the checks: a runner, lint or CI file, or the check lines of a manifest. */
function checkConfigFindings(change: Change): Found[] {
  const hint = "This decides what the checks run or how strict they are; say in the report why it changed.";
  const at = (line: number, text: string): Found[] => [
    { rule: "check-config", level: "warn", path: change.path, line, text, hint },
  ];
  if (CHECK_CONFIG.some((p) => p.test(change.path))) return at(change.added[0]?.[0] ?? 0, change.path);
  if (!/(^|\/)(package\.json|pyproject\.toml)$/.test(change.path)) return [];
  const added = change.added.find(([, line]) => CHECK_KEYS.test(line));
  if (added) return at(added[0], added[1].trim());
  const removed = change.removed.find((line) => CHECK_KEYS.test(line));
  return removed ? at(0, removed.trim()) : [];
}

/** The literals of a line, quotes taken off, so `"2h"` and `'2h'` are one. */
const literalsOf = (line: string) => new Set((line.match(LITERAL) ?? []).map((one) => one.replace(/^["']|["']$/g, "")));

/** Added source lines that hold two literals of one assertion added in the same hand-in: its input and its answer. */
function answersInSource(changes: readonly Change[]): Found[] {
  const owners = new Map<string, number[]>();
  let assertions = 0;
  for (const change of changes) {
    if (!isTestPath(change.path)) continue;
    for (const [, line] of change.added) {
      if (!ASSERTION.test(line) || assertions >= ASSERTIONS_MOST) continue;
      const literals = literalsOf(line);
      if (literals.size < 2) continue;
      assertions += 1;
      for (const literal of literals) owners.set(literal, [...(owners.get(literal) ?? []), assertions]);
    }
  }
  if (owners.size === 0) return [];
  const out: Found[] = [];
  for (const change of changes) {
    if (isTestPath(change.path) || !EXTENSIONS.has(extname(change.path))) continue;
    for (const [line, text] of change.added) {
      const hits = new Map<number, number>();
      for (const literal of literalsOf(text))
        for (const owner of owners.get(literal) ?? []) hits.set(owner, (hits.get(owner) ?? 0) + 1);
      if ([...hits.values()].some((n) => n >= 2))
        out.push({
          rule: "test-answer-in-source",
          level: "warn",
          path: change.path,
          line,
          text,
          hint: "This line holds the input and the answer of a test added with it; compute the answer instead.",
        });
    }
  }
  return out;
}

/** The section a line of a TOML file sits in, by the last header above it. */
function sectionAt(text: string, line: number): string {
  const lines = text.split("\n").slice(0, line);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const header = /^\s*\[+([^\]]+)\]+/.exec(lines[i]);
    if (header) return header[1].trim();
  }
  return "";
}

/** The package a manifest line names, by the manifest's kind; null for any other line. */
function nameOn(path: string, text: string, line: number, added: string): { manager: Manager; name: string } | null {
  const base = basename(path);
  if (/^requirements[^/]*\.(txt|in)$/.test(base)) {
    const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(added)?.[1];
    return name ? { manager: "pypi", name: name.toLowerCase().replace(/_/g, "-") } : null;
  }
  if (/^build\.gradle(\.kts)?$/.test(base)) {
    const coordinate =
      /^\s*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|ksp)\s*\(?\s*["']([^"':\s]+):([^"':\s]+)/.exec(
        added,
      );
    return coordinate ? { manager: "maven", name: `${coordinate[1]}:${coordinate[2]}` } : null;
  }
  if (base === "Gemfile") {
    const name = /^\s*gem\s+["']([^"']+)["']/.exec(added)?.[1];
    return name ? { manager: "rubygems", name } : null;
  }
  if (/\.(csproj|fsproj|vbproj)$|^Directory\.Packages\.props$/.test(base)) {
    const name = /<Package(?:Reference|Version)\s+Include="([^"]+)"/.exec(added)?.[1];
    return name ? { manager: "nuget", name } : null;
  }
  if (base === "Package.swift") {
    const name = /\.package\(\s*(?:name:\s*"[^"]*",\s*)?url:\s*"([^"]+)"/.exec(added)?.[1];
    return name ? { manager: "swift", name } : null;
  }
  if (base === "go.mod") {
    const name = /^\s*(?:require\s+)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+)\s+v\d/.exec(added)?.[1];
    return name ? { manager: "go", name } : null;
  }
  if (base === "Cargo.toml") {
    const name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(added)?.[1];
    return name && /(^|\.)(dev-|build-)?dependencies$/.test(sectionAt(text, line)) ? { manager: "cargo", name } : null;
  }
  if (base === "pyproject.toml") {
    const section = sectionAt(text, line);
    const quoted = /^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~;@ ]|["'])/.exec(added)?.[1];
    const keyed = /dependencies/.test(section) ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(added)?.[1] : undefined;
    const name =
      (/^(project|project\.optional-dependencies|dependency-groups)$/.test(section) ? quoted : undefined) ?? keyed;
    return name && name !== "python" ? { manager: "pypi", name: name.toLowerCase().replace(/_/g, "-") } : null;
  }
  return null;
}

/** The dependency names of a JSON manifest's sections; empty for text that is not JSON. */
function jsonNames(text: string | null, sections: readonly string[]): Set<string> {
  try {
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return new Set(sections.flatMap((section) => Object.keys((json[section] as Record<string, unknown>) ?? {})));
  } catch {
    return new Set();
  }
}

/** The `group:artifact` of each dependency a pom.xml declares. */
function mavenNames(text: string | null): Set<string> {
  const names = new Set<string>();
  for (const [, block] of (text ?? "").matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block)?.[1];
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block)?.[1];
    if (group && artifact) names.add(`${group}:${artifact}`);
  }
  return names;
}

const WHOLE: Record<string, { manager: Manager; names: (text: string | null) => Set<string> }> = {
  "package.json": { manager: "npm", names: (text) => jsonNames(text, DEPENDENCY_SECTIONS) },
  "composer.json": {
    manager: "packagist",
    names: (text) => new Set([...jsonNames(text, ["require", "require-dev"])].filter((name) => name.includes("/"))),
  },
  "pom.xml": { manager: "maven", names: mavenNames },
};

/** The dependencies the changes add to manifests, each with its first release where its registry says. */
async function newDependencies(
  changes: readonly Change[],
  cwd: string,
  head: string,
  lookups: Lookups,
): Promise<Dependency[]> {
  const found: Omit<Dependency, "firstRelease">[] = [];
  for (const change of changes) {
    if (change.deleted || found.length >= DEPENDENCIES_MOST || !MANIFEST.test(change.path)) continue;
    const text = textOf(change);
    const whole = WHOLE[basename(change.path)];
    if (whole) {
      const before = await git(["show", `${head}:${change.path}`], cwd);
      const old = whole.names(before.ok ? before.out : null);
      for (const name of whole.names(text)) if (!old.has(name)) found.push({ manager: whole.manager, name });
      continue;
    }
    const gone = new Set(
      change.removed.map((removed) => nameOn(change.path, text, 0, removed)?.name).filter((name) => name),
    );
    for (const [line, added] of change.added) {
      const named = nameOn(change.path, text, line, added);
      if (named && !gone.has(named.name) && !found.some((one) => one.name === named.name)) found.push(named);
    }
  }
  const kept = found.slice(0, DEPENDENCIES_MOST);
  const dates = await Promise.all(
    kept.map((one, i) =>
      i < LOOKUPS_MOST && lookups.firstRelease ? lookups.firstRelease(one.manager, one.name).catch(() => null) : null,
    ),
  );
  return kept.map((one, i) => ({ ...one, firstRelease: dates[i] }));
}

/** One digest of a seat's changes, the same whatever order git lists them in. */
function digestOf(changes: readonly Change[]): string {
  const hash = createHash("sha256");
  for (const change of [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    hash.update(JSON.stringify([change.path, change.deleted, change.added, change.removed]));
  return hash.digest("hex");
}

/** The digest of a seat's work as it stands, against the commit it started on; null when the room cannot read it. */
export async function workDigest(seat: string, store: SafetyStore): Promise<string | null> {
  const start = store.startOf(seat);
  if (!start?.start_head) return null;
  const changes = await changesSince(start.cwd, start.start_head);
  return typeof changes === "string" ? null : digestOf(changes);
}

/** The unchanged tests that name a changed source file in their text or file name; a common name goes with its folder. */
async function testsNaming(changes: readonly Change[], cwd: string): Promise<string[]> {
  const names = new Set<string>();
  for (const change of changes) {
    if (isTestPath(change.path) || !EXTENSIONS.has(extname(change.path))) continue;
    const stem = basename(change.path, extname(change.path));
    names.add(GENERIC_STEMS.has(stem) || stem.length < 3 ? `${basename(dirname(change.path))}/${stem}` : stem);
    if (names.size >= RELATED_SOURCES) break;
  }
  if (!names.size) return [];
  const quiet = ["-c", "core.quotePath=false"];
  const [inText, files] = await Promise.all([
    git([...quiet, "grep", "--full-name", "-l", "-w", "-F", ...[...names].flatMap((name) => ["-e", name]), "--"], cwd),
    git([...quiet, "ls-files", "--full-name"], cwd),
  ]);
  const matchers = [...names].map((name) => ({
    word: new RegExp(`(^|[^A-Za-z0-9])${basename(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`),
    folder: name.includes("/") ? `${dirname(name)}/` : null,
  }));
  const byName = files.out
    .split("\n")
    .filter(isTestPath)
    .filter((path) =>
      matchers.some(({ word, folder }) => word.test(basename(path)) && (folder === null || path.includes(folder))),
    );
  const changed = new Set(changes.map((change) => change.path));
  return [...new Set([...inText.out.split("\n"), ...byName])]
    .filter((path) => path && isTestPath(path) && EXTENSIONS.has(extname(path)) && !changed.has(path))
    .sort()
    .slice(0, RELATED_MOST);
}

/** The mistakes on one file's added lines, its deletion if it is a test, and the scripts it adds. */
async function inspectFile(change: Change, cwd: string, gate: Gate): Promise<Found[]> {
  const path = change.path;
  const isTest = isTestPath(path);
  const ext = /\.[^./]+$/.exec(path)?.[0] ?? "";
  const language = EXTENSIONS.get(ext) ?? (/(^|\/)(Makefile|Dockerfile)$/.test(path) ? "shell" : null);
  if (change.deleted)
    return isTest
      ? [
          {
            rule: "test-deleted",
            level: "block",
            path,
            line: 0,
            text: path,
            hint: "A test file was deleted; restore it or acknowledge why.",
          },
        ]
      : [];
  const text = textOf(change);
  if (text.includes("\0")) return [];
  const out = lineFindings(change, text, language, isTest);
  if (isTest && language) out.push(...assertionsDropped(change));
  out.push(...(await scriptCommands(change, text, cwd, gate)));
  return out;
}

/** The start of each line of a text. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) out.push(at + 1);
  return out;
}

/** What the rules for a file's language and kind find on its added lines, and the secrets in them. */
function lineFindings(change: Change, text: string, language: string | null, isTest: boolean): Found[] {
  const path = change.path;
  const rules = RULES.filter(
    (rule) =>
      (rule.languages.includes("*") || (language !== null && rule.languages.includes(language))) &&
      !(rule.files === "test" && !isTest) &&
      !(rule.files === "source" && isTest) &&
      (rule.where === null || rule.where.test(path)),
  );
  const masked = language !== null && text.length > 0 && change.added.length > 0 && rules.some((r) => r.in !== "line");
  const mask = masked ? maskOf(language, text) : null;
  const starts = mask ? lineStarts(text) : [];
  const layers = new Map<Layer, string>();
  /** The part of an added line a rule reads; a line the file no longer holds is all code. */
  const viewOf = (part: Layer, number: number, added: string): string => {
    const at = starts[number - 1];
    if (!mask || at === undefined) return part === "code" ? added : "";
    let kept = layers.get(part);
    if (kept === undefined) layers.set(part, (kept = layerOf(text, mask, part)));
    return kept.slice(at, at + added.length);
  };
  const out: Found[] = [];
  for (const [number, added] of change.added) {
    for (const rule of rules) {
      const view = rule.in === "line" ? added : viewOf(rule.in, number, added);
      if (rule.test.test(view))
        out.push({ rule: rule.id, level: rule.level, path, line: number, text: added, hint: rule.hint });
    }
    const secret = SECRET_SHAPES.exec(added) ?? SECRET_NAME.exec(added);
    const value = secret?.[secret.length - 1] ?? secret?.[0];
    if (secret && value && !PLACEHOLDER.test(value) && (SECRET_SHAPES.test(added) || entropy(value) >= 3.5))
      out.push({
        rule: "hardcoded-secret",
        level: "block",
        path,
        line: number,
        text: added.replace(value, "***"),
        hint: "Read the secret from the environment or a secret manager.",
      });
  }
  return out;
}

/** A test file that lost more assertions than it gained. */
function assertionsDropped(change: Change): Found[] {
  if (!change.removed.length) return [];
  const removed = change.removed.filter((l) => ASSERTION.test(l)).length;
  const added = change.added.filter(([, l]) => ASSERTION.test(l)).length;
  if (removed <= added) return [];
  return [
    {
      rule: "assertions-removed",
      level: "block",
      path: change.path,
      line: 0,
      text: `${removed} assertions removed, ${added} added`,
      hint: "A test that checks less hides breakage; keep the assertions or acknowledge why they went.",
    },
  ];
}

/** The shell lines a change adds to a script or CI file, with their line numbers. */
function scriptLines(change: Change, text: string): { line: number; command: string }[] {
  const path = change.path;
  const base = basename(path);
  const commands: { line: number; command: string }[] = [];
  if (base === "package.json") {
    try {
      const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
      const needles = Object.values(scripts)
        .filter((value) => typeof value === "string")
        .map((value) => ({ value, needle: JSON.stringify(value).slice(1, -1) }));
      for (const [line, added] of change.added)
        for (const { value, needle } of needles) if (added.includes(needle)) commands.push({ line, command: value });
    } catch {
      return [];
    }
  } else if (/^(Makefile|makefile|GNUmakefile)$|\.mk$/.test(base)) {
    for (const [line, added] of change.added)
      if (added.startsWith("\t")) commands.push({ line, command: added.trim().replace(/^[@-]+/, "") });
  } else if (/\.(sh|bash|zsh)$/.test(base)) {
    for (const [line, added] of change.added)
      if (added.trim() && !added.trim().startsWith("#")) commands.push({ line, command: added });
  } else if (/(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(path) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(path)) {
    for (const [line, added] of change.added) {
      const run = /^\s*-?\s*(?:run|script):\s*(.+)$/.exec(added);
      if (run && !/^[|>]-?\s*$/.test(run[1])) commands.push({ line, command: run[1] });
      else if (/^\s{6,}\S/.test(added) && !/^\s*[\w-]+:/.test(added)) commands.push({ line, command: added.trim() });
    }
  } else if (/^Dockerfile/.test(base)) {
    for (const [line, added] of change.added) {
      const run = /^\s*RUN\s+(.+)$/i.exec(added);
      if (run) commands.push({ line, command: run[1] });
    }
  }
  return commands;
}

/** Shell lines added to scripts and CI files, run through the guard. */
async function scriptCommands(change: Change, text: string, cwd: string, gate: Gate): Promise<Found[]> {
  const out: Found[] = [];
  const read = new Map<string, Awaited<ReturnType<typeof evaluate>>>();
  for (const { line, command } of scriptLines(change, text)) {
    let found = read.get(command);
    if (!found) read.set(command, (found = await evaluate(command, cwd, gate.place, gate.config, gate.tools)));
    for (const f of found.findings) {
      if (f.severity === "low") continue;
      out.push({
        rule: "destructive-script",
        level: f.severity === "medium" ? "warn" : "block",
        path: change.path,
        line,
        text: command,
        hint: `${f.reason} (rule ${f.pack}:${f.rule}); a script runs this later, with nobody watching.`,
      });
    }
  }
  return out;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** The room's line about a check, under the candidate as it goes up. */
export function handInLine(result: HandIn): string | null {
  if (result.state === "partial") return `hand-in check incomplete: ${result.why}; not verified`;
  if (result.state === "empty") return "hand-in check: no change found since this seat started";
  const parts: string[] = [];
  if (result.open.length)
    parts.push(
      `${result.open.length} blocking finding(s) not acknowledged${result.left?.block ? ` and ${result.left.block} more left out` : ""}: ${result.open
        .slice(0, SHOWN)
        .map((r) => `${r.rule} ${r.path}:${r.line}`)
        .join("; ")}`,
    );
  if (result.acknowledged.length)
    parts.push(
      `${result.acknowledged.length} finding(s) acknowledged by the seat: ${result.acknowledged
        .slice(0, SHOWN)
        .map((r) => `${r.rule} ${r.path}:${r.line} (${r.ack})`)
        .join("; ")}`,
    );
  const tests = result.tests;
  if (tests?.files) parts.push(`tests: +${tests.added}/-${tests.removed} lines in ${tests.files} file(s)`);
  else if (tests?.sources) parts.push(`tests: none changed beside ${tests.sources} source file(s)`);
  if (result.dependencies?.length)
    parts.push(
      `new dependencies: ${result.dependencies
        .slice(0, 8)
        .map((one) => dependencyLine(one))
        .join(", ")}`,
    );
  if (result.related?.length)
    parts.push(
      `${result.related.length} unchanged test(s) name what changed: ${result.related.slice(0, 8).join(", ")}${result.related.length > 8 ? ", …" : ""}`,
    );
  if (result.warnings.length)
    parts.push(
      `${result.warnings.length} note(s)${result.left?.warn ? ` and ${result.left.warn} more left out` : ""}: ${result.warnings
        .slice(0, 8)
        .map((r) => `${r.rule} ${r.path}:${r.line}`)
        .join("; ")}`,
    );
  return parts.length ? `hand-in check over ${result.files} file(s): ${parts.join("; ")}` : null;
}

/** A new dependency as the hand-in line names it: its manager and, where the registry said, how old it is. */
function dependencyLine(one: Dependency): string {
  if (!one.firstRelease) return `${one.name} (${one.manager})`;
  const days = Math.floor((Date.now() - Date.parse(one.firstRelease)) / 86_400_000);
  return `${one.name} (${one.manager}, first published ${one.firstRelease.slice(0, 10)}, ${days} day(s) ago)`;
}

/** What a seat reads when its candidate comes back: each finding with its id, place and fix. */
export function handInReturn(result: HandIn): string {
  const lines = result.open
    .slice(0, SHOWN)
    .map((r) => `- ${r.fingerprint} ${r.rule} at ${r.path}${r.line ? `:${r.line}` : ""}: ${r.text}`);
  const total = result.open.length + (result.left?.block ?? 0);
  if (total > SHOWN) lines.push(`- and ${total - SHOWN} more`);
  return [
    `The room's hand-in check found ${total} problem(s) in what you changed since you started:`,
    ...lines,
    "Fix each one, or acknowledge it with seatwork_safety (action ack, the id, and why it must stay), then hand in again.",
  ].join("\n");
}
