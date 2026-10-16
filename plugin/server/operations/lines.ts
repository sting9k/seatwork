/** How the room's log lines are read: the district a line is about, and whether it reports trouble, under what key. */

import settings from "../../shared/operations.json";

const DISTRICT = /^([a-z]+)(?::| )/;
const KNOWN = new Set([
  "mail",
  "budget",
  "work",
  "knowledge",
  "jev",
  "council",
  "gc",
  "guard",
  "fork",
  "spawn",
  "safety",
  "turn",
  "sqlite",
  "room",
]);
const TROUBLE =
  /\b(fail(?:ed|s|ure)?|not (?:kept|read|marked|expired|forgotten|told|logged|asked|settle)|could not|cannot|did not|damaged|refused|out of range|is down|slow|not checkpointed)\b/i;
const QUOTED = /(?<!\w)(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)(?!\w)/g;
const FAULT_WORD = /^[A-Za-z][A-Za-z_]{1,31}$/;
const VARYING = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g,
  /(?:~|\/)?[\w.@~-]*(?:\/[\w.@~-]+)+/g,
  /\b(?=[\w-]*\d)[\w-]{6,}\b/g,
  /\d+(?:\.\d+)?/g,
];
const KEY_CHARS = 160;

/** The district a line opens with, or `room` for a line that names none. */
export function districtOf(line: string): string {
  const word = DISTRICT.exec(line)?.[1];
  return word && KNOWN.has(word) ? (word === "fork" ? "jev" : word) : "room";
}

/** A quoted part as a key keeps it: a one-word fault such as a code or reason stays, an id, path, title or text is made alike. */
function quoted(part: string, double?: string, single?: string, backtick?: string): string {
  return FAULT_WORD.test(double ?? single ?? backtick ?? "") ? part : "*";
}

/** A line's incident key: its district and its words with ids, paths, times, numbers and quoted texts made alike; null when it reports no trouble. */
export function incidentOf(line: string): string | null {
  const text = line.slice(0, settings.lineChars);
  if (!TROUBLE.test(text)) return null;
  // one fault met by many seats, files or turns is one incident
  const plain = text.replace(QUOTED, quoted);
  const shape = VARYING.reduce((words, pattern) => words.replace(pattern, "*"), plain)
    .replace(/\s+/g, " ")
    .trim();
  return `${districtOf(text)}|${shape.slice(0, KEY_CHARS)}`;
}
