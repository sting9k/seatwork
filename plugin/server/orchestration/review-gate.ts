import type { Role } from "./seats";

/** A read-only seat by its title: a Lens, a review or research Peer, a scout of an ultra review. */
const REVIEWER_TITLE = /\[(?:peer:(?:review|research)|lens)\b|\bscout-\d+/i;

export function isReviewer(role: Role, title: string | null): boolean {
  return role === "lens" || REVIEWER_TITLE.test(title ?? "");
}

/** The reviewers an Owner launched in one turn are one round: their reports reach the Owner together. */
export class ReviewGate {
  private readonly turns = new Map<string, number>();
  private readonly roundOf = new Map<string, string>();
  private readonly awaited = new Map<string, Set<string>>();

  turnStarted(owner: string): void {
    this.turns.set(owner, (this.turns.get(owner) ?? 0) + 1);
  }

  launched(owner: string, reviewer: string): void {
    const round = `${owner}:${this.turns.get(owner) ?? 0}`;
    this.roundOf.set(reviewer, round);
    this.awaited.set(round, (this.awaited.get(round) ?? new Set()).add(reviewer));
  }

  /** A reviewer's report is in; returns its round and how many of the round are still to report. */
  reported(reviewer: string): { round: string; awaited: number } | null {
    return this.leaves(reviewer);
  }

  /** A reviewer that will send no report; returns its round when nobody else of it is awaited. */
  gone(reviewer: string): string | null {
    const left = this.leaves(reviewer);
    return left && left.awaited === 0 ? left.round : null;
  }

  private leaves(reviewer: string): { round: string; awaited: number } | null {
    const round = this.roundOf.get(reviewer);
    if (!round) return null;
    this.roundOf.delete(reviewer);
    const rest = this.awaited.get(round);
    rest?.delete(reviewer);
    if (!rest || rest.size === 0) this.awaited.delete(round);
    return { round, awaited: rest?.size ?? 0 };
  }
}
