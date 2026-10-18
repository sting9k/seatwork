import { existsSync } from "node:fs";
import mailConfig from "../../shared/mail.json";
import { isAbsolute, join } from "node:path";
import { note, owns, traits } from "../../shared/workflow";
import { exactSeat, MailError, namesTeam, reachable, resolve, shown } from "../coordination/address";
import { refusal, type NextCall } from "../refusal";
import type { Mail, MailEngine, NewMail, Needs, SeatRecord } from "../coordination/engine";
import { inbox } from "../coordination/reader";
import { StoreError } from "../sqlite";
import type { LiveSeat, TurnEvent } from "../host";
import { routeUp } from "../orchestration/escalation";
import {
  CLOSES_WORK,
  isReceiptWord,
  priorityOf,
  SUBJECT_SIGNALS,
  subjectOpening,
  subjectSignal,
  verdictOf,
} from "../signals";
import { errorText, fromRoom, taskOf, type RoomContext } from "./context";
import { briefOf } from "./council";
import { tierUpNote } from "./launch";
import { excerpt } from "../excerpt";

/** The room's two mail tools: what a seat sends is checked, routed and posted; its inbox is read. */

const INFORMS = new Set(["FYI", "HANDOFF"]);
const MOST_THREAD_CHARS = 255;
const WAKEUPS_SHOWN = 50;

const INBOX: NextCall = { tool: "seatwork_inbox", args: { view: "all" } };
const WAKES: NextCall = { tool: "seatwork_mail", args: { action: "wakes" } };

