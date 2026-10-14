import { runGit } from "../git";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import table from "../../shared/safety/handin.json";
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

/** The check's result for a seat; `partial` means it could not finish and is never read as clean. */
export interface HandIn {
  state: "clean" | "blocked" | "partial" | "empty";
  files: number;
  open: FindingRow[];
  acknowledged: FindingRow[];
  warnings: FindingRow[];
  why: string | null;
}

/** A rule of the table: a pattern read on one part of an added line (`in`) of the files of a language and kind. */
interface Rule {
  id: string;
  level: Level;
  languages: string[];
  in: "code" | "comment" | "string" | "line";
  files: "test" | "source" | "any";
  pattern: string;
  flags?: string;
  hint: string;
}

/** A file's changes since the start: its added lines with their numbers, its removed lines, whether it is gone. */
interface Change {
  path: string;
  added: [number, string][];
  removed: string[];
  deleted: boolean;
  text?: string;
}

type Gate = { place: Place; config: GateConfig; tools: Tools };
type Layer = "code" | "string" | "comment";

const RULES = (table.rules as Rule[]).map((r) => ({ ...r, test: new RegExp(r.pattern, r.flags ?? "") }));
const SKIP = table.skip.map((p) => new RegExp(p));
const TESTS = table.tests.map((p) => new RegExp(p));
const EXTENSIONS = new Map(
  Object.entries(table.languages as Record<string, string[]>).flatMap(([lang, exts]) =>
    exts.map((e) => [e, lang] as const),
  ),
);
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 2000;
const MAX_BYTES = 32 * 1024 * 1024;
const GIT_MS = 15_000;
const SHOWN = 20;
const ASSERTION =
  /\b(expect|assert\w*|should|require\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|XCTAssert\w*|assertThat|verify)\s*[(.]|^\s*assert\s/;
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

/** The tracked files' added and removed lines out of a unified diff with no context lines. */
function parseDiff(diff: string): Map<string, Change> {
  const changes = new Map<string, Change>();
  let current: Change | null = null;
  let inHunk = false;
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      // a path git still quotes does not match; its lines are dropped rather than given to the file before it
      const path = DIFF_HEADER.exec(raw)?.[2];
      current = path && !SKIP.some((p) => p.test(path)) ? { path, added: [], removed: [], deleted: false } : null;
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

/** The changes since a commit: tracked edits, and new files git does not ignore. */
async function changesSince(cwd: string, head: string): Promise<Change[] | string> {
  const diff = await git(
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
    ],
    cwd,
  );
  if (!diff.ok) return `git diff from ${head.slice(0, 8)} failed`;
  const changes = parseDiff(diff.out);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (!untracked.ok) return "git ls-files failed";
  let bytes = diff.out.length;
  for (const path of untracked.out.split("\0")) {
    if (!path || SKIP.some((p) => p.test(path))) continue;
    const file = readFile(join(cwd, path));
    if (!file) continue;
    bytes += file.size;
    if (bytes > MAX_BYTES) return `more than ${MAX_BYTES >> 20} MB changed`;
    // a binary file counts as a change but has no lines to read
    const lines = file.text.includes("\0") ? [] : file.text.split("\n");
    changes.set(path, { path, added: lines.map((l, i) => [i + 1, l]), removed: [], deleted: false, text: file.text });
  }
  if (changes.size > MAX_FILES) return `more than ${MAX_FILES} files changed`;
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
export async function inspectHandIn(seat: string, store: SafetyStore, gate: Gate): Promise<HandIn> {
  const start = store.startOf(seat);
  const base = { files: 0, open: [], acknowledged: [], warnings: [] };
  if (!start) return { ...base, state: "partial", why: "the room has no record of where this seat started" };
  if (!start.start_head)
    return { ...base, state: "partial", why: `${start.cwd} was not a git repository when the seat started` };
  const changes = await changesSince(start.cwd, start.start_head);
  if (typeof changes === "string") return { ...base, state: "partial", why: changes };
  const found: Found[] = [];
  for (const change of changes) for (const one of await inspectFile(change, start.cwd, gate)) found.push(one);
  if (!changes.length) return { ...base, state: "empty", why: null };
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
  return {
    state: open.length ? "blocked" : "clean",
    files: changes.length,
    open,
    acknowledged: rows.filter((r) => r.severity === "block" && r.ack),
    warnings: rows.filter((r) => r.severity === "warn"),
    why: null,
  };
}

/** The mistakes on one file's added lines, its deletion if it is a test, and the scripts it adds. */
async function inspectFile(change: Change, cwd: string, gate: Gate): Promise<Found[]> {
  const path = change.path;
  const isTest = TESTS.some((p) => p.test(path));
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
  const text = change.text ?? readFile(join(cwd, path))?.text ?? "";
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
      !(rule.files === "source" && isTest),
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
  const base = path.split("/").pop()!;
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
        hint: `${f.reason} (rule ${f.pack}:${f.rule}); a script runs this later where no guard checks it.`,
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
  if (result.acknowledged.length)
    parts.push(
      `${result.acknowledged.length} finding(s) acknowledged by the seat: ${result.acknowledged
        .slice(0, SHOWN)
        .map((r) => `${r.rule} ${r.path}:${r.line} (${r.ack})`)
        .join("; ")}`,
    );
  if (result.warnings.length)
    parts.push(
      `${result.warnings.length} note(s): ${result.warnings
        .slice(0, 8)
        .map((r) => `${r.rule} ${r.path}:${r.line}`)
        .join("; ")}`,
    );
  return parts.length ? `hand-in check over ${result.files} file(s): ${parts.join("; ")}` : null;
}

/** What a seat reads when its candidate comes back: each finding with its id, place and fix. */
export function handInReturn(result: HandIn): string {
  const lines = result.open
    .slice(0, SHOWN)
    .map((r) => `- ${r.fingerprint} ${r.rule} at ${r.path}${r.line ? `:${r.line}` : ""}: ${r.text}`);
  if (result.open.length > SHOWN) lines.push(`- and ${result.open.length - SHOWN} more`);
  return [
    `The room's hand-in check found ${result.open.length} problem(s) in what you changed since you started:`,
    ...lines,
    "Fix each one, or acknowledge it with seatwork_safety (action ack, the id, and why it must stay), then hand in again.",
  ].join("\n");
}
