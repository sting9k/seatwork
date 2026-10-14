import { join } from "node:path";
import config from "../../shared/mail.json";
import { SQL_DIR } from "../paths";
import { Sqlite, storeFolder, type Param, type Row, type SqliteFailure } from "../sqlite";

/** A project's mail in SQLite: messages, how each recipient stands with them, what happened. */

export type Needs = "nothing" | "reply" | "decision";
export type Priority = "blocking" | "action" | "fyi";
export type Kind = "to" | "cc" | "team";
export type State = "kept" | "queued" | "sending" | "delivered" | "read" | "bounced" | "replaced" | "withdrawn";

export const OPEN_STATES = config.states.open as readonly State[];
export const SETTLED_STATES = config.states.settled as readonly State[];

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

/** One line of what was posted, as room stats and the watcher's calibration read it. */
export interface PostedLine {
  at: string;
  kind: "queued";
  id: string;
  from: string;
  to: string;
  priority: string;
  subject: string;
}

export interface MailEvent {
  seq: number;
  at: string;
  kind: string;
  messageId: number | null;
  seat: string | null;
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

const MESSAGE = `m.id, m.at, m.thread, m.reply_to, m.sender, m.sender_role, m.signal, m.subject, m.body,
  m.file, m.files, m.needs, m.why, m.answered_at, m.answered_by`;
const DELIVERY = `d.seat, d.kind, d.priority, d.state, d.quiet, d.progress, d.urgent, d.round, d.held_until,
  d.delivered_at, d.how`;
/** The seats a reader may see mail of, handed over as one JSON list. */
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

/** A phrase search safe to hand to FTS5: each word quoted, the last one open to a longer word. */
function ftsQuery(text: string): string {
  const words = text.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`).join(" ");
}

/** The folder made, and the database file in it. */
function databaseIn(dir: string): string {
  return join(storeFolder(dir), "mail.db");
}

export class MailStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "mail"),
  ) {
    super(databaseIn(dir), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new MailStoreError(code, message),
      name: "the mail store",
      now,
    });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /** Writes one line of what happened; every caller is inside a write. */
  private event(kind: string, messageId: number | null, seat: string | null, detail?: unknown): void {
    this.run(
      "INSERT INTO events (at, kind, message_id, seat, detail) VALUES (?, ?, ?, ?, ?)",
      this.stamp(),
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

  count(): number {
    return Number(this.row<{ n: number }>("SELECT count(*) AS n FROM messages")?.n ?? 0);
  }

  /** A message and its deliveries in one write; a thread of its own when it joins none. */
  insert(input: NewMessage, deliveries: readonly NewDelivery[], at: string = this.stamp()): Message {
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
        input.subject.slice(0, config.subjectChars),
        input.body,
        JSON.stringify(input.files ?? []),
        input.needs,
        input.why ?? "",
        input.fingerprint,
        input.key ?? null,
      );
      if (!input.thread) this.run("UPDATE messages SET thread = ? WHERE id = ?", `m${id}`, id);
      this.run("INSERT INTO search (rowid, subject, body) VALUES (?, ?, ?)", id, input.subject, input.body);
      for (const to of deliveries) this.deliver(id, to, input);
      return this.get(id)!;
    });
  }

  /** Puts back mail read from its files; what is younger than `again` is sent once more. */
  restore(entries: readonly { message: Message; deliveries: readonly NewDelivery[] }[], again: string): number {
    return this.transaction("write", () => {
      for (const { message, deliveries } of entries) {
        this.run(
          `INSERT INTO messages (id, at, thread, reply_to, sender, sender_role, signal, subject, body, file, files,
             needs, why, fingerprint, answered_at, answered_by) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
          message.id,
          message.at,
          message.thread,
          message.sender,
          message.senderRole,
          message.signal,
          message.subject.slice(0, config.subjectChars),
          message.body,
          message.file,
          JSON.stringify(message.files ?? []),
          message.needs,
          message.why ?? "",
          message.answeredAt ?? null,
          message.answeredBy ?? null,
        );
        this.run(
          "INSERT INTO search (rowid, subject, body) VALUES (?, ?, ?)",
          message.id,
          message.subject,
          message.body,
        );
        for (const to of deliveries)
          this.run(
            "INSERT INTO deliveries (message_id, seat, kind, priority, state, delivered_at) VALUES (?, ?, ?, ?, ?, ?)",
            message.id,
            to.seat,
            to.kind,
            to.priority,
            message.at >= again ? "sending" : "delivered",
            message.at >= again ? null : message.at,
          );
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

  get(id: number): Message | null {
    const row = this.row(`SELECT ${MESSAGE} FROM messages m WHERE m.id = ?`, id);
    return row ? toMessage(row) : null;
  }

  deliveries(id: number): Delivery[] {
    return this.rows(`SELECT ${DELIVERY} FROM deliveries d WHERE d.message_id = ? ORDER BY d.seat`, id).map(toDelivery);
  }

  /** The same text from the same sender since `since`: a retry, not a second mail. */
  duplicate(sender: string, fingerprint: string, since: string): Message | null {
    const row = this.row(
      `SELECT ${MESSAGE} FROM messages m WHERE m.sender = ? AND m.fingerprint = ? AND m.at >= ? ORDER BY m.id LIMIT 1`,
      sender,
      fingerprint,
      since,
    );
    return row ? toMessage(row) : null;
  }

