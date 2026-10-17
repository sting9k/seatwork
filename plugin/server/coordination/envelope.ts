import type { Delivery, Message } from "./store";

/** What a seat reads of a mail: one tagged block per mail, and one line per mail in a list. */

/** `from`: the sender as this reader sees it; `chars`: how much of the body is shown. */
interface Shown {
  message: Message;
  delivery?: Pick<Delivery, "kind" | "state" | "quiet">;
  from: string;
  chars?: number;
}

/** A header value as one line, with what would end the header written as entities. */
const attribute = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
/** A time as `YYYY-MM-DD HH:MM`. */
export const clock = (at: string) => at.slice(0, 16).replace("T", " ");

/** A seat as a mail names it: role, the start of its id, its title without the role tag. */
export function seatLabel(seat: { role: string; agentId: string; title: string | null }): string {
  const title = (seat.title ?? "").replace(/^\[[^\]]*\]\s*/, "").trim();
  return `${seat.role} ${seat.agentId.slice(0, 8)}${title ? `: ${title}` : ""}`;
}

/** The body as a reader gets it: whole, or cut where the file takes over. */
function shownBody(message: Message, chars: number | undefined): string {
  // what would open or close a block is the sender's text: its bracket is written as an entity
  const body = message.body.trim().replace(/<(\/?mail)\b/gi, "&lt;$1");
  if (chars === undefined || body.length <= chars || !message.file) return body;
  return `${body.slice(0, chars).trimEnd()}\n[cut at ${chars} of ${body.length} characters; the whole mail is in ${message.file}]`;
}

/** One mail as a tagged block: its header values on one line, its body cut where the file takes over. */
export function envelope({ message, delivery, from, chars }: Shown): string {
  const marks = [
    `id="${message.id}"`,
    `from="${attribute(from)}"`,
    `subject="${attribute(message.subject)}"`,
    `needs="${message.needs}"`,
    `thread="${attribute(message.thread)}"`,
    ...(delivery && delivery.kind !== "to" ? [`as="${delivery.kind}"`] : []),
    ...(message.why ? [`note="${attribute(message.why)}"`] : []),
    ...(message.files.length > 0 ? [`files="${attribute(message.files.join(", "))}"`] : []),
    ...(delivery?.state === "sending"
      ? [`repeat="an earlier delivery was cut off; if you handled it, do nothing"`]
      : []),
  ];
  return `<mail ${marks.join(" ")}>\n${shownBody(message, chars)}\n</mail>`;
}

const ROOM_TAGS = ["<mail ", "<knowledge>"];

/** A prompt with the mail and the room's notes it carried taken out: what is left was typed to the seat. */
export function withoutMail(prompt: string): string {
  const kept = prompt
    .replace(/<mail\s[^>]*>[\s\S]*?\n<\/mail>/g, "")
    .replace(/<knowledge>[\s\S]*?\n<\/knowledge>/g, "")
    // a prompt the app cut short ends inside the room's block: the rest of that block is the room's too
    .replace(/<mail\s[\s\S]*$|<knowledge>[\s\S]*$/, "");
  // a cut that falls inside the tag itself leaves its start
  const tag = kept.lastIndexOf("<");
  const end = tag >= 0 && ROOM_TAGS.some((one) => one.startsWith(kept.slice(tag))) ? kept.slice(0, tag) : kept;
  return end.trim();
}

/** Several mails as one prompt: those that ask the most first, then by age. */
export function digest(mails: readonly (Shown & { rank: number })[]): string {
  return [...mails]
    .sort((a, b) => a.rank - b.rank || a.message.id - b.message.id)
    .map(envelope)
    .join("\n\n");
}

/** One mail as a line of a list: who, what, and where it stands. */
export function line(message: Message, from: string, state?: string): string {
  const answered =
    message.needs === "nothing" ? "" : message.answeredBy ? `, answered by #${message.answeredBy}` : ", unanswered";
  const where = state ? ` [${state}]` : "";
  return `#${message.id} ${clock(message.at)} ${from} · ${message.subject} · needs ${message.needs}${answered} · thread ${message.thread}${where}`;
}

/** A thread as its record reads: one entry per mail, oldest first. */
export function threadEntry(message: Message, from: string, to: string): string {
  return `## #${message.id} · ${clock(message.at)} · ${from} → ${to}\n\n**${message.subject}**\n\n${message.body.trim()}\n`;
}
