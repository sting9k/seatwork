import { addressOf, type EntryKind } from "./record";
import type { Found } from "./store";

/** How the record is searched and packed: full-text queries, their fusion, and a task's evidence in a budget. */

const TOKEN = /[\p{L}\p{N}_]+/gu;
const MOST_TERMS = 12;
export const QUERY_CHARS = 4000;
const RRF_K = 60;
const STOPWORDS = new Set(
  (
    "a about after all also an and any are as at be been before both but by can could do does each every few for from " +
    "had has have if in into is it its may more most must no not of on only or other our own same shall should so some " +
    "such than that the their them then there these they this those to too use used uses using very was we were what " +
    "when where which while who will with without would you your"
  ).split(" "),
);

/** A seat's words as two FTS5 queries, every term and any term, each term quoted so none reads as an operator. */
export function ftsQueries(text: string): { all: string; any: string } | null {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const [word] of text.slice(0, QUERY_CHARS).matchAll(TOKEN)) {
    const key = word.toLowerCase();
    if (word.length > 1 && !seen.has(key)) {
      seen.add(key);
      words.push(word);
    }
  }
  // "the" or "use" in an any-query matches nearly every note: the words that tell notes apart are what is asked
  const telling = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  const terms = (telling.length ? telling : words).slice(0, MOST_TERMS);
  if (terms.length === 0) return null;
  const quoted = terms.map((term) => `"${term}"`);
  return { all: quoted.join(" "), any: quoted.join(" OR ") };
}

/** Several ranked lists as one, by reciprocal rank fusion: an entry high in many lists comes first. */
export function fuse<T extends { id: number }>(lists: readonly (readonly T[])[], limit: number): T[] {
  const scores = new Map<number, { item: T; score: number }>();
  for (const list of lists)
    list.forEach((item, rank) => {
      const held = scores.get(item.id) ?? { item, score: 0 };
      held.score += 1 / (RRF_K + rank + 1);
      scores.set(item.id, held);
    });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.item.id - b.item.id)
    .slice(0, limit)
    .map(({ item }) => item);
}

const WEIGHT: Record<EntryKind, number> = {
  owner: 1,
  mail: 0.9,
  prompt: 0.8,
  say: 0.6,
  change: 0.5,
  shell: 0.4,
  tool: 0.2,
  read: 0.1,
};
const FAILED_SHELL = 0.9;
const ITEM_CHARS = 400;

/** One entry of a pack, with how far it can be trusted. */
interface PackItem {
  address: string;
  kind: EntryKind;
  at: string;
  agent: string;
  trust: string;
  text: string;
}

/** A task's evidence fitted to a budget: what was used and what was left out, and why. */
interface Pack {
  task: string;
  budget: number;
  used: number;
  items: PackItem[];
  left: { budget: number; repeated: number };
}

/** How far an entry can be trusted: a failed command or turn, a mail by its signal, or a plain turn. */
function trustOf(found: Found): string {
  if (found.kind === "shell" && found.exitCode !== null && found.exitCode !== 0) return "failed command";
  if (found.source.kind === "mail") return found.source.outcome ? `mail ${found.source.outcome}` : "mail";
  if (found.source.outcome === "failed" || found.source.outcome === "canceled") return `turn ${found.source.outcome}`;
  return "turn";
}

/** A task's evidence by a fixed formula, kind weight times recency, fitted greedily to the budget and read in order. */
export function pack(task: string, found: readonly Found[], budget: number): Pack {
  const sources = [...new Set(found.map((item) => `${item.source.startedAt}\u0000${item.source.ref}`))].sort();
  const age = new Map(sources.map((key, index) => [key, sources.length > 1 ? index / (sources.length - 1) : 1]));
  const scored = found.map((item) => {
    const weight = item.kind === "shell" && trustOf(item) === "failed command" ? FAILED_SHELL : WEIGHT[item.kind];
    const recency = age.get(`${item.source.startedAt}\u0000${item.source.ref}`) ?? 0;
    return { item, score: weight * (0.5 + 0.5 * recency) };
  });
  scored.sort((a, b) => b.score - a.score || a.item.id - b.item.id);
  const seen = new Set<string>();
  const chosen: Found[] = [];
  const left = { budget: 0, repeated: 0 };
  let used = 0;
  for (const { item } of scored) {
    const text = item.text.length > ITEM_CHARS ? `${item.text.slice(0, ITEM_CHARS)}…` : item.text;
    if (seen.has(text)) {
      left.repeated += 1;
      continue;
    }
    if (used + text.length > budget) {
      left.budget += 1;
      continue;
    }
    seen.add(text);
    used += text.length;
    chosen.push({ ...item, text });
  }
  chosen.sort(
    (a, b) =>
      a.source.startedAt.localeCompare(b.source.startedAt) ||
      a.source.ref.localeCompare(b.source.ref) ||
      a.ordinal - b.ordinal,
  );
  return {
    task,
    budget,
    used,
    items: chosen.map((item) => ({
      address: addressOf(item.source.kind, item.source.ref, item.ordinal),
      kind: item.kind,
      at: item.source.startedAt,
      agent: item.source.agent,
      trust: trustOf(item),
      text: item.text,
    })),
    left,
  };
}
