import { runGit } from "../git";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import table from "../../shared/safety/handin.json";
import { evaluate, type GateConfig, type Tools } from "./gate/evaluate";
import type { Place } from "./gate/types";
import type { FindingRow, SafetyStore } from "./store";

/** The hand-in check: what a seat changed since it started, read for agents' mistakes. */

export type Level = "block" | "warn";

export interface Found {
  rule: string;
  level: Level;
  path: string;
  line: number;
  text: string;
  hint: string;
}

export interface HandIn {
  /** partial: the check could not finish, never read as clean */
  state: "clean" | "blocked" | "partial" | "empty";
  files: number;
  open: FindingRow[];
  acknowledged: FindingRow[];
  warnings: FindingRow[];
  why: string | null;
}

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
const ASSERTION =
  /\b(expect|assert\w*|should|require\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|XCTAssert\w*|assertThat|verify)\s*[(.]|^\s*assert\s/;
const SECRET_SHAPES =
  /(AKIA[0-9A-Z]{16}|\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const SECRET_NAME =
  /(secret|token|passw(or)?d|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)\w*["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i;
const PLACEHOLDER =
  /example|sample|dummy|placeholder|changeme|your[_-]|xxx|fake|test|<|\$\{|process\.env|os\.environ|getenv/i;

async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const ran = await runGit(cwd, args, { timeoutMs: GIT_MS, maxBytes: 64 << 20 });
  return { ok: ran.code === 0, out: ran.out };
}

interface Change {
  path: string;
  added: Map<number, string>;
  removed: string[];
  deleted: boolean;
}

/** The changes since a commit: tracked edits, and new files git does not ignore. */
async function changesSince(cwd: string, head: string): Promise<Change[] | string> {
  const diff = await git(
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "--no-renames", head, "--"],
    cwd,
  );
  if (!diff.ok) return `git diff from ${head.slice(0, 8)} failed`;
  const changes = new Map<string, Change>();
  let current: Change | null = null;
  let line = 0;
  for (const raw of diff.out.split("\n")) {
    const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (file) {
      current = { path: file[2], added: new Map(), removed: [], deleted: false };
      changes.set(current.path, current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("deleted file mode")) current.deleted = true;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) current.added.set(line++, raw.slice(1));
    else if (raw.startsWith("-")) current.removed.push(raw.slice(1));
  }
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (!untracked.ok) return "git ls-files failed";
  let bytes = diff.out.length;
  for (const path of untracked.out.split("\0").filter(Boolean)) {
    if (SKIP.some((p) => p.test(path))) continue;
    const full = join(cwd, path);
    try {
      const size = statSync(full).size;
      if (size > MAX_FILE) continue;
      // a new file is all added lines; inspectFile reads it once more for its mask
      bytes += size;
      if (bytes > MAX_BYTES) return `more than ${MAX_BYTES >> 20} MB changed`;
      const lines = readFileSync(full, "utf8").split("\n");
      changes.set(path, { path, added: new Map(lines.map((l, i) => [i + 1, l])), removed: [], deleted: false });
    } catch {
      continue;
    }
  }
  if (changes.size > MAX_FILES) return `more than ${MAX_FILES} files changed`;
  return [...changes.values()];
}

const CODE = 0;
const STRING = 1;
const COMMENT = 2;

/** For each character of a file: code, string or comment, by the language's own rules. */
function maskOf(language: string, text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  const paint = (from: number, to: number, kind: number) => {
    for (let k = from; k < Math.min(to, text.length); k += 1) if (text[k] !== "\n") out[k] = kind;
  };
  const hash = ["python", "ruby", "shell", "php"].includes(language);
  const slash = ["javascript", "go", "rust", "java", "c", "php"].includes(language);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (
      (hash && c === "#" && (language !== "shell" || i === 0 || /\s/.test(text[i - 1]))) ||
      (slash && text.startsWith("//", i))
    ) {
      const end = text.indexOf("\n", i);
      paint(i, end < 0 ? text.length : end, COMMENT);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (slash && text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      paint(i, end < 0 ? text.length : end + 2, COMMENT);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const triple =
      language === "python" || language === "java" ? ['"""', "'''"].find((q) => text.startsWith(q, i)) : undefined;
    if (triple) {
      const end = text.indexOf(triple, i + 3);
      paint(i, end < 0 ? text.length : end + 3, STRING);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && (language === "javascript" || language === "go"))) {
      if (c === "'" && language === "rust" && !/^'(\\.|[^\\'])'/.test(text.slice(i, i + 4))) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n"))
        j += text[j] === "\\" && c !== "`" ? 2 : 1;
      paint(i, j + 1, STRING);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** A line's code, comment and string parts, each with the rest turned to spaces. */
function views(line: string, mask: Uint8Array | null, from: number): Record<"code" | "comment" | "string", string> {
  if (!mask) return { code: line, comment: "", string: "" };
  const parts = [[], [], []] as string[][];
  for (let k = 0; k < line.length; k += 1) {
    const kind = mask[from + k] ?? CODE;
    for (let v = 0; v < 3; v += 1) parts[v].push(v === kind ? line[k] : " ");
  }
  return { code: parts[CODE].join(""), string: parts[STRING].join(""), comment: parts[COMMENT].join("") };
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
  gate: { place: Place; config: GateConfig; tools: Tools },
): Promise<HandIn> {
  const start = store.startOf(seat);
  const base = { files: 0, open: [], acknowledged: [], warnings: [] };
  if (!start) return { ...base, state: "partial", why: "the room has no record of where this seat started" };
  if (!start.start_head)
    return { ...base, state: "partial", why: `${start.cwd} was not a git repository when the seat started` };
  const changes = await changesSince(start.cwd, start.start_head);
  if (typeof changes === "string") return { ...base, state: "partial", why: changes };
  const found: Found[] = [];
  let files = 0;
  for (const change of changes) {
    if (SKIP.some((p) => p.test(change.path))) continue;
    files += 1;
    found.push(...(await inspectFile(change, start.cwd, gate)));
  }
  if (!files) return { ...base, state: "empty", why: null };
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
    files,
    open,
    acknowledged: rows.filter((r) => r.severity === "block" && r.ack),
    warnings: rows.filter((r) => r.severity === "warn"),
    why: null,
  };
}

async function inspectFile(
  change: Change,
  cwd: string,
  gate: { place: Place; config: GateConfig; tools: Tools },
): Promise<Found[]> {
  const out: Found[] = [];
  const path = change.path;
  const isTest = TESTS.some((p) => p.test(path));
  const ext = /\.[^./]+$/.exec(path)?.[0] ?? "";
  const language = EXTENSIONS.get(ext) ?? (/(^|\/)(Makefile|Dockerfile)$/.test(path) ? "shell" : null);
  if (change.deleted) {
    if (isTest)
      out.push({
        rule: "test-deleted",
        level: "block",
        path,
        line: 0,
        text: path,
        hint: "A test file was deleted; restore it or acknowledge why.",
      });
    return out;
  }
  const full = join(cwd, path);
  let text = "";
  try {
    if (existsSync(full) && statSync(full).size <= MAX_FILE) text = readFileSync(full, "utf8");
  } catch {
    text = "";
  }
  if (text.includes("\0")) return out;
  const lines = text.split("\n");
  const mask = language ? maskOf(language, text) : null;
  const offsets: number[] = [];
  for (let k = 0, at = 0; k < lines.length; k += 1) {
    offsets.push(at);
    at += lines[k].length + 1;
  }
  // the rules for this file's language and kind, chosen once rather than per line
  const rules = RULES.filter(
    (rule) =>
      (rule.languages.includes("*") || (language !== null && rule.languages.includes(language))) &&
      !(rule.files === "test" && !isTest) &&
      !(rule.files === "source" && isTest),
  );
  for (const [number, added] of change.added) {
    const at = offsets[number - 1];
    const seen = views(added, at === undefined ? null : mask, at ?? 0);
    for (const rule of rules) {
      const view = rule.in === "line" ? added : seen[rule.in];
      if (rule.test.test(view))
        out.push({ rule: rule.id, level: rule.level, path, line: number, text: added, hint: rule.hint });
    }
    const secret = SECRET_SHAPES.exec(added) ?? SECRET_NAME.exec(added);
    if (
      secret &&
      !PLACEHOLDER.test(secret[secret.length - 1] ?? secret[0]) &&
      (SECRET_SHAPES.test(added) || entropy(secret[secret.length - 1]) >= 3.5)
    )
      out.push({
        rule: "hardcoded-secret",
        level: "block",
        path,
        line: number,
        text: added.replace(secret[secret.length - 1] ?? secret[0], "***"),
        hint: "Read the secret from the environment or a secret manager.",
      });
  }
  if (isTest && language) {
    const asserts = (ls: Iterable<string>) => [...ls].filter((l) => ASSERTION.test(l)).length;
    const removed = asserts(change.removed);
    const added = asserts(change.added.values());
    if (removed > added && change.removed.length)
      out.push({
        rule: "assertions-removed",
        level: "block",
        path,
        line: 0,
        text: `${removed} assertions removed, ${added} added`,
        hint: "A test that checks less hides breakage; keep the assertions or acknowledge why they went.",
      });
  }
  out.push(...(await scriptCommands(change, path, text, cwd, gate)));
  return out;
}

/** Shell lines added to scripts and CI files, run through the guard. */
async function scriptCommands(
  change: Change,
  path: string,
  text: string,
  cwd: string,
  gate: { place: Place; config: GateConfig; tools: Tools },
): Promise<Found[]> {
  const commands: { line: number; command: string }[] = [];
  const base = path.split("/").pop()!;
  if (base === "package.json") {
    try {
      const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const [number, added] of change.added)
        for (const value of Object.values(scripts))
          if (typeof value === "string" && added.includes(JSON.stringify(value).slice(1, -1)))
            commands.push({ line: number, command: value });
    } catch {
      return [];
    }
  } else if (/^(Makefile|makefile|GNUmakefile)$|\.mk$/.test(base)) {
    for (const [number, added] of change.added)
      if (added.startsWith("\t")) commands.push({ line: number, command: added.trim().replace(/^[@-]+/, "") });
  } else if (/\.(sh|bash|zsh)$/.test(base)) {
    for (const [number, added] of change.added)
      if (added.trim() && !added.trim().startsWith("#")) commands.push({ line: number, command: added });
  } else if (/(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(path) || /(^|\/)\.gitlab-ci\.ya?ml$/.test(path)) {
    for (const [number, added] of change.added) {
      const run = /^\s*-?\s*(?:run|script):\s*(.+)$/.exec(added);
      if (run && !/^[|>]-?\s*$/.test(run[1])) commands.push({ line: number, command: run[1] });
      else if (/^\s{6,}\S/.test(added) && !/^\s*[\w-]+:/.test(added))
        commands.push({ line: number, command: added.trim() });
    }
  } else if (/^Dockerfile/.test(base)) {
    for (const [number, added] of change.added) {
      const run = /^\s*RUN\s+(.+)$/i.exec(added);
      if (run) commands.push({ line: number, command: run[1] });
    }
  }
  const out: Found[] = [];
  for (const { line, command } of commands) {
    const found = await evaluate(command, cwd, gate.place, gate.config, gate.tools);
    for (const f of found.findings) {
      if (f.severity === "low") continue;
      out.push({
        rule: "destructive-script",
        level: f.severity === "medium" ? "warn" : "block",
        path,
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
      `${result.acknowledged.length} finding(s) acknowledged by the seat: ${result.acknowledged.map((r) => `${r.rule} ${r.path}:${r.line} (${r.ack})`).join("; ")}`,
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
  const lines = result.open.map(
    (r) => `- ${r.fingerprint} ${r.rule} at ${r.path}${r.line ? `:${r.line}` : ""}: ${r.text}`,
  );
  return [
    `The room's hand-in check found ${result.open.length} problem(s) in what you changed since you started:`,
    ...lines,
    "Fix each one, or acknowledge it with seatwork_safety (action ack, the id, and why it must stay), then hand in again.",
  ].join("\n");
}
