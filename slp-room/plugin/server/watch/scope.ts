import { tmpdir } from "node:os";
import { isAbsolute, normalize, relative, sep } from "node:path";
import { CLAUDE_HOME, CODEX_HOME, OPENCODE_CONFIG_HOME, PASEO_HOME, PI_HOME, ROOM_HOME } from "../paths";

/**
 * Where a seat may write, from the `Write scope:` line of its brief. The line is prose, so matching is lenient:
 * a path is outside only when no reading of the line admits it.
 */

export interface WriteScope {
  /** The brief says the tree stays as it was found. */
  readOnly: boolean;
  /** Globs relative to the project root. */
  patterns: string[];
}

/** `{a,b}` alternatives one pattern may expand to before the rest is ignored. */
const MAX_ALTERNATIVES = 64;

/** Null when the line names no path ("the whole repository"): no scope then means no scope finding. */
export function parseWriteScope(line: string, root: string): WriteScope | null {
  if (/\bread[- ]only\b/i.test(line)) return { readOnly: true, patterns: [] };
  const patterns = line
    .split(/[\s,;]+|\band\b/)
    .map((word) => word.replace(/^[`'"(<\[]+|[`'")>\].,:;]+$/g, ""))
    .filter((word) => /^[\w.@~+\-/*?{}\[\],]+$/.test(word) && /[/.*]/.test(word) && /[A-Za-z0-9]/.test(word))
    .map((word) => toPattern(word, root))
    .filter((word): word is string => word !== null);
  return patterns.length > 0 ? { readOnly: false, patterns: [...new Set(patterns)] } : null;
}

function toPattern(word: string, root: string): string | null {
  let pattern = word;
  if (isAbsolute(pattern)) {
    const rel = relative(root, pattern);
    if (rel.startsWith("..")) return null;
    pattern = rel;
  }
  pattern = pattern.split(sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  return pattern === "" || pattern === "." ? "**" : pattern;
}

export function inScope(scope: WriteScope, path: string): boolean {
  if (scope.readOnly) return false;
  return scope.patterns.some((pattern) => matchesPattern(pattern, path));
}

/** Besides the glob itself: a directory covers what is in it, and a pattern without a slash matches at any depth. */
export function matchesPattern(pattern: string, path: string): boolean {
  for (const alternative of expandBraces(pattern)) {
    if (matchGlob(alternative, path)) return true;
    if (!/[*?\[]/.test(alternative) && path.startsWith(`${alternative}/`)) return true;
    if (!alternative.includes("/") && matchGlob(`**/${alternative}`, path)) return true;
  }
  return false;
}

/** `src/{web,server}/**` → `src/web/**`, `src/server/**`. Nested braces expand too. */
export function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  const queue = [pattern];
  while (queue.length > 0 && out.length < MAX_ALTERNATIVES) {
    const current = queue.pop()!;
    const open = current.indexOf("{");
    const close = open < 0 ? -1 : matchingBrace(current, open);
    if (close < 0) {
      out.push(current);
      continue;
    }
    for (const option of splitTopLevel(current.slice(open + 1, close))) queue.push(current.slice(0, open) + option + current.slice(close + 1));
  }
  return out;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && (depth -= 1) === 0) return i;
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Glob over path segments: `**` spans whole segments, `*` and `?` stay inside one. A table over
 * (pattern segment, path segment) keeps `a/**\/b/**\/c` from going exponential.
 */
export function matchGlob(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  // reach[j]: the pattern segments read so far can match the first j path segments
  let reach = new Array<boolean>(s.length + 1).fill(false);
  reach[0] = true;
  for (const segment of p) {
    const next = new Array<boolean>(s.length + 1).fill(false);
    if (segment === "**") {
      let open = false;
      for (let j = 0; j <= s.length; j += 1) {
        open = open || reach[j];
        next[j] = open;
      }
    } else {
      for (let j = 0; j < s.length; j += 1) next[j + 1] = reach[j] && matchSegment(segment, s[j]);
    }
    reach = next;
  }
  return reach[s.length];
}

/** `*`, `?` and `[...]` inside one path segment, by the two-pointer walk that backs up to the last `*`. */
export function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const width = p < pattern.length ? matchOne(pattern, p, text[t]) : 0;
    if (width > 0) {
      p += width;
      t += 1;
    } else if (pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** How many pattern characters at `p` match the single character `c`: 0 for none or for a `*`. */
function matchOne(pattern: string, p: number, c: string): number {
  const head = pattern[p];
  if (head === "*") return 0;
  if (head === "?") return 1;
  if (head === "[") {
    const close = pattern.indexOf("]", p + 2);
    if (close > 0) {
      const negated = pattern[p + 1] === "!" || pattern[p + 1] === "^";
      const set = pattern.slice(p + (negated ? 2 : 1), close);
      return inClass(set, c) !== negated ? close - p + 1 : 0;
    }
  }
  return head === c ? 1 : 0;
}

function inClass(set: string, c: string): boolean {
  for (let i = 0; i < set.length; i += 1) {
    if (set[i + 1] === "-" && i + 2 < set.length) {
      if (set[i] <= c && c <= set[i + 2]) return true;
      i += 2;
    } else if (set[i] === c) return true;
  }
  return false;
}

/* ---------- what kind of file a path is ---------- */

/**
 * source: code and configuration, a change makes earlier checks stale. doc: prose. generated: rebuilt from source.
 * room: notes under .slp/. vcs: git's own files. scratch: temporary files and harness homes. outside: the rest outside the root.
 */
export type PathKind = "source" | "doc" | "generated" | "room" | "vcs" | "scratch" | "outside";

const GENERATED = /^(?:.*\/)?(?:node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.gradle|\.tox)(?:\/|$)/;
const DOC = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
const SCRATCH_ROOTS = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders", "/dev", CLAUDE_HOME, CODEX_HOME, PI_HOME, OPENCODE_CONFIG_HOME, PASEO_HOME, ROOM_HOME])].map((dir) => normalize(dir));

/** A path relative to the project root with POSIX separators, or null when it lies outside the root. */
export function relativeToRoot(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export function pathKind(root: string, path: string): PathKind {
  const rel = relativeToRoot(root, path);
  if (rel === null) return SCRATCH_ROOTS.some((dir) => path === dir || path.startsWith(`${dir}/`)) ? "scratch" : "outside";
  if (rel === ".git" || rel.startsWith(".git/")) return "vcs";
  if (rel === ".slp" || rel.startsWith(".slp/")) return "room";
  if (GENERATED.test(rel)) return "generated";
  return DOC.test(rel) ? "doc" : "source";
}
