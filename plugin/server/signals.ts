import table from "../shared/signals.json";

/** The words a report or a mail subject opens with, from shared/signals.json. */

interface SignalRow {
  name: string;
  report?: boolean;
  closesWork?: boolean;
  counted?: boolean;
  verdict?: string;
  answers?: boolean;
  asks?: string;
  priority?: string;
  toWorker?: string;
  receipt?: boolean;
  onlyAfterCandidate?: boolean;
}

const ROWS: readonly SignalRow[] = table.signals;
const NOTICES: readonly SignalRow[] = table.notices;
const named = (pick: (row: SignalRow) => unknown, rows = ROWS) => rows.filter(pick).map((row) => row.name);
const row = (word: string) => ROWS.find((one) => one.name === word);
/** A pattern for a subject naming any of these words. */
const naming = (words: readonly string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`);

export const SIGNAL = new RegExp(`\\b(${named((row) => row.report).join("|")})\\b`);
/** Every word a mail's subject may open with: signals and the answers to them. */
export const SUBJECT_SIGNALS: readonly string[] = named(() => true);
/** What room stats count by name: the marked signals and the room's own notices. */
export const COUNTED: readonly string[] = [...named((row) => row.counted), ...NOTICES.map((row) => row.name)];
/** Signals that answer an ask when they come back to its sender. */
export const ANSWERS: ReadonlySet<string> = new Set(named((row) => row.answers));
/** Signals whose report asks the seat above for a decision rather than a reply. */
export const DECIDES: ReadonlySet<string> = new Set(named((row) => row.asks === "decision"));
/** What a signal says of the work it answers: accepted, returned, deferred, or nothing. */
export const verdictOf = (word: string | undefined): string | undefined => (word ? row(word)?.verdict : undefined);
/** Whether a signal returns the work only when it answers a candidate. */
export const onlyAfterCandidate = (word: string): boolean => row(word)?.onlyAfterCandidate === true;

const BY_PRIORITY = {
  toWorkerBlocking: naming(named((row) => row.toWorker === "blocking")),
  toWorkerAction: naming(named((row) => row.toWorker === "action")),
  blocking: naming([
    ...named((row) => row.priority === "blocking"),
    ...named((row) => row.priority === "blocking", NOTICES),
  ]),
  action: naming(named((row) => row.priority === "action")),
};

/** How urgent a mail is by its subject: an answer to a seat that owns none reaches it at once. */
export function priorityOf(subject: string, needs: string, toWorker: boolean): "blocking" | "action" | "fyi" {
  const s = subject.toUpperCase();
  if (toWorker && BY_PRIORITY.toWorkerBlocking.test(s)) return "blocking";
  if (toWorker && BY_PRIORITY.toWorkerAction.test(s)) return "action";
  if (BY_PRIORITY.blocking.test(s)) return "blocking";
  if (needs === "decision") return "action";
  if (BY_PRIORITY.action.test(s)) return "action";
  return needs === "reply" ? "action" : "fyi";
}

const RECEIPT = new RegExp(`^\\W*(?:${named((row) => row.receipt).join("|")})\\b`);
/** Whether a subject opens with a receipt: a word from above that asks nothing of work handed in. */
export const isReceiptWord = (subject: string): boolean => RECEIPT.test(subject);

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
