import council from "../../../shared/safety/council.json";
import { redact } from "../../redact";

/** What a hand-in's diff shows of tests bent to pass: assertions dropped or loosened, expected values changed to fit, tests skipped or deleted, beside changed code. */

export const ASSERTION =
  /\b(expect|assert\w*|should|require\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|XCTAssert\w*|assertThat|verify)\s*[(.]|^\s*assert\s/;

const WEAK = council.members.gaming.weak.map((pattern) => new RegExp(pattern));
const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b/g;
const EXCERPT_CHARS = council.members.gaming.excerptChars;
const SHAPE_CHARS = 500;
const LINES_PER_FILE = 12;
const SOURCE_SHOWN = 20;

/** One file of the diff: whether it is a test, its added and removed lines, whether it is gone. */
export interface GamingFile {
  path: string;
  test: boolean;
  deleted: boolean;
  added: readonly string[];
  removed: readonly string[];
}

/** The signs of tests bent to pass in one diff; `excerpt` is the lines a juror and the chair read, secrets hidden. */
export interface GamingEvidence {
  testFiles: number;
  sourceCount: number;
  sourceFiles: string[];
  dropped: number;
  changed: number;
  loosened: number;
  skipped: number;
  deleted: number;
  excerpt: string;
}

/** An assertion with its literals taken out, so two that differ only in an expected value read alike. */
const shapeOf = (line: string): string => line.slice(0, SHAPE_CHARS).replace(LITERAL, "#").replace(/\s+/g, " ").trim();

/** How many removed assertions came back with only a literal changed, each removed line paired once; a line removed and added as it was only moved. */
function expectedChanged(removed: readonly string[], added: readonly string[]): number {
  const left = new Map<string, number>();
  for (const line of removed) left.set(line.trim(), (left.get(line.trim()) ?? 0) + 1);
  const fresh: string[] = [];
  for (const line of added) {
    const same = left.get(line.trim()) ?? 0;
    if (same > 0) left.set(line.trim(), same - 1);
    else fresh.push(line);
  }
  const shapes = new Map<string, number>();
  for (const [line, count] of left) if (count > 0) shapes.set(shapeOf(line), (shapes.get(shapeOf(line)) ?? 0) + count);
  let paired = 0;
  for (const line of fresh) {
    const open = shapes.get(shapeOf(line)) ?? 0;
    if (open > 0) {
      shapes.set(shapeOf(line), open - 1);
      paired += 1;
    }
  }
  return paired;
}

/** The signs in a diff's files, the excerpt stopping at its limit while the signs keep counting; `skipped` is how many skipped or focused tests the hand-in check found. Null when no test file changed. */
export function gamingOf(files: readonly GamingFile[], skipped: number): GamingEvidence | null {
  const evidence: GamingEvidence = {
    testFiles: 0,
    sourceCount: 0,
    sourceFiles: [],
    dropped: 0,
    changed: 0,
    loosened: 0,
    skipped,
    deleted: 0,
    excerpt: "",
  };
  const lines: string[] = [];
  let used = 0;
  const add = (...more: string[]) => {
    for (const line of more) {
      if (used >= EXCERPT_CHARS) return;
      lines.push(line);
      used += line.length + 1;
    }
  };
  for (const file of files) {
    if (!file.test) {
      if (file.deleted || file.added.length || file.removed.length) {
        evidence.sourceCount += 1;
        if (evidence.sourceFiles.length < SOURCE_SHOWN) evidence.sourceFiles.push(file.path);
      }
      continue;
    }
    evidence.testFiles += 1;
    if (file.deleted) {
      evidence.deleted += 1;
      add(`${file.path}: deleted`);
      continue;
    }
    const removed = file.removed.filter((line) => ASSERTION.test(line));
    const added = file.added.filter((line) => ASSERTION.test(line));
    evidence.dropped += Math.max(0, removed.length - added.length);
    evidence.changed += expectedChanged(removed, added);
    if (removed.length)
      evidence.loosened += Math.min(removed.length, added.filter((l) => WEAK.some((w) => w.test(l))).length);
    if (used < EXCERPT_CHARS && (removed.length || added.length))
      add(
        `${file.path}:`,
        ...removed.slice(0, LINES_PER_FILE).map((line) => `- ${line.trim().slice(0, 200)}`),
        ...added.slice(0, LINES_PER_FILE).map((line) => `+ ${line.trim().slice(0, 200)}`),
      );
  }
  if (evidence.testFiles === 0) return null;
  evidence.excerpt = redact(lines.join("\n")).slice(0, EXCERPT_CHARS);
  return evidence;
}

/** Whether the signs are firm enough to speak without a juror: a skipped or deleted test, or assertions gone. */
export const hardSigns = (evidence: GamingEvidence): number => evidence.skipped + evidence.deleted + evidence.dropped;

/** The signs a juror must read: an expected value changed, an assertion loosened. */
export const softSigns = (evidence: GamingEvidence): number => evidence.changed + evidence.loosened;

/** The finding's words: which signs, beside how many changed code files. */
export function gamingLine(evidence: GamingEvidence): string {
  const signs = [
    [evidence.dropped, "assertion(s) removed"],
    [evidence.changed, "expected value(s) changed to fit"],
    [evidence.loosened, "assertion(s) loosened"],
    [evidence.skipped, "test(s) skipped"],
    [evidence.deleted, "test file(s) deleted"],
  ]
    .filter(([count]) => count)
    .map(([count, what]) => `${count} ${what}`);
  return `gaming: tests were bent while ${evidence.sourceCount} code file(s) changed: ${signs.join(", ")}`;
}