  /** What a sender posted under a key of its own since `since`, with its text's print. */
  byKey(sender: string, key: string, since: string): { message: Message; fingerprint: string } | null {
    const row = this.row(
      `SELECT ${MESSAGE}, m.fingerprint FROM messages m WHERE m.sender = ? AND m.key = ? AND m.at >= ?
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

  /** How many mails wait for each seat that has any. */
  waiting(): Map<string, number> {
    const rows = this.rows<{ seat: string; n: number }>(
      "SELECT seat, count(*) AS n FROM deliveries WHERE state IN ('queued', 'sending') GROUP BY seat",
    );
    return new Map(rows.map((row) => [row.seat, Number(row.n)]));
  }

  /** The reports seats wrote before their turn ended, one per seat that has one. */
  kept(sender?: string): Held[] {
    return this.rows(
      `SELECT ${MESSAGE}, ${DELIVERY} FROM deliveries d CROSS JOIN messages m ON m.id = d.message_id
       WHERE d.state = 'kept' AND (?1 IS NULL OR m.sender = ?1) ORDER BY d.message_id`,
      sender ?? null,
    ).map(toHeld);
  }

  /** Moves deliveries of one seat on in their life; returns how many changed. */
  mark(seat: string, ids: readonly number[], state: State, how?: string): number {
    if (ids.length === 0) return 0;
    return this.transaction("write", () => {
      const settled = (SETTLED_STATES as readonly string[]).includes(state);
      let changed = 0;
      for (const id of ids) {
        changed += this.run(
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
        this.event(how ? `${state}-${how}` : state, id, seat);
      }
      return changed;
    });
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
        `UPDATE deliveries SET seat = ?2 WHERE seat = ?1 AND state IN ('queued', 'kept')
           AND NOT EXISTS (SELECT 1 FROM deliveries o WHERE o.message_id = deliveries.message_id AND o.seat = ?2)`,
        from,
        to,
      ).changes;
      if (moved > 0) this.event("readdressed", null, to, { from, moved });
      return moved;
    });
  }

  /** The oldest ask `asker` sent `asked` that nobody answered, in a thread when one is given. */
  openAsk(asker: string, asked: string, thread?: string): Message | null {
    const row = this.row(
      `SELECT ${MESSAGE} FROM messages m INDEXED BY messages_owed
       WHERE m.sender = ?1 AND m.needs <> 'nothing' AND m.answered_at IS NULL AND (?3 IS NULL OR m.thread = ?3)
         AND EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.seat = ?2 AND d.kind = 'to')
       ORDER BY m.id LIMIT 1`,
      asker,
      asked,
      thread ?? null,
    );
    return row ? toMessage(row) : null;
  }

  /** An ask got its answer; the first one stands. */
  answer(ask: number, by: number): boolean {
    return this.transaction("write", () => {
      const changed = this.run(
        "UPDATE messages SET answered_at = ?, answered_by = ? WHERE id = ? AND answered_at IS NULL",
        this.stamp(),
        by,
        ask,
      ).changes;
      if (changed > 0) this.event("answered", ask, null, { by });
      return changed > 0;
    });
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

  /** Asks a seat sent that nobody answered yet, oldest first. */
  owedTo(seat: string): Message[] {
    return this.rows(
      `SELECT ${MESSAGE} FROM messages m INDEXED BY messages_owed
       WHERE m.sender = ? AND m.needs <> 'nothing' AND m.answered_at IS NULL ORDER BY m.id`,
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
      return { at: row.at, kind: "queued", id: String(row.message_id), ...detail };
    });
  }

  /** What happened after a place in the record: a feed a monitor reads from where it stopped. */
  events(after: number, limit: number): MailEvent[] {
    return this.rows<MailEvent>(
      "SELECT seq, at, kind, message_id AS messageId, seat FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
      after,
      limit,
    );
  }

  /** Drops what is finished and older than `before`; returns the files of those messages. */
  prune(before: string, stays: (subject: string) => boolean): { messages: number; files: string[] } {
    return this.transaction("write", () => {
      const gone = this.rows<{ id: number; file: string | null }>(
        `SELECT m.id, m.file FROM messages m WHERE m.at < ?
           AND (m.needs = 'nothing' OR m.answered_at IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.state IN ('kept', 'queued', 'sending'))`,
        before,
      );
      for (const { id } of gone) {
        this.run("DELETE FROM search WHERE rowid = ?", id);
        this.run("DELETE FROM messages WHERE id = ?", id);
      }
      // a verdict's line stays: the watcher's statistics are fitted to them
      for (const row of this.rows<{ seq: number; kind: string; detail: string | null }>(
        "SELECT seq, kind, detail FROM events WHERE at < ?",
        before,
      )) {
        const subject =
          row.kind === "posted" && row.detail ? String((JSON.parse(row.detail) as Row).subject ?? "") : "";
        if (!subject || !stays(subject)) this.run("DELETE FROM events WHERE seq = ?", row.seq);
      }
      return { messages: gone.length, files: gone.flatMap((row) => (row.file ? [row.file] : [])) };
    });
  }

  /** How SQLite will run one of this store's lookups, for the test that each has its index. */
  explain(sql: string, ...params: Param[]): string {
    return (this.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((row) => row.detail)
      .join("\n");
  }
}
