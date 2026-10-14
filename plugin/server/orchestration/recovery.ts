import type { SeatState as Liveness } from "../host";
import { readJson, writeJson } from "../persisted";

/** A failed turn: a quota is waited out, a service error tried again, the rest told to the Owner. */

export type FailureKind = "limited" | "service" | "fatal";

export interface RecoveryPolicy {
  delaysSeconds: number[];
  limitedMinutes: number;
  limitedMaxHours: number;
}

export interface Retry {
  agentId: string;
  at: number;
  attempt: number;
  of: number;
  kind: FailureKind;
  message: string;
}

export type Outcome = { retry: Retry } | { gaveUpAfter: number; kind: FailureKind };

const LIMITED =
  /rate[\s._-]?limit|too many requests|quota exceeded|insufficient_quota|usage limit|plan limit|limit (?:reached|will reset)|RESOURCE_EXHAUSTED|throttl|requests? per min|(?:status|error|code|http)\D{0,12}429\b/i;
const FATAL =
  /unauthori[sz]ed|(?:status|error|code|http)\D{0,12}40[13]\b|invalid (?:api )?key|not logged in|log ?in again|authenticat|credit balance|billing|prompt is too long|context (?:length|window)|too many tokens/i;
const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** When a quota message says it lifts, as a time; undefined when it names none the room can read. */
function liftsAt(message: string, now: number): number | undefined {
  const after = /retry[- ]after:?\s*(\d+)/i.exec(message);
  if (after) {
    const value = Number(after[1]);
    // more than a day of seconds is a time, not a wait: kept when it is one in the next two days
    if (value <= 86_400) return now + value * 1000;
    const at = value < 1e12 ? value * 1000 : value;
    return at > now && at < now + 2 * 86_400_000 ? at : undefined;
  }
  const span = /(?:try again|retry|resets?|reset) (?:in|after) (\d+)\s*(s|m|h)/i.exec(message);
  if (span) return now + Number(span[1]) * UNITS[span[2].toLowerCase()] * 1000;
  const clock = /resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!clock) return undefined;
  let hour = Number(clock[1]) % 24;
  if (clock[3]) hour = (hour % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(now);
  at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
  // a clock time already past today is tomorrow's
  return at.getTime() > now ? at.getTime() : at.getTime() + 24 * 3_600_000;
}

/** A quota is waited out, a refused account or prompt goes to the Owner, the rest is tried again. */
export function classify(message: string, now: number): { kind: FailureKind; liftsAt?: number } {
  if (LIMITED.test(message)) return { kind: "limited", liftsAt: liftsAt(message, now) };
  return { kind: FATAL.test(message) ? "fatal" : "service" };
}

interface SeatState {
  attempts: number;
  limitedSince?: number;
  retry?: Retry;
}

export class Recovery {
  private readonly seats = new Map<string, SeatState>();

  constructor(
    private readonly file: string,
    private readonly policy: RecoveryPolicy | undefined,
  ) {
    // an unreadable list starts empty: a seat left failed is seen by its Owner's next look
    for (const [agentId, state] of Object.entries(readJson<Record<string, SeatState>>(file, {})))
      this.seats.set(agentId, state);
  }

  /** A turn failed: the retry the room plans, or after how many tries it gives the seat up. */
  failed(agentId: string, message: string, now: number): Outcome {
    const state = this.seats.get(agentId) ?? { attempts: 0 };
    const { kind, liftsAt: lifts } = classify(message, now);
    // a home an earlier version wrote names no recovery: every failure goes to the Owner, as it did
    if (!this.policy) return { gaveUpAfter: 0, kind };
    const of = this.policy.delaysSeconds.length;
    let at: number | null = null;
    if (kind === "limited") {
      state.limitedSince ??= now;
      const last = state.limitedSince + this.policy.limitedMaxHours * 3_600_000;
      const wanted = lifts ?? now + this.policy.limitedMinutes * 60_000;
      if (now < last) at = Math.min(Math.max(wanted, now + 60_000), last);
    } else if (kind === "service" && state.attempts < of) {
      state.attempts += 1;
      at = now + this.policy.delaysSeconds[state.attempts - 1] * 1000;
    }
    if (at === null) {
      this.seats.delete(agentId);
      this.save();
      return { gaveUpAfter: state.attempts, kind };
    }
    state.retry = { agentId, at, attempt: state.attempts, of, kind, message: message.slice(0, 300) };
    this.seats.set(agentId, state);
    this.save();
    return { retry: state.retry };
  }

