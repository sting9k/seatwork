/** How the room's log lines are read: the district a line is about, and whether it reports trouble, under what key. */

const DISTRICT = /^([a-z]+)(?::| )/;
const KNOWN = new Set([
  "mail",
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
]);
const TROUBLE =
  /\b(fail(?:ed|s|ure)?|not (?:kept|read|marked|expired|forgotten|told|logged|asked|mailed again|settle)|could not|cannot|did not|damaged|refused|out of range|is down)\b/i;
const VARYING = [
  /"[^"]*"|'[^']*'|`[^`]*`/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g,
  /(?:~|\/)[\w.@~-]*(?:\/[\w.@~-]+)+/g,
  /\b(?=[\w-]*\d)[\w-]{6,}\b/g,
  /\d+(?:\.\d+)?/g,
];
const KEY_CHARS = 160;

/** The district a line opens with, or `room` for a line that names none. */
export function districtOf(line: string): string {
  const word = DISTRICT.exec(line)?.[1];
  return word && KNOWN.has(word) ? (word === "fork" ? "jev" : word) : "room";
}

/** A line's incident key: its district and its words with ids, paths, times and numbers made alike; null when it reports no trouble. */
export function incidentOf(line: string): string | null {
  if (!TROUBLE.test(line)) return null;
  // one fault met by many seats, files or turns is one incident
  const shape = VARYING.reduce((text, pattern) => text.replace(pattern, "*"), line)
    .replace(/\s+/g, " ")
    .trim();
  return `${districtOf(line)}|${shape.slice(0, KEY_CHARS)}`;
}
