import { createHash, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite, type SqliteFailure } from "../sqlite";
import type { Label } from "./council/calibration";

/** The safety store in the room home: decisions, codes, start commits, hand-in findings, the council's log and its appeals to the chair. */

/** A failure of the store itself: the file is held by another process, or its layout does not fit this plugin. */
export class SafetyError extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Who may grant a code: the Owner of the blocked seat, or only the person. */
export type Grantor = "owner" | "human";

/** One decision of the guard about a call. */
export interface DecisionRow {
  seat: string | null;
  role: string | null;
  cli: string;
  cwd: string | null;
  command: string;
  verdict: "allow" | "deny" | "warn" | "log" | "granted" | "unchecked";
  pack: string | null;
  rule: string | null;
  severity: string | null;
  code: string | null;
  elapsedUs: number;
}

/** A one-time code for one call: `hash` binds it to a seat, a folder and a command; one grant and one use. */
export interface CodeRow {
  hash: string;
  code: string;
  seat: string | null;
  cwd: string | null;
  shown: string;
  pack: string;
  rule: string;
  grantor: Grantor;
  created_at: string;
  expires_at: string;
  granted_by: string | null;
  granted_at: string | null;
  used_at: string | null;
}

/** A seat's work as kept: the digest handed in, the last verdict and the digest it was given on. */
export interface SeatWork {
  handed: string | null;
  verdict: "accepted" | "returned" | null;
  verdictDigest: string | null;
}

/** A hand-in finding of a seat, told apart by its fingerprint; `ack` is the seat's reason to keep it. */
export interface FindingRow {
  seat: string;
  fingerprint: string;
  rule: string;
  severity: "block" | "warn";
  path: string;
  line: number;
  text: string;
  first_at: string;
  last_at: string;
  ack: string | null;
  acked_at: string | null;
}

/** What a code is bound to: one seat, one folder, one command, byte for byte. */
export const codeHash = (seat: string | null, cwd: string | null, command: string): string =>
  createHash("sha256")
    .update(JSON.stringify([seat, cwd, command]))
    .digest("hex");

/** The store's file in a folder. */
export const databaseIn = (dir: string): string => join(dir, "safety.db");

function madeDatabaseIn(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return databaseIn(dir);
}

/** One council member's reading of one turn, found or not. */
export interface ReadingRow {
  member: string;
  version: number;
  seat: string;
  role: string | null;
  task: string | null;
  turn: string | null;
  tier: "fact" | "juror";
  zone: "found" | "grey" | "clear" | "skipped";
  score: number | null;
  askId: number | null;
  level: number;
  shown: boolean;
  fingerprint: string | null;
  evidence: string | null;
}

/** A member's level and juror threshold as its labels last set them. */
export interface MemberState {
  member: string;
  version: number;
  level: number;
  hi: number | null;
  labels: number;
  movedAt: string;
}

/** A member's readings over a span, and how its labels fell. */
export interface MemberCount {
  member: string;
  readings: number;
  found: number;
  grey: number;
  shown: number;
  right: number;
  wrong: number;
}

/** One appeal to the chair: who it is about, what was appealed, the evidence sent, and how it stands. */
export interface AppealRow {
  id: number;
  at: string;
  due_at: string;
  reading_id: number;
  member: string;
  seat: string;
  finding: string;
  chair: string;
  status: "open" | "upheld" | "sent_back" | "lapsed";
  ruled_at: string | null;
  ruled_by: string | null;
  reason: string | null;
  packet: string;
}

const PRUNE_BATCH = 2000;
const SEEN_EVERY_MS = 86_400_000;
const FINGERPRINT = /^[0-9a-f]{6,64}$/;