  /** The seat finished a turn, or is gone: nothing is held against it. */
  forget(agentId: string): void {
    if (this.seats.delete(agentId)) this.save();
  }

  pending(agentId: string): Retry | undefined {
    return this.seats.get(agentId)?.retry;
  }

  /** The retries whose time has come; each is handed out once. */
  due(now: number): Retry[] {
    const out: Retry[] = [];
    for (const state of this.seats.values()) {
      if (!state.retry || state.retry.at > now) continue;
      out.push(state.retry);
      delete state.retry;
    }
    if (out.length > 0) this.save();
    return out;
  }

  /** The daemon could not say how the seat is: the same retry, a little later. */
  postpone(retry: Retry, at: number): void {
    const state = this.seats.get(retry.agentId);
    if (!state) return;
    state.retry = { ...retry, at };
    this.save();
  }

  private save(): void {
    writeJson(this.file, Object.fromEntries(this.seats));
  }
}

/** The part of the mail engine a resume needs. */
export interface Resumes {
  recipientStatus(agentId: string): Promise<Liveness>;
  post(mail: {
    from: { agentId: string; role: "system" };
    to: string;
    priority: "action";
    subject: string;
    body: string;
    needs: "nothing";
    why: string;
  }): Promise<unknown>;
}

/** Starts again the seats whose retry has come due, when they still are as the failure left them. */
export async function resumeDue(recovery: Recovery, mail: Resumes, now: number): Promise<void> {
  for (const retry of recovery.due(now)) {
    try {
      await resumeOne(recovery, mail, retry, now);
    } catch {
      // the store or the daemon failed this time: the same retry, a little later
      recovery.postpone(retry, now + 60_000);
    }
  }
}

async function resumeOne(recovery: Recovery, mail: Resumes, retry: Retry, now: number): Promise<void> {
  const status = await mail.recipientStatus(retry.agentId);
  if (status === "unknown") recovery.postpone(retry, now + 60_000);
  // gone, or at work again on someone's word: the retry has nothing left to do
  if (status !== "idle") return;
  await mail.post({
    from: { agentId: "room", role: "system" },
    to: retry.agentId,
    priority: "action",
    subject: "RESUME: your last turn stopped on the model service, not on your work",
    body: resumeText(retry),
    needs: "nothing",
    why: "the room starts you again after a failure that was not your work's",
  });
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

/** What the seat reads when the room starts it again. */
export function resumeText(retry: Retry): string {
  const cause =
    retry.kind === "limited"
      ? "Your last turn stopped because the model service was out of quota for this seat"
      : `Your last turn stopped on an error of the model service, not on your work ("${retry.message}")`;
  const count = retry.kind === "limited" ? "" : ` This is try ${retry.attempt} of ${retry.of}.`;
  return `${cause}. Nothing you did is lost, and nobody was told: your Owner still expects the report of that turn. Look at the tree and at your last step first, then continue where you stopped.${count}`;
}

/** How a waiting retry reads in the Owner's view of its seats. */
export function retryNote(retry: Retry): string {
  return retry.kind === "limited"
    ? `out of quota; the room resumes it at ${clock(retry.at)}`
    : `its last turn failed on a service error; the room resumes it at ${clock(retry.at)}, try ${retry.attempt} of ${retry.of}`;
}
