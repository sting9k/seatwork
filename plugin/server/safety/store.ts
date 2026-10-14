import { createHash, randomInt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite, type SqliteFailure } from "../sqlite";

/** The safety store in the room home: decisions, codes, start commits, hand-in findings. */

export class SafetyError extends Error {
  constructor(
    readonly code: SqliteFailure | "NO_CODE" | "NOT_YOURS",
    message: string,
  ) {
    super(message);
  }
}

export type Grantor = "owner" | "human";

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

function databaseIn(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "safety.db");
}

export class SafetyStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "safety"),
  ) {
    super(databaseIn(dir), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new SafetyError(code, message),
      name: "the safety store",
      now,
    });
  }

  private stamp(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

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

  /** The code for a blocked command: the one still open for it, or a new six-digit one. */
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

  /** A granted code for exactly this command, used up by this call; null when there is none. */
  consume(hash: string): CodeRow | null {
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

  noteStart(agentId: string, cwd: string, head: string | null): void {
    this.transaction("write", () =>
      this.run(
        "INSERT OR IGNORE INTO seats (agent_id, cwd, start_head, started_at) VALUES (?, ?, ?, ?)",
        agentId,
        cwd,
        head,
        this.stamp(),
      ),
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
          "INSERT OR REPLACE INTO seats (agent_id, cwd, start_head, started_at) VALUES (?, ?, ?, ?)",
          to,
          was.cwd,
          was.start_head,
          was.started_at,
        );
    });
  }

  startOf(agentId: string): { cwd: string; start_head: string | null; started_at: string } | null {
    return this.row("SELECT cwd, start_head, started_at FROM seats WHERE agent_id = ?", agentId) ?? null;
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

  /** A seat's word on one of its findings; false when it is not one of its open ones. */
  acknowledge(seat: string, fingerprint: string, reason: string): boolean {
    return this.transaction(
      "write",
      () =>
        this.run(
          "UPDATE findings SET ack = ?, acked_at = ? WHERE seat = ? AND fingerprint LIKE ?",
          reason,
          this.stamp(),
          seat,
          `${fingerprint}%`,
        ).changes > 0,
    );
  }

  /** Drops decisions, used or lapsed codes and findings older than the keep. */
  expire(before: Date): number {
    const at = before.toISOString();
    return this.transaction("write", () =>
      [
        this.run("DELETE FROM decisions WHERE at < ?", at),
        this.run("DELETE FROM codes WHERE expires_at < ?", at),
        this.run("DELETE FROM escalations WHERE at < ?", at),
        this.run("DELETE FROM findings WHERE last_at < ?", at),
      ].reduce((n, done) => n + done.changes, 0),
    );
  }
}
