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
const naming = (words: readonly string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`);

const SIGNAL = new RegExp(`\\b(${named((row) => row.report).join("|")})\\b`);
export const SUBJECT_SIGNALS: readonly string[] = named(() => true);
export const COUNTED: readonly string[] = [...named((row) => row.counted), ...NOTICES.map((row) => row.name)];
export const ANSWERS: ReadonlySet<string> = new Set(named((row) => row.answers));
export const DECIDES: ReadonlySet<string> = new Set(named((row) => row.asks === "decision"));
export const CLOSES_WORK: ReadonlySet<string> = new Set(named((row) => row.closesWork));

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

const OPENINGS = SUBJECT_SIGNALS.map((signal) => [signal, new RegExp(`^${signal}\\b`)] as const);

/** The signal a subject opens with, if any. */
export function subjectOpening(subject: string): string | undefined {
  const opening = subject.replace(/^\W+/, "").toUpperCase();
  return OPENINGS.find(([signal, starts]) => opening === signal || starts.test(opening))?.[0];
}

const ACK = /^\W*ACK\b/;
const REPORT_OPENING = new RegExp(`^\\W*${SIGNAL.source}`);
const WAITING = /^[^\S\r\n\u2028\u2029]*WAITING ON YOU:\s*\S/m;

/** The first line of a text that holds anything, trimmed. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** The protocol signal of a final message: the first line is where it belongs, the whole text the fallback; ACK counts only where the first line opens with it, as the word turns up inside other reports. */
export function signalOf(text: string): string | undefined {
  const opening = firstLine(text);
  if (ACK.test(opening)) return "ACK";
  return SIGNAL.exec(opening)?.[1] ?? SIGNAL.exec(text)?.[1];
}

/** What a final message leaves for the Owner to answer (DECISION_NEEDED, BLOCKED, WAITING ON YOU), or null; the blanks before a wait stay on its line, so a long run of blank lines is read in one pass. */
export function asksOwner(text: string): string | null {
  const opening = SIGNAL.exec(firstLine(text))?.[1];
  if (opening === "DECISION_NEEDED" || opening === "BLOCKED") return opening;
  return WAITING.test(text) ? "WAITING ON YOU" : null;
}

/** The signal a mail's subject opens with, if any; a signal word further in is part of a sentence. */
export function subjectSignal(subject: string): string | undefined {
  return ACK.test(subject) ? "ACK" : REPORT_OPENING.exec(subject)?.[1];
}
