import config from "../../shared/mail.json";
import { MailError } from "./address";
import { clock } from "./envelope";
import type { WakeUp } from "./store";

/** Timed wake-ups: a request read against the settings, and the WAKE mail a wake-up becomes when it falls due. */

/** What a seat asked for: a time, as an ISO time with its zone or as minutes from now, and a note. */
export interface WakeAsk {
  at?: unknown;
  inMinutes?: unknown;
  note?: unknown;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MOST_AT_CHARS = 40;
const SUBJECT_NOTE_CHARS = 100;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const given = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";

/** An ISO time with a zone as milliseconds; NaN for any other text and for a day the month does not have. */
function parseZoned(text: string): number {
  if (text.length > MOST_AT_CHARS || !ZONED.test(text)) return NaN;
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day ? Date.parse(text) : NaN;
}

/** The UTC time a request names, as ISO text; refused when it is unreadable, under the minimum ahead or past the horizon. */
export function dueOf(ask: WakeAsk, now: Date): string {
  const earliest = now.getTime() + config.wake.minMinutes * MINUTE_MS;
  const latest = now.getTime() + config.wake.maxDays * DAY_MS;
  const window = {
    now: now.toISOString(),
    earliest: new Date(earliest).toISOString(),
    latest: new Date(latest).toISOString(),
  };
  if (given(ask.at) && given(ask.inMinutes))
    throw new MailError("INVALID_ARGUMENT", "give `at` or `in_minutes`, not both");
  let due: number;
  if (given(ask.at)) {
    due = parseZoned(String(ask.at).trim());
    if (Number.isNaN(due))
      throw new MailError(
        "INVALID_ARGUMENT",
        "`at` is an ISO time with its zone, such as 2026-10-16T09:00:00Z or 2026-10-16T09:00:00+07:00; or give `in_minutes`",
        window,
      );
  } else if (given(ask.inMinutes)) {
    const minutes = typeof ask.inMinutes === "number" ? ask.inMinutes : Number(String(ask.inMinutes));
    if (!Number.isFinite(minutes))
      throw new MailError("INVALID_ARGUMENT", "`in_minutes` is a number of minutes from now", window);
    due = now.getTime() + Math.round(minutes * MINUTE_MS);
  } else
    throw new MailError(
      "INVALID_ARGUMENT",
      "give `at` (an ISO time with its zone, such as 2026-10-16T09:00:00Z) or `in_minutes`",
      window,
    );
  if (due < earliest || due > latest)
    throw new MailError(
      "INVALID_ARGUMENT",
      `a wake-up is at least ${config.wake.minMinutes} minute${config.wake.minMinutes === 1 ? "" : "s"} and at most ${config.wake.maxDays} days from now; give a time between earliest and latest`,
      window,
    );
  return new Date(due).toISOString();
}

/** The note of a request: given, and within its cap. */
export function noteOf(value: unknown): string {
  const note = typeof value === "string" ? value.trim() : "";
  if (!note)
    throw new MailError("INVALID_ARGUMENT", "give a `note`: what you do when the wake-up comes, in a sentence");
  if (note.length > config.wake.noteChars)
    throw new MailError(
      "INVALID_ARGUMENT",
      `the note is ${note.length} characters; ${config.wake.noteChars} at most: keep the detail in a file and name it in the note`,
    );
  return note;
}

/** The subject of a WAKE mail: the first line of its note, cut short. */
export const wakeSubject = (note: string): string => `WAKE: ${note.split("\n")[0].trim().slice(0, SUBJECT_NOTE_CHARS)}`;

/** The body of a WAKE mail: the note, then which wake-up it is and who set it, as `by` reads to the seat woken. */
export const wakeBody = (wake: WakeUp, by: string): string =>
  `${wake.note}\n\nWake-up #${wake.id}, set by ${by} at ${clock(wake.at)} UTC for ${clock(wake.due)} UTC.`;