/** A mail tool's refusal as JSON a seat can act on. */
export function refused(room: RoomContext, seat: string | null, error: unknown): Error {
  const mail =
    error instanceof MailError
      ? error
      : error instanceof StoreError
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

/** The words of a tool argument given as a string or a list, at most `namedMost` of them. */
function words(name: string, value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : typeof value === "string" && value.trim() ? [value] : [];
  if (list.length > mailConfig.namedMost)
    throw new MailError(
      "INVALID_ARGUMENT",
      `\`${name}\` names ${list.length} entries; ${mailConfig.namedMost} at most`,
    );
  return list;
}

/** The id of the mail an answer names, 0 for none; `#12` and `12` name the same one. */
const replyOf = (args: Record<string, unknown>): number =>
  Number(
    String(args.reply_to ?? "")
      .trim()
      .replace(/^#/, ""),
  ) || 0;

/** The app's list of open seats, fetched on first use: the list itself, a test of one seat against it, and the seats a refusal names. */
interface OpenSeats {
  live(): Promise<Map<string, LiveSeat>>;
  open(): Promise<(agentId: string) => boolean>;
  whom(): Promise<{ to: string[] }>;
}

/** The open seats for one mail from `from`, listed at most once; an app that lists none, or fails, leaves every seat open. */
function openSeats(room: RoomContext, from: string): OpenSeats {
  const eng = room.engine;
  let listed: Promise<Map<string, LiveSeat>> | undefined;
  const live = () => (listed ??= room.host.live().catch(() => new Map<string, LiveSeat>()));
  const open = async () => {
    const seats = await live();
    return (agentId: string) => seats.size === 0 || seats.has(agentId);
  };
  const whom = async () => {
    const isOpen = await open();
    return {
      to: shown(
        eng,
        from,
        reachable(eng, from).filter((seat) => isOpen(seat.agentId)),
      ),
    };
  };
  return { live, open, whom };
}

/** The seats a list of words names, each once; an exact id or `owner` needs no list of open seats. */
async function resolved(room: RoomContext, from: string, list: string[], seats: OpenSeats): Promise<string[]> {
  const found: string[] = [];
  for (const word of list)
    found.push(exactSeat(room.engine, from, word) ?? resolve(room.engine, from, word, await seats.open()));
  return [...new Set(found)];
}

/** Who a mail goes to, and the thread it joins: the sender of the mail answered, the team, or the seats named. */
async function addressed(
  room: RoomContext,
  from: string,
  args: Record<string, unknown>,
  seats: OpenSeats,
): Promise<{ to: string[]; viaReply: boolean; team: boolean; thread: string | undefined }> {
  const eng = room.engine;
  const replyTo = replyOf(args);
  let thread = typeof args.thread === "string" && args.thread.trim() ? args.thread.trim() : undefined;
  if (thread && thread.length > MOST_THREAD_CHARS)
    throw new MailError("INVALID_ARGUMENT", `\`thread\` is ${thread.length} characters; ${MOST_THREAD_CHARS} at most`);
  if (replyTo) {
    const ref = eng.lookupMail(replyTo, from);
    if (!ref)
      throw new MailError(
        "UNKNOWN_MAIL",
        `no mail #${replyTo} is known; copy the id from the mail you answer`,
        undefined,
        INBOX,
      );
    if (!ref.to.includes(from))
      throw new MailError(
        "NOT_YOUR_MAIL",
        `mail #${replyTo} was not addressed to you; you can only answer your own mail`,
        undefined,
        INBOX,
      );
    if (ref.from === "room")
      throw new MailError("NOT_YOUR_MAIL", `#${replyTo} is a notice from the room; nobody waits for an answer`);
    thread ??= ref.thread;
    return { to: [ref.from], viaReply: true, team: false, thread };
  }
  const named = words("to", args.to);
  // a sender with no seat under it needs no list of open seats to know that none is open
  const below = async () => {
    const under = reachable(eng, from).filter((seat) => eng.isAncestor(from, seat.agentId));
    if (under.length === 0) return under;
    const open = await seats.open();
    return under.filter((seat) => open(seat.agentId));
  };
  if (named.some(namesTeam)) {
    const to = (await below()).filter((seat) => eng.canWrite(from, seat.agentId).ok).map((seat) => seat.agentId);
    if (to.length === 0)
      throw new MailError("NO_RECIPIENT", "no open seat under you takes your mail", await seats.whom());
    return { to, viaReply: false, team: true, thread };
  }
  if (named.length === 0) {
    // a seat with no seat under it has one place to write to
    const owner = eng.parentOf(from);
    if ((await below()).length > 0 || !owner)
      throw new MailError("NO_RECIPIENT", "give `to`, or `reply_to` to answer a mail", await seats.whom());
    return { to: [owner], viaReply: false, team: false, thread };
  }
  return { to: await resolved(room, from, named, seats), viaReply: false, team: false, thread };
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

/** A seat as the caller reads it in a wake-up: `you`, `owner`, or its role and id. */
const seenAs = (eng: MailEngine, me: string, seat: string): string =>
  seat === me ? "you" : eng.isAncestor(seat, me) ? "owner" : `${eng.seat(seat)?.role ?? "seat"} ${seat}`;

/** seatwork_mail `wake`, `wakes` and `unwake`: a timed wake-up set for the caller or a seat it may mail, listed, or canceled. */
async function wakeUps(room: RoomContext, me: string, action: string, args: Record<string, unknown>): Promise<string> {
  const eng = room.engine;
  if (action === "wakes") {
    const waiting = eng.wakeUpsOf(me, WAKEUPS_SHOWN + 1);
    return JSON.stringify({
      wakes: waiting.slice(0, WAKEUPS_SHOWN).map(({ id, seat, by, due, note }) => ({
        id,
        seat: seenAs(eng, me, seat),
        by: seenAs(eng, me, by),
        at: due,
        note,
      })),
      ...(waiting.length > WAKEUPS_SHOWN ? { more: true } : {}),
    });
  }
  const seats = openSeats(room, me);
  const named = words("to", args.to);
  if (named.length > 1)
    throw new MailError("INVALID_ARGUMENT", "a wake-up wakes one seat: give one `to`, or none to wake yourself");
  const seat = named.length === 0 ? me : (await resolved(room, me, named, seats))[0];
  if (action === "unwake") {
    const id = Number(String(args.id ?? "").replace(/^\s*#/, ""));
    if (!Number.isInteger(id) || id < 1)
      throw new MailError(
        "INVALID_ARGUMENT",
        "give `id`, the wake-up's id from the answer that set it or from `wakes`",
      );
    const wake = eng.cancelWakeUp(me, id, named.length === 0 ? undefined : seat);
    if (!wake)
      throw new MailError(
        "UNKNOWN_WAKE",
        `no wake-up #${id} of yours is waiting; \`wakes\` lists them, and one that fired or was canceled is gone`,
        undefined,
        WAKES,
      );
    return JSON.stringify({ canceled: wake.id, seat: seenAs(eng, me, wake.seat), was_due: wake.due });
  }
  if (seat !== me) {
    const check = eng.canWrite(me, seat);
    if (!check.ok) throw new MailError("ROUTE_REFUSED", check.reason, await seats.whom());
    if ((await eng.recipientStatus(seat)) === "gone")
      throw new MailError("RECIPIENT_GONE", `${seat} is archived or gone; no wake-up was set`, await seats.whom());
  }
  const added = eng.setWakeUp(me, seat, { at: args.at, inMinutes: args.in_minutes, note: args.note });
  if ("full" in added) {
    const { perSeat, perSetter } = mailConfig.wake;
    const fix = "`wakes` lists them, `unwake` cancels one";
    throw new MailError(
      "WAKE_LIMIT",
      added.full === "own"
        ? `you already have ${perSeat} wake-ups waiting for yourself: ${fix}`
        : added.full === "setter"
          ? `you already have ${perSetter} wake-ups waiting for ${seat}: ${fix}`
          : `other seats already have ${perSeat} wake-ups waiting for ${seat}; wait for one to fire, or ask a seat to cancel one`,
      undefined,
      added.full === "others" ? undefined : WAKES,
    );
  }
  return JSON.stringify({
    wake: added.wake.id,
    seat: seenAs(eng, me, seat),
    at: added.wake.due,
    ...(added.repeat ? { replayed: true } : {}),
    note: added.repeat
      ? "this wake-up was already waiting, so none was added"
      : "the seat is mailed a WAKE at that time, which starts its turn; the pass runs each minute, so it can be up to a minute late",
  });
}

/** The receipt for a mail the room already holds: the same text again, or the same key. */
const replay = (mail: Mail) =>
  JSON.stringify({ sent: mail.id, thread: mail.thread, replayed: true, state: mail.state });

/** Who a mail goes to and is copied to, each a seat the routes let the sender write to and still there, with the state the app gives each; the thread it joins, and whether it goes to the team. */
interface Recipients {
  to: string[];
  cc: string[];
  team: boolean;
  thread: string | undefined;
  states: Map<string, string>;
}

/** A mail as a seat's arguments make it, checked, with the signal its subject opens with and whether it is a stop order or the next step of the seat doing the work. */
interface Drafted {
  draft: NewMail;
  opening: string;
  stops: boolean;
  toWorker: boolean;
}

/** seatwork_mail: checks a seat's mail against the routes, posts it, returns a receipt; with `action` wake, wakes or unwake, a timed wake-up instead. */
export async function sendMail(room: RoomContext, from: string, args: Record<string, unknown>): Promise<string> {
  const eng = room.engine;
  const sender = eng.seat(from);
  if (!sender) throw new MailError("NOT_A_SEAT", "this session is not a registered room seat");
  const action = String(args.action ?? "send");
  if (action !== "send") {
    if (!["wake", "wakes", "unwake"].includes(action))
      throw new MailError("INVALID_ARGUMENT", "`action` is send (the default), wake, wakes or unwake");
    return wakeUps(room, from, action, args);
  }
  if (typeof args.body !== "string") throw new MailError("INVALID_ARGUMENT", "a mail gives a `body`: what it says");
  const seats = openSeats(room, from);
  const where = await recipients(room, from, args, seats);
  const { draft, opening, stops, toWorker } = drafted(eng, sender, args, where);
  const again = stops ? null : eng.repeatOf(draft);
  if (again) return replay(again);
  const gate = await acceptanceGate(room, sender, draft, opening);
  const signal = subjectSignal(draft.subject);
  const kept = keptUp(room, from, draft, signal);
  if (kept) return kept;
  // a question for the Owner may be one a seat above, or a person, must answer
  const routed = await routeUp(room, from, draft, signal);
  const outgoing = routed?.draft ?? draft;
  const repeated = routed ? eng.repeatOf(outgoing) : null;
  if (repeated) return replay(repeated);
  const waits = await startsNoTurn(room, draft, where, toWorker);
  const mail = await eng.post({
    ...outgoing,
    priority: stops ? "blocking" : waits ? "fyi" : draft.priority,
    ...(where.team ? { kind: "team" as const } : {}),
    ...(stops ? { why: "the seat above you stopped this work; the turn you were in was ended to bring you this" } : {}),
    quiet: waits,
    urgent: stops,
  });
  const sentTo = [outgoing.to]
    .flat()
    .map((seat) => (eng.isAncestor(seat, from) && !routed ? "owner" : `${eng.seat(seat)?.role ?? "seat"} ${seat}`));
  const to = where.to[0];
  if (stops) return stopBelow(room, mail, to, draft.subject, where.states.get(to), sentTo, await seats.live());
  gate?.keep();
  for (const line of gate?.up ?? []) room.safety.oweUp(from, line);
  const held = mail.state === "queued" || mail.state === "sending";
  const round = await roundNote(room, from, where.to, opening);
  const notes = [round, routed?.note, gate?.line].filter(Boolean);
  return JSON.stringify({
    sent: mail.id,
    to: sentTo,
    thread: mail.thread,
    state: waits ? "read with the recipient's next mail" : held ? "held until the recipient can take it" : "delivered",
    ...(notes.length ? { note: notes.join("; ") } : {}),
  });
}

/** The gate before an ACCEPT going down: the Lead's line, lines owed up, records. */
async function acceptanceGate(
  room: RoomContext,
  sender: SeatRecord,
  draft: NewMail,
  opening: string,
): Promise<{ line: string | null; up: string[]; keep(): void } | null> {
  if (verdictOf(opening) !== "accepted" || traits(sender.role).briefs !== true) return null;
  const writers = [draft.to].flat().filter((seat) => room.engine.parentOf(seat) === sender.agentId);
  if (writers.length === 0) return null;
  let read: Promise<readonly TurnEvent[] | null> | undefined;
  const turn = (entries: number) => (read ??= room.host.turn(sender.agentId, entries));
  const text = `${draft.subject}\n${draft.body}`;
  const said: string[] = [];
  const up: string[] = [];
  const keeps: (() => void)[] = [];
  let blocks = false;
  let unrun: string | null = null;
  for (const writer of writers) {
    const on = writers.length > 1 ? `on ${writer}: ` : "";
    const gate = await room.safety
      .acceptance({
        accepter: sender.agentId,
        writer,
        task: taskOf(room, writer),
        brief: await briefOf(room, writer),
        text,
        turn,
        reviews: (since, limit) =>
          room.engine
            .storeOf(sender.agentId, false)
            ?.received(sender.agentId, limit, { since, signal: "REVIEW" })
            .map((mail) => ({ id: mail.id, text: `${mail.subject}\n${mail.body}` })) ?? [],
      })
      .catch((error) => {
        room.log(`the acceptance gate on ${writer} could not run: ${errorText(error)}`);
        said.push(`${on}not checked, the gate could not run`);
        return null;
      });
    if (!gate) continue;
    keeps.push(gate.keep);
    if (gate.gaps.length === 0) continue;
    blocks ||= gate.mode === "block";
    if (gate.gaps.some((gap) => gap.rule === "unrun" || gap.rule === "masked")) unrun ??= writer;
    const gaps = gate.gaps.map((gap) => gap.line).join("; ");
    said.push(`${on}${gaps}`);
    up.push(`[room] acceptance gate on ${room.engine.seat(writer)?.title ?? writer}: ${gaps}`);
  }
  if (blocks)
    throw new MailError(
      "ACCEPT_UNPROVEN",
      `the room did not send this ACCEPT: ${said.join(" | ")}`,
      undefined,
      unrun ? { tool: "seatwork_safety", args: { action: "copy", seat: unrun } } : undefined,
    );
  return {
    line: said.length ? `[room] acceptance gate: ${said.join(" | ")}` : null,
    up,
    keep: () => keeps.forEach((keep) => keep()),
  };
}

/** The seats a mail goes to and is copied to, each one the routes let the sender write to and the app still has. */
async function recipients(
  room: RoomContext,
  from: string,
  args: Record<string, unknown>,
  seats: OpenSeats,
): Promise<Recipients> {
  const eng = room.engine;
  const { to, viaReply, team, thread } = await addressed(room, from, args, seats);
  const cc = (await resolved(room, from, words("cc", args.cc), seats)).filter((seat) => !to.includes(seat));
  const everyone = [...to, ...cc];
  for (const seat of everyone) {
    const check = eng.canWrite(from, seat, viaReply);
    if (!check.ok) throw new MailError("ROUTE_REFUSED", check.reason, await seats.whom());
  }
  const states = await Promise.all(everyone.map((seat) => eng.recipientStatus(seat)));
  const gone = everyone.find((_, index) => states[index] === "gone");
  if (gone) throw new MailError("RECIPIENT_GONE", `${gone} is archived or gone; nothing was sent`, await seats.whom());
  return { to, cc, team, thread, states: new Map(everyone.map((seat, index) => [seat, states[index]])) };
}

/** The mail a seat's arguments make: a subject that opens with a signal, a STOP that goes down to one seat, a body within its size, a team mail that asks nothing, and files that exist. */
function drafted(eng: MailEngine, sender: SeatRecord, args: Record<string, unknown>, where: Recipients): Drafted {
  const { to, cc, team, thread } = where;
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
  if (stops && (to.length !== 1 || team || !eng.isAncestor(sender.agentId, to[0])))
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
  const toWorker = to.length === 1 && eng.isAncestor(sender.agentId, to[0]) && !owns(eng.seat(to[0])?.role);
  const replyTo = replyOf(args);
  const draft: NewMail = {
    from: { agentId: sender.agentId, role: sender.role },
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
  return { draft, opening, stops, toWorker };
}

/** A report to the seat's own parent is noted for its turn's end; one that says the work is finished is kept until then, and its receipt is the answer. */
function keptUp(room: RoomContext, from: string, draft: NewMail, signal: string | undefined): string | null {
  const eng = room.engine;
  const to = [draft.to].flat();
  if (!signal || to.length !== 1 || eng.parentOf(from) !== to[0]) return null;
  room.mailedUp.set(from, (room.mailedUp.get(from) ?? new Set()).add(signal));
  // "my work is finished" is true only once the turn has ended
  if (!CLOSES_WORK.has(signal)) return null;
  const kept = eng.keepReport({
    ...draft,
    cc: [],
    needs: draft.needs === "nothing" ? "reply" : draft.needs,
    why: `the seat ended its turn with ${signal}`,
  });
  return JSON.stringify({
    kept: kept.id,
    thread: kept.thread,
    note: `your report to owner: it is delivered once, when your turn ends. End your turn with ${signal} on the first line; do not send it again.`,
  });
}

/** Whether a mail asks nothing of anyone, so it starts no turn: a team mail, an ACK, a receipt for work under review, or what the decision model reads as informing only. */
async function startsNoTurn(room: RoomContext, draft: NewMail, where: Recipients, toWorker: boolean): Promise<boolean> {
  const { to, cc, team, states } = where;
  const signal = subjectSignal(draft.subject);
  return (
    team ||
    signal === "ACK" ||
    (to.length === 1 && isReceipt(draft.subject, draft.needs, toWorker, room.lastSignal.get(to[0]))) ||
    (await informsOnly(room, draft, states.get(to[0]), cc.length))
  );
}

/** The rounds of repair a task allows, when a mail answers a seat the sender launched: the second offers a tier up, the one past the last is said where its Owner sends it. */
async function roundNote(
  room: RoomContext,
  from: string,
  to: readonly string[],
  opening: string,
): Promise<string | undefined> {
  if (to.length !== 1 || room.engine.parentOf(to[0]) !== from) return undefined;
  const task = taskOf(room, to[0]);
  const before = room.rounds.rejected(task);
  const count = room.rounds.answered(task, opening, to[0]);
  if (count <= before) return undefined;
  if (count >= 3) return note("pastLastRound", { rejected: count });
  if (count === 2) return (await tierUpNote(room.host, room.engine.seat(to[0])!)) ?? undefined;
  return undefined;
}

/** An FYI or a HANDOFF to one idle seat that the decision model is sure asks it nothing: it waits for that seat's next mail. */
async function informsOnly(
  room: RoomContext,
  draft: NewMail,
  status: string | undefined,
  copies: number,
): Promise<boolean> {
  const signal = subjectSignal(draft.subject);
  if (copies > 0 || draft.needs !== "nothing" || status !== "idle" || !signal || !INFORMS.has(signal)) return false;
  if ([draft.to].flat().length !== 1) return false;
  return (await room.forks.take("wake", { subject: draft.subject, body: excerpt(draft.body, 1500) })) === "nothing";
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
      body: `The seat above your Owner stopped this work with: "${subject}", and your running turn was ended for it. Stop where you are: leave the tree as it is, start nothing new, and end your turn with what is finished, what is half-done and where it lies. Your Owner writes next.`,
      needs: "nothing",
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
