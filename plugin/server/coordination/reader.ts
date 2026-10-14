import { MailError } from "./address";
import { threadFile } from "./archive";
import type { MailEngine } from "./engine";
import { digest, envelope, line } from "./envelope";

/** A seat's mailbox as it asks to see it: what waits, one mail, a thread, sent, owed, a search. */

export interface InboxArgs {
  view?: unknown;
  id?: unknown;
  thread?: unknown;
  q?: unknown;
  signal?: unknown;
  since?: unknown;
  limit?: unknown;
  bodies?: unknown;
  peek?: unknown;
}

const VIEWS = ["new", "all", "sent", "owed", "thread", "search"] as const;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const count = (value: unknown, fallback: number) => Math.min(Math.max(1, Math.trunc(Number(value)) || fallback), 200);
const minutes = (since: string, now: number) => Math.max(0, Math.round((now - Date.parse(since)) / 60_000));

/** The asks a seat has not answered, as one line under what it reads; empty when it owes none. */
export function owedLine(engine: MailEngine, me: string, now: number): string {
  const owed = engine.storeOf(me, false)?.owedBy(me) ?? [];
  if (owed.length === 0) return "";
  const list = owed.slice(0, 5).map((ask) => `#${ask.id} (${ask.signal}, ${minutes(ask.at, now)} min)`);
  return `[room] you owe ${owed.length === 1 ? "an answer" : `${owed.length} answers`}: ${list.join(", ")}${owed.length > 5 ? ", …" : ""}. Answer with reply_to.`;
}

export function inbox(engine: MailEngine, me: string, args: InboxArgs, now: number): string {
  const store = engine.storeOf(me, false);
  const seenBy = engine.seenBy(me);
  const limit = count(args.limit, 20);
  const id = Number(String(args.id ?? "").replace(/^#/, "")) || 0;
  if (id) {
    const message = store?.get(id);
    if (!store || !message || (seenBy && !store.seen(id, seenBy)))
      throw new MailError("UNKNOWN_MAIL", `no mail #${id} that you may read is in your project`);
    return envelope({ message, from: engine.label(message.sender, me) });
  }
  const view = text(args.view) ?? (text(args.thread) ? "thread" : text(args.q) ? "search" : "new");
  if (!(VIEWS as readonly string[]).includes(view))
    throw new MailError("INVALID_ARGUMENT", `\`view\` is one of ${VIEWS.join(", ")}; or give \`id\``);
  const from = (sender: string) => engine.label(sender, me);
  const none = (what: string) => [what, owedLine(engine, me, now)].filter(Boolean).join("\n");
  if (view === "new") {
    const mails = engine.takeHeld(me, args.peek === true);
    if (mails.length === 0) return none("inbox empty");
    return [digest(mails.map((mail) => engine.shown(mail, me))), owedLine(engine, me, now)]
      .filter(Boolean)
      .join("\n\n");
  }
  if (!store) return none("no mail yet");
  if (view === "all") {
    const mails = store.received(me, limit, { since: text(args.since), signal: text(args.signal) });
    return mails.map((mail) => line(mail, from(mail.sender), mail.state)).join("\n") || "no mail yet";
  }
  if (view === "sent") {
    const sent = store.sent(me, limit, text(args.since));
    return (
      sent
        .map((message) =>
          line(
            message,
            `to ${store
              .deliveries(message.id)
              .map((to) => `${engine.label(to.seat, me)} [${to.state}]`)
              .join(", ")}`,
          ),
        )
        .join("\n") || "you sent no mail yet"
    );
  }
  if (view === "owed") {
    const mine = store.owedBy(me).map((ask) => `you owe: ${line(ask, from(ask.sender))}`);
    const theirs = store.owedTo(me).map((ask) => `you wait for: ${line(ask, "you")}`);
    return [...mine, ...theirs].join("\n") || "nothing is owed";
  }
  if (view === "thread") {
    const thread = text(args.thread);
    if (!thread) throw new MailError("INVALID_ARGUMENT", "give `thread`: an issue id, or the thread a mail names");
    const mails = store.thread(thread, seenBy, limit);
    if (mails.length === 0) return `no mail in thread ${thread} that you may read`;
    const file = threadFile(engine.folderOf(me), thread);
    const body =
      args.bodies === true
        ? mails.map((message) => envelope({ message, from: from(message.sender) })).join("\n\n")
        : mails.map((message) => line(message, from(message.sender))).join("\n");
    return `${body}${file ? `\nthe whole thread as one file: ${file}` : ""}`;
  }
  const q = text(args.q);
  if (!q) throw new MailError("INVALID_ARGUMENT", "give `q`: the words to look for");
  const hits = store.search(q, seenBy, {
    limit,
    thread: text(args.thread),
    signal: text(args.signal),
    since: text(args.since),
  });
  return (
    hits
      .map(
        (hit) =>
          `#${hit.id} ${hit.at.slice(0, 16).replace("T", " ")} ${from(hit.sender)} · ${hit.subject} · ${hit.snippet}`,
      )
      .join("\n") || `nothing matches \`${q}\``
  );
}
