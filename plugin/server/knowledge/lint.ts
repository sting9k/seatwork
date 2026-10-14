import { notEnglish } from "../english";
import { hasSecret } from "../redact";

/** What the district refuses in what a seat writes: a sentence not English, too short or long, with a secret, a relative date or a rule turned off; a date not ISO. */

const RELATIVE =
  /\b(today|tonight|tomorrow|yesterday|from now on|next (week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|month|year|weekend)|in \d+ (days?|weeks?|months?))\b/i;
const OVERRIDE =
  /\b(skip(ping)?|disable|bypass|ignore|turn off|without running)\b[^.]{0,40}\b(tests?|checks?|guard|safety|hooks?|reviews?|rules?)\b|--no-verify|\btests? (may|can) be skipped\b/gi;
const KEEPS = /\b(never|not|no|don't|do not|must not)\s+(\w+\s+)?$/i;
const LITERAL = /`[^`\n]*`/g;

/** Why a sentence cannot be kept, or null; a product's own words may stay as they are, quoted in backticks. */
export function lintSentence(text: string, least: number, most: number): string | null {
  if (/[\u0000-\u001f\u007f]/.test(text)) return "it must be one line, with no control characters";
  if (text.length < least) return "it is too short to say anything";
  if (text.length > most) return `it is over ${most} characters`;
  const foreign = notEnglish(text.replace(LITERAL, " "));
  if (foreign) return `it must be English (${foreign}); quote other words in backticks`;
  if (hasSecret(text)) return "it holds a secret";
  if (RELATIVE.test(text)) return "it names a relative date; write the date itself";
  // "never skip the tests" keeps a check: only an override with no negation just before it is refused
  for (const found of text.matchAll(OVERRIDE))
    if (!KEEPS.test(text.slice(0, found.index))) return "it cannot turn off tests, checks or the room's guard";
  return null;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** An ISO date, or an ISO time with its zone, as an instant; null for anything else, such as a day past its month's end. */
export function isoTime(raw: string): Date | null {
  const match = ISO.exec(raw.trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  // the engine rolls 2026-02-30 over into March: the day must be one its month has
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const at = new Date(raw.trim());
  return Number.isNaN(at.getTime()) ? null : at;
}
