import table from "../../../shared/safety/commands.json";
import { invocationOf } from "./normalize";
import { literal, type Pipeline } from "./shell";
import type { Scene, Severity } from "./types";

/** The named rules of shared/safety/commands.json, and the reading of the commands they name. */

interface Match {
  programs: string[];
  first?: string[];
  words?: string[][];
  flags?: string[];
  without?: string[];
  arg?: string;
  noArg?: string;
}

/** A named rule: how hard its finding is to undo, why it is kept, and the commands it holds for. */
interface NamedRule {
  severity: Severity;
  reason: string;
  match?: Match[];
}

const RULES = table.rules as Record<string, NamedRule>;
const DATA = table.data;
const INLINE = new Set(DATA.inline);
const PLAIN = new Set(DATA.plain);
const DROPS = DATA.drops.map((pattern) => new RegExp(pattern, "i"));

/** The named rule with this id, which must exist. */
export function namedRule(id: string): NamedRule {
  const rule = RULES[id];
  if (!rule) throw new Error(`safety: no rule ${id}`);
  return rule;
}

type WordTest = (word: string) => boolean;

/** A match block made ready once: lower-case word tests, compiled patterns. */
interface Ready {
  first?: WordTest;
  words?: WordTest[];
  flags?: WordTest[];
  without?: WordTest[];
  arg?: RegExp;
  noArg?: RegExp;
}

/** A test for a word among a set, where `word*` stands for a prefix. */
function oneOf(set: string[]): WordTest {
  const exact = new Set(set.filter((w) => !w.endsWith("*")).map((w) => w.toLowerCase()));
  const prefixes = set.filter((w) => w.endsWith("*")).map((w) => w.slice(0, -1).toLowerCase());
  return (word) => exact.has(word) || prefixes.some((p) => word.startsWith(p));
}

/** A test for one flag as a command may give it: a one-letter flag also in a cluster, a long one also with a value. */
function flagTest(flag: string): WordTest {
  if (/^-[A-Za-z0-9]$/.test(flag)) return (word) => /^-[A-Za-z0-9]+$/.test(word) && word.includes(flag[1]);
  return (word) => word === flag || word.startsWith(`${flag}=`);
}

function ready(match: Match): Ready {
  return {
    first: match.first && oneOf(match.first),
    words: match.words?.map(oneOf),
    flags: match.flags?.map(flagTest),
    without: match.without?.map(flagTest),
    arg: match.arg === undefined ? undefined : new RegExp(match.arg, "i"),
    noArg: match.noArg === undefined ? undefined : new RegExp(match.noArg, "i"),
  };
}

const READY = new Map<Match, Ready>();
const BY_PROGRAM = new Map<string, { id: string; match: Match }[]>();
const BY_PREFIX: { prefix: string; id: string; match: Match }[] = [];
for (const [id, rule] of Object.entries(RULES))
  for (const match of rule.match ?? []) {
    READY.set(match, ready(match));
    for (const program of match.programs) {
      if (program.endsWith("*")) BY_PREFIX.push({ prefix: program.slice(0, -1), id, match });
      else BY_PROGRAM.set(program, [...(BY_PROGRAM.get(program) ?? []), { id, match }]);
    }
  }

/** The programs a named rule reads, so a wrapper option the room cannot read is read on to them. */
export const NAMED_PROGRAMS: ReadonlySet<string> = new Set(BY_PROGRAM.keys());

/** True when a match block holds for the words of a command. */
function holds(m: Ready, texts: readonly (string | null)[]): boolean {
  const words = texts.filter((t): t is string => t !== null);
  const lower = words.map((w) => w.toLowerCase());
  if (m.first) {
    const first = lower.find((w) => !w.startsWith("-"));
    if (first === undefined || !m.first(first)) return false;
  }
  if (m.words) {
    let at = 0;
    for (const test of m.words) {
      while (at < lower.length && !test(lower[at])) at += 1;
      if (at >= lower.length) return false;
      at += 1;
    }
  }
  if (m.flags && !m.flags.some((test) => words.some(test))) return false;
  if (m.without?.some((test) => words.some(test))) return false;
  if (m.arg && !words.some((w) => m.arg!.test(w))) return false;
  if (m.noArg && words.some((w) => m.noArg!.test(w))) return false;
  return true;
}

/** The ids of the named rules whose match holds for a command. */
export function namedHits(scene: Pick<Scene, "call">): string[] {
  const name = scene.call.name;
  if (!name) return [];
  const entries = [...(BY_PROGRAM.get(name) ?? []), ...BY_PREFIX.filter((p) => name.startsWith(p.prefix))];
  if (!entries.length) return [];
  const texts = scene.call.args.map(literal);
  const out: string[] = [];
  for (const { id, match } of entries) if (!out.includes(id) && holds(READY.get(match)!, texts)) out.push(id);
  return out;
}

/** Whether a database client is given a statement that drops data: inline, as plain words, or on its input; `stdin` reads that input lazily. */
export function dropsData(scene: Pick<Scene, "call">, stdin: () => string | null | undefined): boolean {
  const name = scene.call.name ?? "";
  if (!DATA.clients.includes(name)) return false;
  const texts = scene.call.args.map(literal);
  const given: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const t = texts[i];
    if (t === null) continue;
    if (INLINE.has(t) && texts[i + 1] != null) given.push(texts[++i]!);
    else if (/^--(command|execute|eval)=/.test(t)) given.push(t.slice(t.indexOf("=") + 1));
    else if (!t.startsWith("-") && PLAIN.has(name)) given.push(t);
  }
  const statements = [...given, stdin() ?? ""].join("\n");
  if (!statements.trim()) return false;
  if (DROPS.some((test) => test.test(statements))) return true;
  return statements
    .split(";")
    .some(
      (st) => (/^\s*DELETE\s+FROM\b/i.test(st) || /^\s*UPDATE\b[\s\S]*\bSET\b/i.test(st)) && !/\bWHERE\b/i.test(st),
    );
}

/** Whether a pipeline feeds the keys a redis scan lists to a delete. */
export function deletesScannedKeys(pipeline: Pipeline): boolean {
  const calls = pipeline.commands.map((c) => (c.kind === "simple" ? invocationOf(c) : null));
  const scans = calls.some(
    (c) =>
      c &&
      /^(redis|valkey|keydb)-cli$/.test(c.name ?? "") &&
      c.args.some((w) => /^(--scan|keys)$/i.test(literal(w) ?? "")),
  );
  const deletes = calls.some(
    (c) => c?.name === "xargs" && c.args.some((w) => /^(del|unlink)$/i.test(literal(w) ?? "")),
  );
  return scans && deletes;
}
