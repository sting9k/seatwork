import { existsSync } from "node:fs";
import mailConfig from "../../shared/mail.json";
import { isAbsolute, join } from "node:path";
import { note, owns } from "../../shared/workflow";
import { MailError, namesTeam, reachable, resolve, shown } from "../coordination/address";
import { refusal } from "../refusal";
import type { Mail, MailEngine, NewMail, Needs, SeatRecord } from "../coordination/engine";
import { inbox } from "../coordination/reader";
import { MailStoreError } from "../coordination/store";
import type { LiveSeat } from "../host";
import { clip } from "../orchestration/forks";
import { CLOSES_WORK, isReceiptWord, priorityOf, SUBJECT_SIGNALS, subjectOpening, subjectSignal } from "../signals";
import { fromRoom, taskOf, type RoomContext } from "./context";

/** The room's two mail tools: what a seat sends is checked, routed and posted; its inbox is read. */

const INFORMS = new Set(["FYI", "HANDOFF"]);
const MOST_NAMED = 50;
const MOST_THREAD_CHARS = 255;

/** A mail tool's refusal as JSON a seat can act on. */
export function refused(room: RoomContext, seat: string | null, error: unknown): Error {
  const mail =
    error instanceof MailError
      ? error
      : error instanceof MailStoreError
        ? new MailError("STORE_UNAVAILABLE", error.message)
        : null;
  if (!mail) return error as Error;
  if (seat) room.engine.noteRefusal(seat, mail.code);
  return new Error(refusal(mail));
}

/** A receipt from above that needs nothing, to a working seat whose last turn handed its work over. */
function isReceipt(subject: string, needs: unknown, toWorker: boolean, endedWith: string | undefined): boolean {
  return (
    toWorker && needs === "nothing" && isReceiptWord(subject) && endedWith !== undefined && CLOSES_WORK.has(endedWith)
  );
}

/** The words of a tool argument given as a string or a list, at most MOST_NAMED of them. */
function words(name: string, value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : typeof value === "string" && value.trim() ? [value] : [];
  if (list.length > MOST_NAMED)
    throw new MailError("INVALID_ARGUMENT", `\`${name}\` names ${list.length} entries; ${MOST_NAMED} at most`);
  return list;
}

/** The id of the mail an answer names, 0 for none; `#12` and `12` name the same one. */
const replyOf = (args: Record<string, unknown>): number =>
  Number(
    String(args.reply_to ?? "")
      .trim()
      .replace(/^#/, ""),
  ) || 0;

/** Who a mail goes to, and the thread it joins: the sender of the mail answered, the team, or the seats named. */
function addressed(
  room: RoomContext,
  from: string,
  args: Record<string, unknown>,
  open: (id: string) => boolean,
  whom: () => { to: string[] },
): { to: string[]; viaReply: boolean; team: boolean; thread: string | undefined } {
  const eng = room.engine;
  const replyTo = replyOf(args);
  let thread = typeof args.thread === "string" && args.thread.trim() ? args.thread.trim() : undefined;
  if (thread && thread.length > MOST_THREAD_CHARS)
    throw new MailError("INVALID_ARGUMENT", `\`thread\` is ${thread.length} characters; ${MOST_THREAD_CHARS} at most`);
  if (replyTo) {
    const ref = eng.lookupMail(replyTo, from);
    if (!ref) throw new MailError("UNKNOWN_MAIL", `no mail #${replyTo} is known; copy the id from the mail you answer`);
    if (!ref.to.includes(from))
      throw new MailError(
        "NOT_YOUR_MAIL",
        `mail #${replyTo} was not addressed to you; you can only answer your own mail`,
      );
    if (ref.from === "room")
      throw new MailError("NOT_YOUR_MAIL", `#${replyTo} is a notice from the room; nobody waits for an answer`);
    thread ??= ref.thread;
    return { to: [ref.from], viaReply: true, team: false, thread };
  }
  const named = words("to", args.to);
  const below = reachable(eng, from).filter((seat) => eng.isAncestor(from, seat.agentId) && open(seat.agentId));
  if (named.some(namesTeam)) {
    const to = below.filter((seat) => eng.canWrite(from, seat.agentId).ok).map((seat) => seat.agentId);
    if (to.length === 0) throw new MailError("NO_RECIPIENT", "no open seat under you takes your mail", whom());
    return { to, viaReply: false, team: true, thread };
  }
  if (named.length === 0) {
    // a seat with no seat under it has one place to write to
    const owner = eng.parentOf(from);
    if (below.length > 0 || !owner)
      throw new MailError("NO_RECIPIENT", "give `to`, or `reply_to` to answer a mail", whom());
    return { to: [owner], viaReply: false, team: false, thread };
  }
  return {
    to: [...new Set(named.map((word) => resolve(eng, from, word, open)))],
    viaReply: false,
    team: false,
    thread,
  };
}

/** The files a mail points at, each by its whole path; a file that does not exist is refused. */
function filesOf(sender: SeatRecord, args: Record<string, unknown>): string[] {
  const files = words("files", args.files).map((file) =>
    isAbsolute(file) || !sender.cwd ? file : join(sender.cwd, file),
  );
  if (files.some((file) => !isAbsolute(file)))
    throw new MailError("MISSING_FILE", "your seat has no folder the room knows: name files by their whole path");
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length > 0) throw new MailError("MISSING_FILE", "the mail names files that do not exist", { missing });
  return files;
}

