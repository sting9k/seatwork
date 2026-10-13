import table from "../shared/signals.json";

/** The words a report or a mail subject opens with, from shared/signals.json. */

interface SignalRow {
  name: string;
  report?: boolean;
  closesWork?: boolean;
  counted?: boolean;
  verdict?: string;
}

const ROWS: readonly SignalRow[] = table.signals;
const named = (pick: (row: SignalRow) => unknown) => ROWS.filter(pick).map((row) => row.name);

export const SIGNAL = new RegExp(`\\b(${named((row) => row.report).join("|")})\\b`);
/** Every word a mail's subject may open with: signals and the answers to them. */
export const SUBJECT_SIGNALS: readonly string[] = named(() => true);
/** What room stats count by name: the marked signals and the room's own notices. */
export const COUNTED: readonly string[] = [...named((row) => row.counted), ...table.notices];
/** A pattern for the subjects that give this verdict on the work they answer. */
export const verdictPattern = (verdict: "accepted" | "returned") =>
  new RegExp(`^\\W*(?:${named((row) => row.verdict === verdict).join("|")})\\b`, "i");

/** The one of them a subject opens with, if any. */
export function subjectOpening(subject: string): string | undefined {
  const opening = subject.replace(/^\W+/, "").toUpperCase();
  return SUBJECT_SIGNALS.find((signal) => opening === signal || new RegExp(`^${signal}\\b`).test(opening));
}

export function opensWithSignal(subject: string): boolean {
  return subjectOpening(subject) !== undefined;
}

/** An acknowledgement counts only where a line opens with it: the word turns up inside other reports. */
const ACK = /^\W*ACK\b/;
/** Signals that say "my work is finished": the parent acts on the seat when it reads one. */
export const CLOSES_WORK: ReadonlySet<string> = new Set(named((row) => row.closesWork));

/** The protocol signal of a final message. The first line is where it belongs; the whole text is the fallback. */
export function signalOf(text: string): string | undefined {
  const firstLine =
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? "";
  if (ACK.test(firstLine)) return "ACK";
  return SIGNAL.exec(firstLine)?.[1] ?? SIGNAL.exec(text)?.[1];
}

/** What a final message leaves for the Owner to answer (DECISION_NEEDED, BLOCKED, WAITING ON YOU), or null. */
export function asksOwner(text: string): string | null {
  const opening = SIGNAL.exec(text.split("\n").find((line) => line.trim()) ?? "")?.[1];
  if (opening === "DECISION_NEEDED" || opening === "BLOCKED") return opening;
  return /^\s*WAITING ON YOU:\s*\S/m.test(text) ? "WAITING ON YOU" : null;
}

/** The signal a mail's subject opens with, if any; a signal word further in is part of a sentence. */
export function subjectSignal(subject: string): string | undefined {
  return ACK.test(subject) ? "ACK" : new RegExp(`^\\W*${SIGNAL.source}`).exec(subject)?.[1];
}
