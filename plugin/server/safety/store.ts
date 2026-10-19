import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite } from "../sqlite";
import type { Label } from "./council/calibration";

/** The safety store: guard record, starts, hand-ins, gate records, council log. */

/** A call a rule of the guard held for, as the guard saw it. */
interface DecisionRow {
  seat: string | null;
  role: string | null;
  cli: string;
  cwd: string | null;
  command: string;
  pack: string | null;
  rule: string | null;
  severity: string | null;
  elapsedUs: number;
}

/** A call the guard kept: when, whose, where, the command as kept, and the rule that held for it. */
export interface KeptCall {
  at: string;
  seat: string | null;
  role: string | null;
  cli: string;
  cwd: string | null;
  command: string;
  pack: string | null;
  rule: string | null;
  severity: string | null;
}

/** A seat's work as kept: the digest handed in, the last verdict and the digest it was given on. */
interface SeatWork {
  handed: string | null;
  verdict: "accepted" | "returned" | null;
  verdictDigest: string | null;
}

/** The work a seat handed in: digest, HEAD (null when unread), when, and the folder it is in (null: where the seat started). */
export interface HandedWork {
  digest: string;
  head: string | null;
  at: string;
  cwd: string | null;
}

/** An ACCEPT the gate passed; `repo` is the git common folder, `base` the start. */
export interface AcceptRow {
  id: number;
  accepter: string;
  task: string;
  writer: string;
  repo: string;
  base: string;
  head: string;
  digest: string;
  commands: string;
}