/** The Safety district's SQLite store; every statement it runs has an index. */
export class SafetyStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "safety"),
  ) {
    super(madeDatabaseIn(dir), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new SafetyError(code, message),
      name: "the safety store",
      now,
    });
  }

  /** The time on the store's clock, moved by `offsetMs`. */
  private stamp(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** Keeps one decision; the command is cut to 2000 characters. */
  record(d: DecisionRow): void {
    this.transaction("write", () =>
      this.run(
        "INSERT INTO decisions (at, seat, role, cli, cwd, command, verdict, pack, rule, severity, code, elapsed_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        this.stamp(),
        d.seat,
        d.role,
        d.cli,
        d.cwd,
        d.command.slice(0, 2000),
        d.verdict,
        d.pack,
        d.rule,
        d.severity,
        d.code,
        Math.round(d.elapsedUs),
      ),
    );
  }

  /** The code for a blocked call: the one still open for it, or a new six-digit one. */
  issue(c: {
    hash: string;
    seat: string | null;
    cwd: string | null;
    shown: string;
    pack: string;
    rule: string;
    grantor: Grantor;
    hours: number;
  }): string {
    return this.transaction("write", () => {
      const open = this.row<{ code: string }>(
        "SELECT code FROM codes WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
        c.hash,
        this.stamp(),
      );
      if (open) return open.code;
      let code = "";
      do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      while (this.row("SELECT 1 FROM codes WHERE code = ? AND expires_at > ?", code, this.stamp()));
      this.run(
        "INSERT OR REPLACE INTO codes (hash, code, seat, cwd, shown, pack, rule, grantor, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        c.hash,
        code,
        c.seat,
        c.cwd,
        c.shown.slice(0, 2000),
        c.pack,
        c.rule,
        c.grantor,
        this.stamp(),
        this.stamp(c.hours * 3_600_000),
      );
      return code;
    });
  }

  /** The open codes with this number. */
  byCode(code: string): CodeRow[] {
    return this.rows<CodeRow>(
      "SELECT * FROM codes WHERE code = ? AND expires_at > ? AND used_at IS NULL",
      code,
      this.stamp(),
    );
  }

  /** Grants the open code bound to `hash`, to be used once. */
  grant(hash: string, by: string): void {
    this.transaction("write", () =>
      this.run(
        "UPDATE codes SET granted_by = ?, granted_at = ? WHERE hash = ? AND used_at IS NULL",
        by,
        this.stamp(),
        hash,
      ),
    );
  }

  /** A granted code for exactly this call, used up by it; null when there is none. */
  consume(hash: string): CodeRow | null {
    // nearly every command has no code waiting: a plain read says so without taking the write lock
    if (!this.row("SELECT 1 AS found FROM codes WHERE hash = ? AND granted_at IS NOT NULL AND used_at IS NULL", hash))
      return null;
    return this.transaction("write", () => {
      const row = this.row<CodeRow>(
        "SELECT * FROM codes WHERE hash = ? AND granted_at IS NOT NULL AND used_at IS NULL AND expires_at > ?",
        hash,
        this.stamp(),
      );
      if (!row) return null;
      this.run("UPDATE codes SET used_at = ? WHERE hash = ?", this.stamp(), hash);
      return row;
    });
  }

  /** The codes waiting for a grant, for these seats, newest first. */
  waiting(seats: readonly string[]): CodeRow[] {
    if (!seats.length) return [];
    // one statement for any number of seats: a list of marks would prepare a new one per count
    return this.rows<CodeRow>(
      "SELECT * FROM codes WHERE seat IN (SELECT value FROM json_each(?)) AND granted_at IS NULL AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 50",
      JSON.stringify(seats),
      this.stamp(),
    );
  }

  /** How often a rule held a seat back since a moment. */
  denials(seat: string, rule: string, since: Date): number {
    return (
      this.row<{ n: number }>(
        "SELECT count(*) AS n FROM decisions WHERE seat = ? AND rule = ? AND at > ? AND verdict = 'deny'",
        seat,
        rule,
        since.toISOString(),
      )?.n ?? 0
    );
  }

  /** True the first time a seat's repeated rule is reported since a moment; then noted. */
  escalate(seat: string, rule: string, since: Date): boolean {
    return this.transaction("write", () => {
      if (this.row("SELECT 1 FROM escalations WHERE seat = ? AND rule = ? AND at > ?", seat, rule, since.toISOString()))
        return false;
      this.run("INSERT INTO escalations (seat, rule, at) VALUES (?, ?, ?)", seat, rule, this.stamp());
      return true;
    });
  }

  /** The blocks of a seat since a moment, for the line under its next report. */
  blocksSince(seat: string, since: string): { rule: string; command: string; code: string | null }[] {
    return this.rows(
      "SELECT rule, command, code FROM decisions WHERE seat = ? AND at > ? AND verdict = 'deny' ORDER BY id LIMIT 20",
      seat,
      since,
    );
  }

  /** Where a seat began and on which commit; the first start of a seat stands. */
  noteStart(agentId: string, cwd: string, head: string | null): void {
    this.transaction("write", () =>
      this.run(
        "INSERT OR IGNORE INTO seats (agent_id, cwd, start_head, started_at, seen_at) VALUES (?, ?, ?, ?, ?)",
        agentId,
        cwd,
        head,
        this.stamp(),
        this.stamp(),
      ),
    );
  }

  /** Notes that a seat is still there, at most once a day; false when it was noted lately or is unknown. */
  seen(agentId: string): boolean {
    return this.transaction(
      "write",
      () =>
        this.run(
          "UPDATE seats SET seen_at = ? WHERE agent_id = ? AND seen_at < ?",
          this.stamp(),
          agentId,
          this.stamp(-SEEN_EVERY_MS),
        ).changes > 0,
    );
  }

  /** A successor takes its predecessor's start, so its diff covers the work it took over. */
  inherit(from: string, to: string): void {
    this.transaction("write", () => {
      const was = this.row<{ cwd: string; start_head: string | null; started_at: string }>(
        "SELECT * FROM seats WHERE agent_id = ?",
        from,
      );
      if (was)
        this.run(
          "INSERT OR REPLACE INTO seats (agent_id, cwd, start_head, started_at, seen_at) VALUES (?, ?, ?, ?, ?)",
          to,
          was.cwd,
          was.start_head,
          was.started_at,
          this.stamp(),
        );
    });
  }

  /** Where a seat began, if the room saw it. */
  startOf(agentId: string): { cwd: string; start_head: string | null; started_at: string } | null {
    return this.row("SELECT cwd, start_head, started_at FROM seats WHERE agent_id = ?", agentId) ?? null;
  }

  /** Keeps the digest of the work a seat handed in. */
  noteHandIn(agentId: string, digest: string): void {
    this.transaction("write", () => this.run("UPDATE seats SET handed_digest = ? WHERE agent_id = ?", digest, agentId));
  }

  /** Keeps a verdict and the work's digest; returns what was kept before, null for a seat never seen. */
  noteVerdict(agentId: string, verdict: "accepted" | "returned", digest: string | null): SeatWork | null {
    return this.transaction("write", () => {
      const before = this.row<SeatWork>(
        "SELECT handed_digest AS handed, verdict, verdict_digest AS verdictDigest FROM seats WHERE agent_id = ?",
        agentId,
      );
      if (before)
        this.run("UPDATE seats SET verdict = ?, verdict_digest = ? WHERE agent_id = ?", verdict, digest, agentId);
      return before ? { handed: before.handed, verdict: before.verdict, verdictDigest: before.verdictDigest } : null;
    });
  }

  /** Stores a check's findings for a seat: new ones get a first time, gone ones stay. */
  noteFindings(
    seat: string,
    found: Omit<FindingRow, "seat" | "first_at" | "last_at" | "ack" | "acked_at">[],
  ): FindingRow[] {
    return this.transaction("write", () => {
      const at = this.stamp();
      for (const f of found)
        this.run(
          "INSERT INTO findings (seat, fingerprint, rule, severity, path, line, text, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (seat, fingerprint) DO UPDATE SET last_at = excluded.last_at, line = excluded.line",
          seat,
          f.fingerprint,
          f.rule,
          f.severity,
          f.path,
          f.line,
          f.text.slice(0, 500),
          at,
          at,
        );
      return this.rows<FindingRow>(
        "SELECT * FROM findings WHERE seat = ? AND last_at = ? ORDER BY path, line",
        seat,
        at,
      );
    });
  }

  /** Marks a finding acknowledged, named whole or by a prefix that names no other; false when it names none or several. */
  acknowledge(seat: string, fingerprint: string, reason: string): boolean {
    if (!FINGERPRINT.test(fingerprint)) return false;
    return this.transaction("write", () => {
      const named = this.rows<{ fingerprint: string }>(
        "SELECT fingerprint FROM findings WHERE seat = ? AND fingerprint >= ? AND fingerprint < ? LIMIT 2",
        seat,
        fingerprint,
        `${fingerprint}\uffff`,
      );
      if (named.length !== 1) return false;
      return (
        this.run(
          "UPDATE findings SET ack = ?, acked_at = ? WHERE seat = ? AND fingerprint = ?",
          reason,
          this.stamp(),
          seat,
          named[0].fingerprint,
        ).changes > 0
      );
    });
  }

  /** Drops decisions, escalations and findings older than `before`, codes that ran out by then and seats not seen since; decisions a slice at a time. */
  expire(before: Date): number {
    const at = before.toISOString();
    let gone = 0;
    for (;;) {
      const slice = this.transaction(
        "write",
        () =>
          this.run("DELETE FROM decisions WHERE id IN (SELECT id FROM decisions WHERE at < ? LIMIT ?)", at, PRUNE_BATCH)
            .changes,
      );
      gone += slice;
      if (slice < PRUNE_BATCH) break;
    }
    return (
      gone +
      this.transaction("write", () =>
        [
          this.run("DELETE FROM codes WHERE expires_at < ?", at),
          this.run("DELETE FROM escalations WHERE at < ?", at),
          this.run("DELETE FROM findings WHERE last_at < ?", at),
          this.run("DELETE FROM seats WHERE seen_at < ?", at),
        ].reduce((n, done) => n + done.changes, 0),
      )
    );
  }

  /** A seat that is gone: the commit it began on is no longer needed. */
  forgetSeat(agentId: string): void {
    this.run("DELETE FROM seats WHERE agent_id = ?", agentId);
  }

  /** One council reading; returns its id. */
  read(r: ReadingRow): number {
    return this.transaction("write", () =>
      this.run(
        `INSERT INTO council_readings (at, member, version, seat, role, task, turn, tier, zone, score, ask_id, level,
           shown, fingerprint, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.stamp(),
        r.member,
        r.version,
        r.seat,
        r.role,
        r.task,
        r.turn,
        r.tier,
        r.zone,
        r.score,
        r.askId,
        r.level,
        r.shown ? 1 : 0,
        r.fingerprint,
        r.evidence === null ? null : r.evidence.slice(0, 2000),
      ),
    ).lastInsertRowid;
  }

  /** The seat a council reading is about; null when no such reading is kept. */
  readingSeat(id: number): string | null {
    return this.row<{ seat: string }>("SELECT seat FROM council_readings WHERE id = ?", id)?.seat ?? null;
  }

  /** Whether a member already logged this finding about this seat, shown or not. */
  readBefore(seat: string, member: string, fingerprint: string): boolean {
    return !!this.row(
      "SELECT 1 AS found FROM council_readings WHERE seat = ? AND member = ? AND fingerprint = ? LIMIT 1",
      seat,
      member,
      fingerprint,
    );
  }

  /** Whether a member already showed this finding about this seat. */
  shownBefore(seat: string, member: string, fingerprint: string): boolean {
    return !!this.row(
      "SELECT 1 AS found FROM council_readings WHERE seat = ? AND member = ? AND fingerprint = ? AND shown = 1 LIMIT 1",
      seat,
      member,
      fingerprint,
    );
  }

  /** A label that came later for one reading, the source's last word on it; false when no such reading is kept. */
  labelReading(id: number, source: string, value: "right" | "wrong", note: string | null = null): string | null {
    return this.transaction("write", () => {
      const reading = this.row<{ member: string; version: number }>(
        "SELECT member, version FROM council_readings WHERE id = ?",
        id,
      );
      if (!reading) return null;
      this.run("DELETE FROM council_labels WHERE reading_id = ? AND source = ?", id, source);
      this.run(
        "INSERT INTO council_labels (reading_id, member, version, at, source, value, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        reading.member,
        reading.version,
        this.stamp(),
        source,
        value,
        note,
      );
      return reading.member;
    });
  }

  /** The newest found reading of a member about a seat that `source` has not labelled; a fingerprint prefix narrows it. */
  openFinding(member: string, seat: string, source: string, prefix = "", notTurn: string | null = null): number | null {
    return (
      this.row<{ id: number }>(
        `SELECT r.id FROM council_readings r
           WHERE r.seat = ? AND r.member = ? AND r.zone = 'found'
             AND (? = '' OR (r.fingerprint >= ? AND r.fingerprint < ?))
             AND (? IS NULL OR r.turn IS NOT ?)
             AND NOT EXISTS (SELECT 1 FROM council_labels l WHERE l.reading_id = r.id AND l.source = ?)
           ORDER BY r.id DESC LIMIT 1`,
        seat,
        member,
        prefix,
        prefix,
        `${prefix}\uffff`,
        notTurn,
        notTurn,
        source,
      )?.id ?? null
    );
  }

  /** A member's labels for one version, newest first, with what calibration reads of their readings. */
  labelsOf(member: string, version: number, most: number): Label[] {
    return this.rows<Label>(
      `SELECT l.reading_id AS reading, l.source AS source, l.value AS value, r.task AS task, r.score AS score, r.tier AS tier
         FROM council_labels l JOIN council_readings r ON r.id = l.reading_id
         WHERE l.member = ? AND l.version = ? ORDER BY l.id DESC LIMIT ?`,
      member,
      version,
      most,
    );
  }

  /** How many labels a member has for a version. */
  labelCount(member: string, version: number): number {
    return (
      this.row<{ n: number }>(
        "SELECT count(*) AS n FROM council_labels WHERE member = ? AND version = ?",
        member,
        version,
      )?.n ?? 0
    );
  }

  /** A member's state as last stored, whatever its version. */
  memberState(member: string): MemberState | null {
    return (
      this.row<MemberState>(
        "SELECT member, version, level, hi, labels, moved_at AS movedAt FROM council_members WHERE member = ?",
        member,
      ) ?? null
    );
  }

  /** Stores a member's state. */
  setMemberState(state: Omit<MemberState, "movedAt">): void {
    this.transaction("write", () =>
      this.run(
        `INSERT INTO council_members (member, version, level, hi, labels, moved_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (member) DO UPDATE SET version = excluded.version, level = excluded.level, hi = excluded.hi,
             labels = excluded.labels, moved_at = excluded.moved_at`,
        state.member,
        state.version,
        state.level,
        state.hi,
        state.labels,
        this.stamp(),
      ),
    );
  }

  /** Each member's readings since `since`: how many, found, grey, shown, and how their labels fell. */
  councilCounts(since: string): MemberCount[] {
    return this.rows<MemberCount>(
      `SELECT r.member AS member, count(*) AS readings,
         sum(r.zone = 'found') AS found, sum(r.zone = 'grey') AS grey, sum(r.shown) AS shown,
         sum(EXISTS (SELECT 1 FROM council_labels l WHERE l.reading_id = r.id AND l.value = 'right')) AS right,
         sum(EXISTS (SELECT 1 FROM council_labels l WHERE l.reading_id = r.id AND l.value = 'wrong')) AS wrong
       FROM council_readings r WHERE r.at >= ? GROUP BY r.member ORDER BY r.member`,
      since,
    );
  }

  /** Keeps one appeal to the chair, open until `dueInMs` pass; returns its id. */
  addAppeal(a: {
    readingId: number;
    member: string;
    seat: string;
    finding: string;
    chair: string;
    packet: string;
    dueInMs: number;
  }): number {
    return this.transaction("write", () =>
      this.run(
        "INSERT INTO council_appeals (at, due_at, reading_id, member, seat, finding, chair, status, packet) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)",
        this.stamp(),
        this.stamp(a.dueInMs),
        a.readingId,
        a.member,
        a.seat,
        a.finding,
        a.chair,
        a.packet,
      ),
    ).lastInsertRowid;
  }

  /** One appeal, as it stands. */
  appeal(id: number): AppealRow | null {
    return this.row<AppealRow>("SELECT * FROM council_appeals WHERE id = ?", id) ?? null;
  }

  /** How many appeals wait for a ruling now. */
  openAppeals(): number {
    return (
      this.row<{ n: number }>(
        "SELECT count(*) AS n FROM council_appeals WHERE status = 'open' AND due_at > ?",
        this.stamp(),
      )?.n ?? 0
    );
  }

  /** Whether this finding about this seat is waiting for a ruling or was upheld: one that was sent back or lapsed may be asked again. */
  appealed(seat: string, member: string, finding: string): boolean {
    return !!this.row(
      `SELECT 1 AS found FROM council_appeals WHERE seat = ? AND member = ? AND finding = ?
         AND (status = 'upheld' OR (status = 'open' AND due_at > ?)) LIMIT 1`,
      seat,
      member,
      finding,
      this.stamp(),
    );
  }

  /** Records a ruling on an open appeal; false when it was ruled on already or ran out. */
  rule(id: number, status: "upheld" | "sent_back", by: string, reason: string): boolean {
    return this.transaction(
      "write",
      () =>
        this.run(
          "UPDATE council_appeals SET status = ?, ruled_at = ?, ruled_by = ?, reason = ? WHERE id = ? AND status = 'open' AND due_at > ?",
          status,
          this.stamp(),
          by,
          reason,
          id,
          this.stamp(),
        ).changes > 0,
    );
  }

  /** Drops readings before `before` that no label holds, a slice at a time, and the appeals before it; an appeal whose time is up is marked lapsed first. */
  expireCouncil(before: Date): number {
    let gone = this.transaction("write", () => {
      this.run("UPDATE council_appeals SET status = 'lapsed' WHERE status = 'open' AND due_at <= ?", this.stamp());
      return this.run("DELETE FROM council_appeals WHERE at < ?", before.toISOString()).changes;
    });
    for (;;) {
      const slice = this.transaction(
        "write",
        () =>
          this.run(
            `DELETE FROM council_readings WHERE id IN (
               SELECT r.id FROM council_readings r WHERE r.at < ?
                 AND NOT EXISTS (SELECT 1 FROM council_labels l WHERE l.reading_id = r.id)
               LIMIT ?)`,
            before.toISOString(),
            PRUNE_BATCH,
          ).changes,
      );
      gone += slice;
      if (slice < PRUNE_BATCH) return gone;
    }
  }
}
