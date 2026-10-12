/** The room's protocol signals: the word a seat's final message or a mail subject opens with. */

export const SIGNAL = /\b(DONE|DECISION_NEEDED|BLOCKED|REOPEN_REQUEST|DEPENDENCY_REQUEST|QUESTION|CANDIDATE|REVIEW|STATUS)\b/;
/** An acknowledgement counts only where a line opens with it: the word turns up inside other reports. */
const ACK = /^\W*ACK\b/;
/** Signals that say "my work is finished": the parent acts on the seat when it reads one. */
export const CLOSES_WORK: ReadonlySet<string> = new Set(["CANDIDATE", "REVIEW", "DONE"]);

/** The protocol signal of a final message. The first line is where it belongs; the whole text is the fallback. */
export function signalOf(text: string): string | undefined {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
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