/** seatwork_mail: checks a seat's mail against the routes, posts it, returns a receipt. */
export async function sendMail(room: RoomContext, from: string, args: Record<string, unknown>): Promise<string> {
  const eng = room.engine;
  const sender = eng.seat(from);
  if (!sender) throw new MailError("NOT_A_SEAT", "this session is not a registered room seat");
  const live = await room.host.live().catch(() => new Map<string, LiveSeat>());
  const open = (id: string) => live.size === 0 || live.has(id);
  const whom = () => ({
    to: shown(
      eng,
      from,
      reachable(eng, from).filter((seat) => open(seat.agentId)),
    ),
  });
  const { to, viaReply, team, thread } = addressed(room, from, args, open, whom);
  const replyTo = replyOf(args);
  const cc = [...new Set(words("cc", args.cc).map((word) => resolve(eng, from, word, open)))].filter(
    (seat) => !to.includes(seat),
  );
  for (const seat of [...to, ...cc]) {
    const check = eng.canWrite(from, seat, viaReply);
    if (!check.ok) throw new MailError("ROUTE_REFUSED", check.reason, whom());
  }
  const everyone = [...to, ...cc];
  const states = await Promise.all(everyone.map((seat) => eng.recipientStatus(seat)));
  const found = new Map(everyone.map((seat, index) => [seat, states[index]]));
  for (const seat of everyone)
    if (found.get(seat) === "gone")
      throw new MailError("RECIPIENT_GONE", `${seat} is archived or gone; nothing was sent`, whom());
  const subject = String(args.subject ?? "").trim() || "(no subject)";
  const opening = subjectOpening(subject);
  if (!opening)
    throw new MailError(
      "NO_SIGNAL",
      "the subject opens with none of the room's signals; a change to what a seat must do is a REVISED BRIEF, a fact it should know is an FYI",
      { subject_opens_with: SUBJECT_SIGNALS },
    );
  // a stop order ends running turns: it travels down only
  const stops = opening === "STOP";
  if (stops && (to.length !== 1 || team || !eng.isAncestor(from, to[0])))
    throw new MailError(
      "STOP_GOES_DOWN",
      "STOP goes to one seat you launched or one below it; to your Owner, write what must stop and why under BLOCKED or QUESTION",
    );
  const body = String(args.body ?? "");
  // a body is kept four times over, in the store, its search, its file and its thread: a long one goes in a file
  if (body.length > mailConfig.bodyChars)
    throw new MailError(
      "INVALID_ARGUMENT",
      `the body is ${body.length} characters; ${mailConfig.bodyChars} at most: put the rest in a file and name it in files`,
    );
  const needs = (["reply", "decision", "nothing"].includes(String(args.needs)) ? args.needs : "nothing") as Needs;
  if (team && needs !== "nothing")
    throw new MailError(
      "TEAM_ASKS_NOTHING",
      "a mail to your team informs; ask a seat by name when you need its answer",
    );
  const files = filesOf(sender, args);
  // a seat that owns none is the one doing the work: what comes down to it is its next step
  const toWorker = to.length === 1 && eng.isAncestor(from, to[0]) && !owns(eng.seat(to[0])?.role);
  const signal = subjectSignal(subject);
  const draft: NewMail = {
    from: { agentId: from, role: sender.role },
    to,
    cc,
    priority: priorityOf(subject, needs, toWorker),
    subject,
    body,
    needs,
    thread,
    ...(replyTo ? { replyTo } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(typeof args.key === "string" && args.key.trim() ? { key: args.key.trim().slice(0, 255) } : {}),
  };
  const again = stops ? null : eng.repeatOf(draft);
  if (again) return JSON.stringify({ sent: again.id, thread: again.thread, replayed: true, state: again.state });
  if (signal && to.length === 1 && eng.parentOf(from) === to[0]) {
    room.mailedUp.set(from, (room.mailedUp.get(from) ?? new Set()).add(signal));
    // "my work is finished" is true only once the turn has ended: the report is kept until then
    if (CLOSES_WORK.has(signal)) {
      const kept = eng.keepReport({
        ...draft,
        cc: [],
        needs: needs === "nothing" ? "reply" : needs,
        why: `the seat ended its turn with ${signal}`,
      });
      return JSON.stringify({
        kept: kept.id,
        thread: kept.thread,
        note: `your report to owner: it is delivered once, when your turn ends. End your turn with ${signal} on the first line; do not send it again.`,
      });
    }
  }
  // an ACK, or a receipt for work under review, asks nothing of anyone: neither starts a turn
  const waits =
    team ||
    signal === "ACK" ||
    (to.length === 1 && isReceipt(subject, args.needs, toWorker, room.lastSignal.get(to[0]))) ||
    (await informsOnly(room, draft, found.get(to[0]), stops, cc.length));
  const mail = await eng.post({
    ...draft,
    priority: stops ? "blocking" : waits ? "fyi" : draft.priority,
    ...(team ? { kind: "team" as const } : {}),
    ...(stops ? { why: "the seat above you stopped this work; the turn you were in was ended to bring you this" } : {}),
    quiet: waits && !stops,
    urgent: stops,
  });
  const sentTo = to.map((seat) => (eng.isAncestor(seat, from) ? "owner" : `${eng.seat(seat)?.role ?? "seat"} ${seat}`));
  if (stops) return stopBelow(room, mail, to[0], subject, found.get(to[0]), sentTo, live);
  const held = eng.held(to[0]).some((m) => m.id === mail.id);
  // the rounds of repair a task allows: the one past them is said where its Owner sends it
  let round: string | undefined;
  if (to.length === 1 && eng.parentOf(to[0]) === from) {
    const task = taskOf(room, to[0]);
    const before = room.rounds.rejected(task);
    const count = room.rounds.answered(task, opening, to[0]);
    if (count > before && count >= 3) round = note("pastLastRound", { rejected: count });
  }
  return JSON.stringify({
    sent: mail.id,
    to: sentTo,
    thread: mail.thread,
    state: waits ? "read with the recipient's next mail" : held ? "held until the recipient can take it" : "delivered",
    ...(round ? { note: round } : {}),
  });
}

/** An FYI or a HANDOFF to one idle seat that the decision model is sure asks it nothing: it waits for that seat's next mail. */
async function informsOnly(
  room: RoomContext,
  draft: NewMail,
  status: string | undefined,
  stops: boolean,
  copies: number,
): Promise<boolean> {
  const signal = subjectSignal(draft.subject);
  if (stops || copies > 0 || draft.needs !== "nothing" || status !== "idle" || !signal || !INFORMS.has(signal))
    return false;
  if ([draft.to].flat().length !== 1) return false;
  return (await room.forks.take("wake", { subject: draft.subject, body: clip(draft.body, 1500) })) === "nothing";
}

/** Every seat at work under a stopped one is stopped with it. */
async function stopBelow(
  room: RoomContext,
  mail: Mail,
  stopped: string,
  subject: string,
  was: string | undefined,
  sentTo: string[],
  live: Map<string, LiveSeat>,
): Promise<string> {
  const eng = room.engine;
  const busy = eng
    .allSeats()
    .filter((under) => eng.isAncestor(stopped, under.agentId))
    .filter((under) => {
      const now = live.get(under.agentId);
      return now !== undefined && (now.status === "running" || now.waiting);
    });
  for (const under of busy)
    await eng.post({
      from: fromRoom,
      to: under.agentId,
      priority: "blocking",
      subject: "STOP: the work above you was stopped",
      body: `The seat above your Owner stopped this work with: "${subject}". Stop where you are: leave the tree as it is, start nothing new, and end your turn with what is finished, what is half-done and where it lies. Your Owner writes next.`,
      needs: "nothing",
      why: "the work you are part of was stopped; the turn you were in was ended to bring you this",
      thread: mail.thread,
      urgent: true,
    });
  return JSON.stringify({
    sent: mail.id,
    to: sentTo,
    thread: mail.thread,
    state: was === "running" || was === "permission" ? "its running turn was ended" : "it was at rest",
    note: "a stop order: your text opens its next turn",
    ...(busy.length > 0 ? { ended_with_it: busy.map((under) => `${under.role} ${under.title ?? under.agentId}`) } : {}),
  });
}

/** seatwork_inbox: a seat's own mail, by view. */
export function readInbox(room: RoomContext, me: string, args: Record<string, unknown>): string {
  if (!room.engine.seat(me)) throw new MailError("NOT_A_SEAT", "this session is not a registered room seat");
  return inbox(room.engine, me, args, Date.now());
}
