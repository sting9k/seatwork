import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL_DIR } from "../paths";
import { Sqlite, type SqliteFailure } from "../sqlite";
import type { Answer } from "./contract";

/** The Jev district's log in the room home: what was asked, what was answered, what was read, and the labels that came later. */

/** A decision log that cannot be used: held by another process, or its layout is newer or invalid; `code` says which. */
class JevStoreError extends Error {
  constructor(
    readonly code: SqliteFailure,
    message: string,
  ) {
    super(message);
  }
}

/** One call as the log keeps it: who asked, of which provider, what it cost, how long it took, and how it failed. */
export interface CallRow {
  caller: string;
  provider: string;
  modelAsked: string;
  model: string | null;
  stateHash: string | null;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  usdSource: "provider" | "price" | null;
  latencyMs: number;
  attempts: number;
  error: string | null;
  suspect?: string | null;
}

const PRUNE_BATCH = 2000;
const ANSWERS_READ_MOST = 5000;

/** The district a caller belongs to: the part of its name before the first dot, colon or at sign. */
export const districtOf = (caller: string): string => caller.split(/[.:@]/, 1)[0] || caller;

/** The number calibration reads: a noul's probability, a choice's confidence, a score. */
const valueOf = (answer: Answer): number =>
  answer.type === "noul" ? answer.noul : answer.type === "choice" ? answer.confidence : answer.score;

/** The decision log: calls with their answers and states, later labels, and the spending kept as running totals. */
export class JevStore extends Sqlite {
  constructor(
    dir: string,
    busyTimeoutMs: number,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "jev"),
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    super(join(dir, "decisions.db"), {
      busyTimeoutMs,
      scripts,
      fail: (code, message) => new JevStoreError(code, message),
      name: "the decision log",
      now,
    });
  }

  /** Logs one call with its answers and the state it read, and adds it to the month's and the day's totals; returns the ids. */
  record(
    call: CallRow,
    answers: Record<string, Answer> = {},
    state?: { hash: string; text: string },
  ): { callId: number; asks: Record<string, number> } {
    const at = this.now().toISOString();
    return this.transaction("write", () => {
      // a state asked about again stays as long as from its last use
      if (state)
        this.run(
          "INSERT INTO states (hash, at, text) VALUES (?, ?, ?) ON CONFLICT (hash) DO UPDATE SET at = excluded.at",
          state.hash,
          at,
          state.text,
        );
      const { lastInsertRowid: callId } = this.run(
        `INSERT INTO calls (at, caller, provider, model_asked, model, state_hash, input_tokens, output_tokens,
           usd, usd_source, latency_ms, attempts, error, suspect) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        at,
        call.caller,
        call.provider,
        call.modelAsked,
        call.model,
        call.stateHash,
        call.inputTokens,
        call.outputTokens,
        call.usd,
        call.usdSource,
        call.latencyMs,
        call.attempts,
        call.error,
        call.suspect ?? null,
      );
      const asks: Record<string, number> = {};
      for (const [question, answer] of Object.entries(answers))
        asks[question] = this.run(
          "INSERT INTO asks (call_id, question, type, value, choice, answer) VALUES (?, ?, ?, ?, ?, ?)",
          callId,
          question,
          answer.type,
          valueOf(answer),
          answer.type === "choice" ? answer.choice : null,
          JSON.stringify(answer),
        ).lastInsertRowid;
      this.run(
        `INSERT INTO spend (month, usd, calls, failed) VALUES (?, ?, 1, ?)
           ON CONFLICT (month) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1, failed = failed + excluded.failed`,
        at.slice(0, 7),
        call.usd ?? 0,
        call.error === null ? 0 : 1,
      );
      this.run(
        `INSERT INTO spend_daily (day, district, usd, calls, failed) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (day, district) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1,
             failed = failed + excluded.failed`,
        at.slice(0, 10),
        districtOf(call.caller),
        call.usd ?? 0,
        call.error === null ? 0 : 1,
      );
      return { callId, asks };
    });
  }

  /** What one month's calls cost, in USD; the month as `YYYY-MM`. */
  spent(month: string): number {
    return this.row<{ usd: number }>("SELECT usd FROM spend WHERE month = ?", month)?.usd ?? 0;
  }

  /** What one district's calls cost on one day, in USD; the day as `YYYY-MM-DD`. */
  spentOn(day: string, district: string): number {
    return (
      this.row<{ usd: number }>("SELECT usd FROM spend_daily WHERE day = ? AND district = ?", day, district)?.usd ?? 0
    );
  }

  /** The answers to the callers in [from, to) since a time, and how many of their calls failed. */
  answersOf(
    from: string,
    to: string,
    since: string,
  ): { answers: { answer: string; suspect: string | null }[]; failed: number } {
    const answers = this.rows<{ answer: string; suspect: string | null }>(
      `SELECT a.answer AS answer, c.suspect AS suspect FROM calls c JOIN asks a ON a.call_id = c.id
         WHERE c.at >= ? AND c.caller >= ? AND c.caller < ? LIMIT ?`,
      since,
      from,
      to,
      ANSWERS_READ_MOST,
    );
    const failed = this.row<{ n: number }>(
      "SELECT COUNT(*) AS n FROM calls WHERE at >= ? AND caller >= ? AND caller < ? AND error IS NOT NULL",
      since,
      from,
      to,
    );
    return { answers: answers.map(({ answer, suspect }) => ({ answer, suspect })), failed: failed?.n ?? 0 };
  }

  /** Each district's calls and failed calls on one day. */
  dayOf(day: string): { district: string; calls: number; failed: number }[] {
    return this.rows<{ district: string; calls: number; failed: number }>(
      "SELECT district, calls, failed FROM spend_daily WHERE day = ? ORDER BY district",
      day,
    ).map(({ district, calls, failed }) => ({ district, calls, failed }));
  }

  /** A label that came later for one answer; false when no such answer is kept. */
  label(askId: number, source: string, value: string, note: string | null = null): boolean {
    return this.transaction("write", () => {
      if (!this.row("SELECT 1 AS found FROM asks WHERE id = ?", askId)) return false;
      this.run(
        "INSERT INTO labels (ask_id, at, source, value, note) VALUES (?, ?, ?, ?, ?)",
        askId,
        this.now().toISOString(),
        source,
        value,
        note,
      );
      return true;
    });
  }

  /** Drops states read before `statesBefore`, the calls before `callsBefore` that no label holds (a slice at a time), and those days' totals. */
  expire(statesBefore: Date, callsBefore: Date): { states: number; calls: number } {
    const states = this.transaction(
      "write",
      () => this.run("DELETE FROM states WHERE at < ?", statesBefore.toISOString()).changes,
    );
    let calls = 0;
    for (;;) {
      const gone = this.transaction(
        "write",
        () =>
          this.run(
            `DELETE FROM calls WHERE id IN (
               SELECT c.id FROM calls c WHERE c.at < ?
                 AND NOT EXISTS (SELECT 1 FROM asks a JOIN labels l ON l.ask_id = a.id WHERE a.call_id = c.id)
               LIMIT ?)`,
            callsBefore.toISOString(),
            PRUNE_BATCH,
          ).changes,
      );
      calls += gone;
      if (gone < PRUNE_BATCH) break;
    }
    this.transaction("write", () =>
      this.run("DELETE FROM spend_daily WHERE day < ?", callsBefore.toISOString().slice(0, 10)),
    );
    return { states, calls };
  }
}