/** A push; `uncovered` counts commits no gate holds, -1 when unknown. */
export interface PushRow {
  seat: string;
  repo: string;
  remote: string;
  ref: string;
  sha: string;
  uncovered: number;
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
interface AppealRow {
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

const SEEN_EVERY_MS = 86_400_000;
const FINGERPRINT = /^[0-9a-f]{6,64}$/;
const ACCEPT_COMMANDS = 20;

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
      name: "the safety store",
      now,
    });
  }

  /** The time on the store's clock, moved by `offsetMs`. */
  private stamp(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** Keeps one call a rule held for; the command is cut to 2000 characters. */
  record(d: DecisionRow): void {
    this.transaction("write", () =>
      this.run(
        "INSERT INTO decisions (at, seat, role, cli, cwd, command, pack, rule, severity, elapsed_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        this.stamp(),
        d.seat,
        d.role,
        d.cli,
        d.cwd,
        d.command.slice(0, 2000),
        d.pack,
        d.rule,
        d.severity,
        Math.round(d.elapsedUs),
      ),
    );
  }

  /** The calls the guard kept since a time, of one seat when named, newest first and at most `most`: the guard's audit log. */
  kept(since: string, most: number, seat: string | null = null): KeptCall[] {
    return this.rows<KeptCall>(
      `SELECT at, seat, role, cli, cwd, command, pack, rule, severity FROM decisions INDEXED BY decisions_by_at
       WHERE at >= ?1 AND (?2 IS NULL OR seat = ?2) ORDER BY at DESC, id DESC LIMIT ?3`,
      since,
      seat,
      most,
    );
  }

  /** How many calls each rule held for since a time, most first. */
  keptCounts(since: string): { rule: string; n: number }[] {
    return this.rows<{ rule: string; n: number }>(
      `SELECT coalesce(pack, '') || ':' || coalesce(rule, '') AS rule, count(*) AS n FROM decisions INDEXED BY decisions_by_at
       WHERE at >= ? GROUP BY pack, rule ORDER BY n DESC, rule`,
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

  /** Notes the commit a repository stands at when it has none yet; a later start there only keeps it seen. */
  noteBase(commonDir: string, head: string): void {
    this.transaction("write", () =>
      this.run(
        "INSERT INTO repo_bases (common_dir, head, seen_at) VALUES (?, ?, ?) ON CONFLICT(common_dir) DO UPDATE SET seen_at = excluded.seen_at",
        commonDir,
        head,
        this.stamp(),
      ),
    );
  }

  /** The commit the room first saw a repository at, by its git common folder. */
  baseOf(commonDir: string): string | null {
    return this.row<{ head: string }>("SELECT head FROM repo_bases WHERE common_dir = ?", commonDir)?.head ?? null;
  }

  /** Where a seat began, if the room saw it. */
  startOf(agentId: string): { cwd: string; start_head: string | null; started_at: string } | null {
    return this.row("SELECT cwd, start_head, started_at FROM seats WHERE agent_id = ?", agentId) ?? null;
  }

  /** Keeps the work a seat hands in: digest, HEAD, time and the folder it is in. */
  noteHandIn(agentId: string, digest: string, head: string | null, cwd: string | null = null): void {
    this.transaction("write", () =>
      this.run(
        "UPDATE seats SET handed_digest = ?, handed_head = ?, handed_at = ?, handed_cwd = ? WHERE agent_id = ?",
        digest,
        head,
        this.stamp(),
        cwd,
        agentId,
      ),
    );
  }

  /** The work a seat handed in last; null when none is on record. */
  handedOf(agentId: string): HandedWork | null {
    return (
      this.row<HandedWork>(
        "SELECT handed_digest AS digest, handed_head AS head, handed_at AS at, handed_cwd AS cwd FROM seats WHERE agent_id = ? AND handed_digest IS NOT NULL AND handed_at IS NOT NULL",
        agentId,
      ) ?? null
    );
  }

  /** The blocking findings of the hand-in pass begun at `at`. */
  blockingSince(seat: string, at: string, most: number): FindingRow[] {
    return this.rows<FindingRow>(
      "SELECT * FROM findings WHERE seat = ? AND severity = 'block' AND last_at >= ? ORDER BY path, line LIMIT ?",
      seat,
      at,
      most,
    );
  }

  /** Keeps an ACCEPT the gate passed, its commands cut to size. */
  noteAccept(a: Omit<AcceptRow, "id" | "commands"> & { commands: readonly string[] }): void {
    this.transaction("write", () =>
      this.run(
        "INSERT INTO accepts (at, accepter, task, writer, repo, base, head, digest, commands) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        this.stamp(),
        a.accepter,
        a.task.slice(0, 255),
        a.writer,
        a.repo,
        a.base,
        a.head,
        a.digest,
        JSON.stringify(a.commands.slice(0, ACCEPT_COMMANDS).map((command) => command.slice(0, 200))),
      ),
    );
  }

  /** The newest open ACCEPT of each task `accepter` gave. */
  openAccepts(accepter: string, most: number): AcceptRow[] {
    return this.rows<AcceptRow>(
      `SELECT id, accepter, task, writer, repo, base, head, digest, commands FROM accepts
         WHERE id IN (SELECT max(id) FROM accepts WHERE accepter = ?1 AND done_at IS NULL GROUP BY task)
         ORDER BY id LIMIT ?2`,
      accepter,
      most,
    );
  }

  /** Keeps a DONE and marks its seat's ACCEPTs before it covered. */
  noteDone(seat: string, repo: string, head: string): void {
    this.transaction("write", () => {
      const at = this.stamp();
      this.run("INSERT INTO dones (at, seat, repo, head) VALUES (?, ?, ?, ?)", at, seat, repo, head);
      this.run("UPDATE accepts SET done_at = ? WHERE accepter = ? AND done_at IS NULL", at, seat);
    });
  }

  /** The newest ACCEPT and DONE heads of a repository. */
  headsIn(repo: string, most: number): string[] {
    const heads = this.rows<{ head: string }>(
      `SELECT head FROM (SELECT head FROM accepts WHERE repo = ?1 ORDER BY id DESC LIMIT ?2)
       UNION SELECT head FROM (SELECT head FROM dones WHERE repo = ?1 ORDER BY id DESC LIMIT ?2)`,
      repo,
      most,
    );
    return heads.map(({ head }) => head);
  }

  /** Keeps a push a seat made. */
  notePush(p: PushRow): void {
    this.transaction("write", () =>
      this.run(
        "INSERT INTO pushes (at, seat, repo, remote, ref, sha, uncovered) VALUES (?, ?, ?, ?, ?, ?, ?)",
        this.stamp(),
        p.seat,
        p.repo,
        p.remote.slice(0, 255),
        p.ref.slice(0, 255),
        p.sha,
        p.uncovered,
      ),
    );
  }

  /** Drops covered records before `before`, and open ACCEPTs past `openMost`. */
  expireGates(before: Date, openMost: number): { gone: number; dropped: number } {
    const at = [before.toISOString()];
    const gone =
      this.deleteInSlices(
        "DELETE FROM accepts WHERE id IN (SELECT id FROM accepts WHERE done_at IS NOT NULL AND done_at < ? LIMIT ?)",
        at,
      ) +
      this.deleteInSlices("DELETE FROM dones WHERE id IN (SELECT id FROM dones WHERE at < ? LIMIT ?)", at) +
      this.deleteInSlices("DELETE FROM pushes WHERE id IN (SELECT id FROM pushes WHERE at < ? LIMIT ?)", at);
    const open = this.row<{ n: number }>("SELECT count(*) AS n FROM accepts WHERE done_at IS NULL")?.n ?? 0;
    const over = Math.max(0, open - openMost);
    const dropped = over
      ? this.transaction(
          "write",
          () =>
            this.run(
              "DELETE FROM accepts WHERE id IN (SELECT id FROM accepts WHERE done_at IS NULL ORDER BY id LIMIT ?)",
              over,
            ).changes,
        )
      : 0;
    return { gone, dropped };
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

  /** Drops what the guard saw and the findings older than `before`, and seats not seen since; the guard's records a slice at a time. */
  expire(before: Date): number {
    const at = before.toISOString();
    const gone = this.deleteInSlices(
      "DELETE FROM decisions WHERE id IN (SELECT id FROM decisions WHERE at < ? LIMIT ?)",
      [at],
    );
    return (
      gone +
      this.transaction("write", () =>
        [
          this.run("DELETE FROM findings WHERE last_at < ?", at),
          this.run("DELETE FROM seats WHERE seen_at < ?", at),
          this.run("DELETE FROM repo_bases WHERE seen_at < ?", at),
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

  /** Notes that these readings reached the seat above. */
  markShown(ids: readonly number[]): void {
    if (!ids.length) return;
    this.transaction("write", () =>
      this.run(
        "UPDATE council_readings SET shown = 1 WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      ),
    );
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
    const appeals = this.transaction("write", () => {
      this.run("UPDATE council_appeals SET status = 'lapsed' WHERE status = 'open' AND due_at <= ?", this.stamp());
      return this.run("DELETE FROM council_appeals WHERE at < ?", before.toISOString()).changes;
    });
    return (
      appeals +
      this.deleteInSlices(
        `DELETE FROM council_readings WHERE id IN (
           SELECT r.id FROM council_readings r WHERE r.at < ?
             AND NOT EXISTS (SELECT 1 FROM council_labels l WHERE l.reading_id = r.id)
           LIMIT ?)`,
        [before.toISOString()],
      )
    );
  }
}
