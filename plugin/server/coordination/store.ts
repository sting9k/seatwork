import { join } from "node:path";
import config from "../../shared/mail.json";
import { SQL_DIR } from "../paths";
import { Sqlite, keptOutOfGit, type Row, type SqliteFailure } from "../sqlite";
import { noteSettled, type Settled, type SettledLine } from "./archive";

/** A project's mail in SQLite: messages, how each recipient stands with them, what happened. */

export type Needs = "nothing" | "reply" | "decision";
export type Priority = "blocking" | "action" | "fyi";
export type Kind = "to" | "cc" | "team";
export type State = "kept" | "queued" | "sending" | "delivered" | "read" | "bounced" | "replaced" | "withdrawn";

const SETTLED_STATES = config.settled as readonly State[];

export interface Message {
  id: number;
  at: string;
  thread: string;
  replyTo: number | null;
  sender: string;
  senderRole: string;
  signal: string;
  subject: string;
  body: string;
  file: string | null;
  files: string[];
  needs: Needs;
  why: string;
  answeredAt: string | null;
  answeredBy: number | null;
}

export interface Delivery {
  seat: string;
  kind: Kind;
  priority: Priority;
  state: State;
  quiet: boolean;
  progress: boolean;
  urgent: boolean;
  round: string | null;
  heldUntil: string | null;
  deliveredAt: string | null;
  how: string | null;
}

/** A message as one recipient holds it. */
export type Held = Message & Delivery;

export type NewMessage = Pick<Message, "sender" | "senderRole" | "signal" | "subject" | "body" | "needs"> &
  Partial<Pick<Message, "thread" | "replyTo" | "files" | "why">> & {
    fingerprint: string;
    key?: string | null;
  };

export type NewDelivery = Pick<Delivery, "seat" | "kind" | "priority"> &
  Partial<Pick<Delivery, "state" | "quiet" | "progress" | "urgent" | "round" | "heldUntil">>;

/** One line of what was posted, as room stats read it. */
export interface PostedLine {
  at: string;
  id: string;
  from: string;
  to: string;
  priority: string;
  subject: string;
}

export interface Hit {
  id: number;
  at: string;
  thread: string;
  sender: string;
  subject: string;
  snippet: string;
}

export class MailStoreError extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
    this.name = "MailStoreError";
  }
}

export const DRAFT = "draft";
export const TAKEN = "taken";

const MESSAGE = `m.id, m.at, m.thread, m.reply_to, m.sender, m.sender_role, m.signal, m.subject, m.body,
  m.file, m.files, m.needs, m.why, m.answered_at, m.answered_by`;
const DELIVERY = `d.seat, d.kind, d.priority, d.state, d.quiet, d.progress, d.urgent, d.round, d.held_until,
  d.delivered_at, d.how`;
const RECLAIM_PAGES = 4000;
const MAX_ID = Number.MAX_SAFE_INTEGER;
const LIVE = `EXISTS (SELECT 1 FROM deliveries l WHERE l.message_id = m.id AND l.state NOT IN ('replaced', 'withdrawn', 'bounced'))`;
const HELD = `(h.state = 'kept' OR (h.state = 'withdrawn' AND h.how = '${TAKEN}'))`;
const SEEN_BY = `(m.sender IN (SELECT value FROM json_each(?1))
  OR EXISTS (SELECT 1 FROM deliveries s WHERE s.message_id = m.id AND s.seat IN (SELECT value FROM json_each(?1))))`;

const toMessage = (row: Row): Message => ({
  id: Number(row.id),
  at: String(row.at),
  thread: String(row.thread),
  replyTo: row.reply_to === null ? null : Number(row.reply_to),
  sender: String(row.sender),
  senderRole: String(row.sender_role),
  signal: String(row.signal),
  subject: String(row.subject),
  body: String(row.body),
  file: (row.file as string | null) ?? null,
  files: JSON.parse(String(row.files)) as string[],
  needs: row.needs as Needs,
  why: String(row.why),
  answeredAt: (row.answered_at as string | null) ?? null,
  answeredBy: row.answered_by === null ? null : Number(row.answered_by),
});

const toDelivery = (row: Row): Delivery => ({
  seat: String(row.seat),
  kind: row.kind as Kind,
  priority: row.priority as Priority,
  state: row.state as State,
  quiet: row.quiet === 1,
  progress: row.progress === 1,
  urgent: row.urgent === 1,
  round: (row.round as string | null) ?? null,
  heldUntil: (row.held_until as string | null) ?? null,
  deliveredAt: (row.delivered_at as string | null) ?? null,
  how: (row.how as string | null) ?? null,
});

