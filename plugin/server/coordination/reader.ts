import { MailError } from "./address";
import { threadFile } from "./archive";
import type { MailEngine } from "./engine";
import { clock, digest, envelope, line } from "./envelope";
import type { Hit } from "./store";

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
  project?: unknown;
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

/** One search hit as a line: id, time, sender, subject, the words around the match. */
const hitLine = (hit: Hit, from: string) => `#${hit.id} ${clock(hit.at)} ${from} · ${hit.subject} · ${hit.snippet}`;

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
  const project = text(args.project);
  if (project) return acrossProjects(engine, me, project, view, args, limit);
  if (view === "new") {
    const mails = engine.takeHeld(me, args.peek === true);
    if (mails.length === 0) return none("inbox empty");
    return [digest(mails.map((mail) => engine.shown(mail, me, true))), owedLine(engine, me, now)]
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
    const whole = store.thread(thread, null, 1000).length === mails.length;
    const file = whole ? threadFile(engine.folderOf(me), thread) : null;
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
  return hits.map((hit) => hitLine(hit, from(hit.sender))).join("\n") || `nothing matches \`${q}\``;
}

/** Search or thread in another project's store, or all, for a seat that reads every project. */
function acrossProjects(
  engine: MailEngine,
  me: string,
  project: string,
  view: string,
  args: InboxArgs,
  limit: number,
): string {
  if (engine.seenBy(me) !== null)
    throw new MailError("INVALID_ARGUMENT", "`project` is for a seat that reads every project; yours reads its own");
  if (view !== "search" && view !== "thread")
    throw new MailError("INVALID_ARGUMENT", "`project` goes with view search or thread");
  if (view === "search" && !text(args.q)) throw new MailError("INVALID_ARGUMENT", "give `q`: the words to look for");
  if (view === "thread" && !text(args.thread))
    throw new MailError("INVALID_ARGUMENT", "give `thread`: an issue id, or the thread a mail names");
  const stores = engine.storesAt(project);
  if (stores.length === 0)
    throw new MailError("INVALID_ARGUMENT", `no project of the room is ${project}; give its folder, its name or all`);
  const from = (sender: string) => engine.label(sender, me);
  const out: string[] = [];
  for (const { folder, store, error } of stores) {
    if (error) out.push(`[${folder}] could not be read: ${error}`);
    if (!store) continue;
    const found =
      view === "thread"
        ? store.thread(text(args.thread) ?? "", null, limit).map((message) => line(message, from(message.sender)))
        : store
            .search(text(args.q) ?? "", null, { limit, signal: text(args.signal), since: text(args.since) })
            .map((hit) => hitLine(hit, from(hit.sender)));
    if (found.length > 0) out.push(`[${folder}]`, ...found);
  }
  return out.join("\n") || "nothing found";
}