const toHeld = (row: Row): Held => ({ ...toMessage(row), ...toDelivery(row) });

/** A search safe to hand to FTS5: the first `searchWords` words, each quoted, the last open to a longer word; a query's cost grows with the square of its words. */
function ftsQuery(text: string): string {
  const words = (text.match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, config.searchWords);
  return words.map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`).join(" ");
}

function databaseIn(dir: string): string {
  return join(keptOutOfGit(dir), "mail.db");
}

/** A project's mail store: `folder` holds its database, its mail files and its journal. */
export class MailStore extends Sqlite {
  constructor(
    readonly folder: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "mail"),
  ) {
    super(databaseIn(folder), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new MailStoreError(code, message),
      name: "the mail store",
      now,
      reclaims: true,
    });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Writes one line of what happened; every caller is inside a write. */
  private event(kind: string, messageId: number | null, seat: string | null, detail?: unknown, at?: string): void {
    this.run(
      "INSERT INTO events (at, kind, message_id, seat, detail) VALUES (?, ?, ?, ?, ?)",
      at ?? this.stamp(),
      kind,
      messageId,
      seat,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  /** Notes something about the room's mail that changed no message. */
  note(kind: string, seat: string | null, detail?: unknown): void {
    this.transaction("write", () => this.event(kind, null, seat, detail));
  }

  /** How many mails the store holds. */
  count(): number {
    return Number(this.row<{ n: number }>("SELECT count(*) AS n FROM messages")?.n ?? 0);
  }

  /** A message and its deliveries in one write; a thread of its own when it joins none. */
  insert(input: NewMessage, deliveries: readonly NewDelivery[], at: string = this.stamp()): Message {
    const subject = input.subject.slice(0, config.subjectChars);
    return this.transaction("write", () => {
      const { lastInsertRowid: id } = this.run(
        `INSERT INTO messages (at, thread, reply_to, sender, sender_role, signal, subject, body, files,
           needs, why, fingerprint, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        at,
        input.thread ?? "",
        input.replyTo ?? null,
        input.sender,
        input.senderRole,
        input.signal,
        subject,
        input.body,
        JSON.stringify(input.files ?? []),
        input.needs,
        input.why ?? "",
        input.fingerprint,
        input.key ?? null,
      );
      if (!input.thread) this.run("UPDATE messages SET thread = ? WHERE id = ?", `m${id}`, id);
      this.run("INSERT INTO search (rowid, subject, body) VALUES (?, ?, ?)", id, subject, input.body);
      for (const to of deliveries) this.deliver(id, to, { sender: input.sender, subject });
      return this.get(id)!;
    });
  }

  /** Puts back mail read from its files; a delivery the journal names no settled state for is sent once more. */
  restore(entries: readonly { message: Message; deliveries: readonly NewDelivery[] }[], settled: Settled): number {
    return this.transaction("write", () => {
      for (const { message, deliveries } of entries) {
        const subject = message.subject.slice(0, config.subjectChars);
        this.run(
          `INSERT INTO messages (id, at, thread, reply_to, sender, sender_role, signal, subject, body, file, files,
             needs, why, fingerprint, answered_at, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
          message.id,
          message.at,
          message.thread,
          message.replyTo ?? null,
          message.sender,
          message.senderRole,
          message.signal,
          subject,
          message.body,
          message.file,
          JSON.stringify(message.files ?? []),
          message.needs,
          message.why ?? "",
          settled.answers.get(message.id)?.at ?? message.answeredAt ?? null,
          settled.answers.get(message.id)?.by ?? message.answeredBy ?? null,
        );
        this.run("INSERT INTO search (rowid, subject, body) VALUES (?, ?, ?)", message.id, subject, message.body);
        for (const to of deliveries) {
          // settled in the journal stays settled; any other is sent again as a possible repeat
          const state = settled.states.get(`${message.id}|${to.seat}`) ?? "sending";
          this.run(
            "INSERT INTO deliveries (message_id, seat, kind, priority, state, quiet, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            message.id,
            to.seat,
            to.kind,
            to.priority,
            state,
            to.quiet ? 1 : 0,
            state === "sending" ? null : message.at,
          );
          // the record of what was posted comes back with the mail, at the mail's own time
          this.event(
            "posted",
            message.id,
            to.seat,
            { from: message.sender, to: to.seat, subject, priority: to.priority },
            message.at,
          );
        }
      }
      this.event("restored", null, null, { messages: entries.length });
      return entries.length;
    });
  }

  private deliver(id: number, to: NewDelivery, message: Pick<NewMessage, "sender" | "subject">): void {
    this.run(
      `INSERT INTO deliveries (message_id, seat, kind, priority, state, quiet, progress, urgent, round, held_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      to.seat,
      to.kind,
      to.priority,
      to.state ?? "queued",
      to.quiet ? 1 : 0,
      to.progress ? 1 : 0,
      to.urgent ? 1 : 0,
      to.round ?? null,
      to.heldUntil ?? null,
    );
    this.event(to.state === "kept" ? "kept" : "posted", id, to.seat, {
      from: message.sender,
      to: to.seat,
      subject: message.subject,
      priority: to.priority,
    });
  }

  /** One message by id. */
  get(id: number): Message | null {
    const row = this.row(`SELECT ${MESSAGE} FROM messages m WHERE m.id = ?`, id);
    return row ? toMessage(row) : null;
  }

  /** The mail that went out after `id`, oldest first, at most `limit`, with its recipients; a report still kept or taken to go out holds back what follows it, so a reader that keeps its place reads each mail once, as sent. */
  after(id: number, limit: number): (Message & { to: string[] })[] {
    const messages = this.rows(
      `SELECT ${MESSAGE} FROM messages m
       WHERE m.id > ?1
         AND m.id < coalesce((SELECT min(h.message_id) FROM deliveries h INDEXED BY deliveries_held
                              WHERE h.message_id > ?1 AND ${HELD}), ${MAX_ID})
         AND EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND NOT (d.state = 'replaced' AND d.how = '${DRAFT}'))
       ORDER BY m.id LIMIT ?2`,
      id,
      limit,
    ).map(toMessage);
    if (messages.length === 0) return [];
    const to = new Map<number, string[]>();
    for (const row of this.rows<{ message_id: number; seat: string }>(
      "SELECT message_id, seat FROM deliveries WHERE message_id BETWEEN ? AND ? ORDER BY message_id, seat",
      messages[0].id,
      messages[messages.length - 1].id,
    )) {
      const seats = to.get(row.message_id);
      if (seats) seats.push(row.seat);
      else to.set(row.message_id, [row.seat]);
    }
    return messages.map((message) => ({ ...message, to: to.get(message.id) ?? [] }));
  }

  /** The deliveries of one message, a line per recipient. */
  deliveries(id: number): Delivery[] {
    return this.rows(`SELECT ${DELIVERY} FROM deliveries d WHERE d.message_id = ? ORDER BY d.seat`, id).map(toDelivery);
  }

  /** The same text from the same sender since `since`: a retry, not a second mail. */
  duplicate(sender: string, fingerprint: string, since: string): Message | null {
    const row = this.row(
      `SELECT ${MESSAGE} FROM messages m WHERE m.sender = ? AND m.fingerprint = ? AND m.at >= ? AND ${LIVE} ORDER BY m.id LIMIT 1`,
      sender,
      fingerprint,
      since,
    );
    return row ? toMessage(row) : null;
  }

  /** What a sender posted under a key of its own since `since`, with its text's print. */
  byKey(sender: string, key: string, since: string): { message: Message; fingerprint: string } | null {
    const row = this.row(
      `SELECT ${MESSAGE}, m.fingerprint FROM messages m WHERE m.sender = ? AND m.key = ? AND m.at >= ? AND ${LIVE}
       ORDER BY m.id LIMIT 1`,
      sender,
      key,
      since,
    );
    return row ? { message: toMessage(row), fingerprint: String(row.fingerprint) } : null;
  }

  /** What waits for a seat, oldest first: queued, or cut off while it was being sent. */
  queued(seat: string): Held[] {
    return this.rows(
      `SELECT ${MESSAGE}, ${DELIVERY} FROM deliveries d CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.seat = ? AND d.state IN ('queued', 'sending') ORDER BY d.message_id`,
      seat,
    ).map(toHeld);
  }

  /** How many mails wait for each seat that has any, and since when the oldest does. */
  waiting(): Map<string, { count: number; since: string }> {
    const rows = this.rows<{ seat: string; n: number; since: string }>(
      `SELECT d.seat, count(*) AS n, min(m.at) AS since FROM deliveries d CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.state IN ('queued', 'sending') GROUP BY d.seat`,
    );
    return new Map(rows.map((row) => [row.seat, { count: Number(row.n), since: row.since }]));
  }

  /** How many mails wait for one seat, and since when the oldest does; undefined when none does. Reads no body. */
  waitingFor(seat: string): { count: number; since: string } | undefined {
    const row = this.row<{ n: number; since: string | null }>(
      `SELECT count(*) AS n, min(m.at) AS since FROM deliveries d CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.seat = ? AND d.state IN ('queued', 'sending')`,
      seat,
    );
    return row && row.n > 0 ? { count: Number(row.n), since: String(row.since) } : undefined;
  }

  /** Withdraws as expired mail sent only to be read and unread before `before`; never an ask. */
  expire(before: string): number {
    const stale = this.rows<{ message_id: number; seat: string }>(
      `SELECT d.message_id, d.seat FROM deliveries d CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.state = 'queued' AND d.quiet = 1 AND m.needs = 'nothing' AND m.at < ?`,
      before,
    );
    const bySeat = new Map<string, number[]>();
    for (const { message_id, seat } of stale) {
      const ids = bySeat.get(seat);
      if (ids) ids.push(message_id);
      else bySeat.set(seat, [message_id]);
    }
    for (const [seat, ids] of bySeat) this.mark(seat, ids, "withdrawn", "expired");
    return stale.length;
  }

  /** The threads a seat wrote or was written in, newest first: their last mail and how many they hold. */
  threadsOf(seat: string, limit: number): { thread: string; last: Message; count: number }[] {
    return this.rows<{ thread: string; last: number; n: number }>(
      `SELECT m.thread, max(m.id) AS last, count(*) AS n FROM messages m
       WHERE m.sender = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.seat = ?)
       GROUP BY m.thread ORDER BY last DESC LIMIT ?`,
      seat,
      seat,
      limit,
    ).flatMap((row) => {
      const last = this.get(Number(row.last));
      return last ? [{ thread: row.thread, last, count: Number(row.n) }] : [];
    });
  }

  /** Asks answered since `since`: how long each took, in minutes, and how many are still open. */
  replies(since: string): { minutes: number[]; open: number } {
    const answered = this.rows<{ at: string; answered_at: string }>(
      "SELECT at, answered_at FROM messages WHERE needs <> 'nothing' AND answered_at IS NOT NULL AND at >= ?",
      since,
    );
    const open = this.row<{ n: number }>(
      `SELECT count(*) AS n FROM messages m WHERE m.needs <> 'nothing' AND m.answered_at IS NULL AND m.at >= ? AND ${LIVE}`,
      since,
    );
    return {
      minutes: answered.map((row) => (Date.parse(row.answered_at) - Date.parse(row.at)) / 60_000),
      open: Number(open?.n ?? 0),
    };
  }

  /** The refusals of the mail tools since `since`, by code. */
  refusals(since: string): Map<string, number> {
    const rows = this.rows<{ detail: string }>(
      "SELECT detail FROM events INDEXED BY events_by_kind WHERE kind = 'refused' AND at >= ?",
      since,
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      const code = String((JSON.parse(row.detail) as { code?: unknown }).code ?? "?");
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  }

  /** The reports seats wrote before their turn ended, one per seat that has one. */
  kept(sender?: string): Held[] {
    return this.rows(
      `SELECT ${MESSAGE}, ${DELIVERY} FROM deliveries d CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.state = 'kept' AND (?1 IS NULL OR m.sender = ?1) ORDER BY d.message_id`,
      sender ?? null,
    ).map(toHeld);
  }

  /** Moves deliveries of one seat on in their life, `how` noting why (DRAFT: a replaced draft; TAKEN: a report taken to go out); returns how many changed. */
  mark(seat: string, ids: readonly number[], state: State, how?: string): number {
    if (ids.length === 0) return 0;
    const settled = (SETTLED_STATES as readonly string[]).includes(state);
    const notes: SettledLine[] = [];
    const moved = this.transaction("write", () => {
      let changed = 0;
      for (const id of ids) {
        const one = this.run(
          `UPDATE deliveries SET state = ?, how = coalesce(?, how), delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END
           WHERE message_id = ? AND seat = ? AND state <> ?`,
          state,
          how ?? null,
          settled ? 1 : 0,
          this.stamp(),
          id,
          seat,
          state,
        ).changes;
        // a delivery already in this state did not move: no event, no line in the journal
        if (one === 0) continue;
        changed += one;
        this.event(how ? `${state}-${how}` : state, id, seat);
        if (settled) notes.push({ id, seat, state, at: this.stamp() });
      }
      return changed;
    });
    this.journal(notes);
    return moved;
  }

  /** The journal is told what the store settled once it is settled: a journal that fails never undoes it. */
  private journal(notes: readonly SettledLine[]): void {
    if (notes.length === 0) return;
    try {
      noteSettled(this.folder, notes);
    } catch (error) {
      console.error(`seatwork: the mail journal of ${this.folder} missed ${notes.length} lines`, error);
    }
  }

  /** A report taken to go out that did not: kept again, as it was before it was taken. */
  keepAgain(id: number): void {
    this.run("UPDATE deliveries SET state = 'kept' WHERE message_id = ? AND state = 'withdrawn'", id);
  }

  /** Puts back as kept every report taken to go out by a process that stopped before it did; returns how many. */
  keepTaken(): number {
    return this.run(`UPDATE deliveries SET state = 'kept' WHERE state = 'withdrawn' AND how = '${TAKEN}'`).changes;
  }

  /** A kept report goes out: it is queued, for `to` when its recipient changed meanwhile. */
  revive(id: number, to?: string): void {
    this.transaction("write", () => {
      const message = this.get(id);
      if (!message) return;
      for (const row of this.rows<{ seat: string; priority: string }>(
        "SELECT seat, priority FROM deliveries WHERE message_id = ? AND state IN ('kept', 'withdrawn')",
        id,
      )) {
        const seat = to ?? row.seat;
        this.run(
          "UPDATE deliveries SET state = 'queued', seat = ? WHERE message_id = ? AND seat = ?",
          seat,
          id,
          row.seat,
        );
        this.event("posted", id, seat, {
          from: message.sender,
          to: seat,
          subject: message.subject,
          priority: row.priority,
        });
      }
    });
  }

  /** Changes what a kept or held message says before it goes out. */
  revise(id: number, change: Partial<Pick<Message, "body" | "why" | "file">>): void {
    this.transaction("write", () => {
      if (change.body !== undefined) {
        this.run("UPDATE messages SET body = ? WHERE id = ?", change.body, id);
        this.run("UPDATE search SET body = ? WHERE rowid = ?", change.body, id);
      }
      if (change.why !== undefined) this.run("UPDATE messages SET why = ? WHERE id = ?", change.why, id);
      if (change.file !== undefined) this.run("UPDATE messages SET file = ? WHERE id = ?", change.file, id);
    });
  }

  /** Sets how a delivery is held: its round, and until when it starts no turn. */
  hold(id: number, seat: string, round: string | null, heldUntil: string | null): void {
    this.transaction("write", () =>
      this.run(
        "UPDATE deliveries SET round = ?, held_until = ? WHERE message_id = ? AND seat = ?",
        round,
        heldUntil,
        id,
        seat,
      ),
    );
  }

  /** A round's reports wait no longer. */
  release(seat: string, round: string): number {
    return this.transaction(
      "write",
      () =>
        this.run(
          "UPDATE deliveries SET held_until = NULL WHERE seat = ? AND round = ? AND state = 'queued' AND held_until IS NOT NULL",
          seat,
          round,
        ).changes,
    );
  }

  /** What waits for one seat waits for another: a successor takes its mail. */
  readdress(from: string, to: string): number {
    return this.transaction("write", () => {
      const moved = this.run(
        `UPDATE deliveries SET seat = ?2 WHERE seat = ?1
           AND (state IN ('queued', 'kept', 'sending') OR (state IN ('delivered', 'read') AND kind = 'to' AND EXISTS (
             SELECT 1 FROM messages m WHERE m.id = deliveries.message_id AND m.needs <> 'nothing' AND m.answered_at IS NULL)))
           AND NOT EXISTS (SELECT 1 FROM deliveries o WHERE o.message_id = deliveries.message_id AND o.seat = ?2)`,
        from,
        to,
      ).changes;
      if (moved > 0) this.event("readdressed", null, to, { from, moved });
      return moved;
    });
  }

  /** The oldest ask `asker` sent `asked` that nobody answered, in a thread when one is given. */
  openAsks(asker: string, asked: string, thread: string | null, limit: number): Message[] {
    return this.rows(
      `SELECT ${MESSAGE} FROM messages m INDEXED BY messages_owed
       WHERE m.sender = ?1 AND m.needs <> 'nothing' AND m.answered_at IS NULL AND (?3 IS NULL OR m.thread = ?3)
         AND EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.seat = ?2 AND d.kind = 'to')
       ORDER BY m.id LIMIT ?4`,
      asker,
      asked,
      thread,
      limit,
    ).map(toMessage);
  }

  /** An ask got its answer; the first one stands. */
  answer(ask: number, by: number): boolean {
    const answered = this.transaction("write", () => {
      const changed = this.run(
        "UPDATE messages SET answered_at = ?, answered_by = ? WHERE id = ? AND answered_at IS NULL",
        this.stamp(),
        by,
        ask,
      ).changes;
      if (changed > 0) this.event("answered", ask, null, { by });
      return changed > 0;
    });
    if (answered) this.journal([{ id: ask, answeredBy: by, at: this.stamp() }]);
    return answered;
  }

  /** Settles the open asks of `sender` that open with `signal`; returns how many. */
  closeAsks(sender: string, signal: string): number {
    const closed = this.transaction("write", () => {
      const open = this.rows<{ id: number }>(
        "SELECT id FROM messages WHERE sender = ? AND signal = ? AND needs <> 'nothing' AND answered_at IS NULL",
        sender,
        signal,
      );
      for (const { id } of open) {
        this.run("UPDATE messages SET answered_at = ? WHERE id = ?", this.stamp(), id);
        this.event("answered", id, null, { by: null });
      }
      return open.map(({ id }) => id);
    });
    this.journal(closed.map((id) => ({ id, answeredBy: null, at: this.stamp() })));
    return closed.length;
  }

  /** Asks of other seats that reached a seat and wait for its answer, oldest first. */
  owedBy(seat: string): Message[] {
    return this.rows(
      `SELECT ${MESSAGE} FROM deliveries d INDEXED BY deliveries_by_seat CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.seat = ? AND d.state IN ('delivered', 'read') AND d.kind = 'to'
         AND m.needs <> 'nothing' AND m.answered_at IS NULL AND m.sender_role <> 'system' ORDER BY m.id`,
      seat,
    ).map(toMessage);
  }

  /** How many asks `owedBy` lists for a seat, and since when the oldest of them has waited; undefined when none. Reads no body, and from the open asks, so the seat's mail already read costs nothing. */
  owedCount(seat: string): { count: number; since: string } | undefined {
    const row = this.row<{ n: number; since: string | null }>(
      `SELECT count(*) AS n, min(m.at) AS since FROM messages m INDEXED BY messages_owed
         CROSS JOIN deliveries d ON d.message_id = m.id AND d.seat = ?
       WHERE m.needs <> 'nothing' AND m.answered_at IS NULL AND m.sender_role <> 'system'
         AND d.kind = 'to' AND d.state IN ('delivered', 'read')`,
      seat,
    );
    return row && row.n > 0 ? { count: Number(row.n), since: String(row.since) } : undefined;
  }

  /** Asks a seat sent that nobody answered yet, oldest first. */
  owedTo(seat: string): Message[] {
    return this.rows(
      `SELECT ${MESSAGE} FROM messages m INDEXED BY messages_owed
       WHERE m.sender = ? AND m.needs <> 'nothing' AND m.answered_at IS NULL AND ${LIVE} ORDER BY m.id`,
      seat,
    ).map(toMessage);
  }

  /** A thread's messages a reader may see, oldest first; the newest `limit` of them. */
  thread(thread: string, seenBy: readonly string[] | null, limit: number): Message[] {
    return this.rows(
      `SELECT ${MESSAGE} FROM messages m WHERE m.thread = ?2 AND (?1 IS NULL OR ${SEEN_BY}) ORDER BY m.id DESC LIMIT ?3`,
      seenBy ? JSON.stringify(seenBy) : null,
      thread,
      limit,
    )
      .map(toMessage)
      .reverse();
  }

  /** How many mails a thread holds. */
  threadCount(thread: string): number {
    return this.row<{ n: number }>("SELECT count(*) AS n FROM messages WHERE thread = ?", thread)?.n ?? 0;
  }

  /** What a seat sent, newest first. */
  sent(sender: string, limit: number, since?: string): Message[] {
    return this.rows(
      `SELECT ${MESSAGE} FROM messages m WHERE m.sender = ? AND (? IS NULL OR m.at > ?) ORDER BY m.id DESC LIMIT ?`,
      sender,
      since ?? null,
      since ?? null,
      limit,
    ).map(toMessage);
  }

  /** What reached a seat, newest first: its mailbox as history. */
  received(seat: string, limit: number, filter: { since?: string; signal?: string } = {}): Held[] {
    return this.rows(
      `SELECT ${MESSAGE}, ${DELIVERY} FROM deliveries d INDEXED BY deliveries_by_seat
         CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.seat = ?1 AND d.state <> 'kept' AND (?2 IS NULL OR m.at > ?2) AND (?3 IS NULL OR m.signal = ?3)
       ORDER BY d.message_id DESC LIMIT ?4`,
      seat,
      filter.since ?? null,
      filter.signal ?? null,
      limit,
    ).map(toHeld);
  }

  /** Full-text search over what a reader may see, best match first. */
  search(
    text: string,
    seenBy: readonly string[] | null,
    filter: { limit: number; thread?: string; signal?: string; since?: string },
  ): Hit[] {
    const query = ftsQuery(text);
    if (!query) return [];
    return this.rows(
      `SELECT m.id, m.at, m.thread, m.sender, m.subject, snippet(search, 1, '[', ']', ' … ', 16) AS snippet
       FROM search CROSS JOIN messages m ON m.id = search.rowid
       WHERE search MATCH ?2 AND (?1 IS NULL OR ${SEEN_BY})
         AND (?3 IS NULL OR m.thread = ?3) AND (?4 IS NULL OR m.signal = ?4) AND (?5 IS NULL OR m.at > ?5)
       ORDER BY bm25(search, 2.0, 1.0) LIMIT ?6`,
      seenBy ? JSON.stringify(seenBy) : null,
      query,
      filter.thread ?? null,
      filter.signal ?? null,
      filter.since ?? null,
      filter.limit,
    ) as unknown as Hit[];
  }

  /** Whether a reader may see a message: it wrote it, got it, or stands above a seat that did. */
  seen(id: number, seenBy: readonly string[]): boolean {
    return (
      this.row(`SELECT 1 AS yes FROM messages m WHERE m.id = ?2 AND ${SEEN_BY}`, JSON.stringify(seenBy), id) !==
      undefined
    );
  }

  /** What was posted since `since`, a line per recipient, oldest first. */
  posted(since: string): PostedLine[] {
    return this.rows<{ at: string; message_id: number; detail: string }>(
      "SELECT at, message_id, detail FROM events INDEXED BY events_by_kind WHERE kind = 'posted' AND at >= ? ORDER BY seq",
      since,
    ).map((row) => {
      const detail = JSON.parse(row.detail) as { from: string; to: string; subject: string; priority: string };
      return { at: row.at, id: String(row.message_id), ...detail };
    });
  }

  /** Drops what is finished and older than `before`; returns how many mails, the files of those mails and the threads left empty. */
  prune(before: string): {
    messages: number;
    files: Pick<Message, "id" | "at" | "signal">[];
    threads: string[];
    ids: Set<number>;
  } {
    const pruned = this.transaction("write", () => {
      const gone = this.rows<{ id: number; at: string; signal: string; thread: string }>(
        `SELECT m.id, m.at, m.signal, m.thread FROM messages m WHERE m.at < ?
           AND (m.needs = 'nothing' OR m.answered_at IS NOT NULL OR NOT ${LIVE})
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.state IN ('kept', 'queued', 'sending'))`,
        before,
      );
      for (const { id } of gone) {
        this.run("DELETE FROM search WHERE rowid = ?", id);
        this.run("DELETE FROM messages WHERE id = ?", id);
      }
      this.run("DELETE FROM events WHERE at < ?", before);
      const threads = [...new Set(gone.map((row) => row.thread))].filter(
        (thread) => this.row("SELECT 1 AS found FROM messages WHERE thread = ? LIMIT 1", thread) === undefined,
      );
      // a file is found again from what names it, never from a path kept in the store
      const files = gone.map(({ id, at, signal }) => ({ id, at, signal }));
      return { messages: gone.length, files, threads, ids: new Set(gone.map((row) => row.id)) };
    });
    // what the prune freed goes back to the disk, a slice each pass, on a file made to give it back
    if (pruned.messages > 0) this.reclaim(RECLAIM_PAGES);
    return pruned;
  }
}
