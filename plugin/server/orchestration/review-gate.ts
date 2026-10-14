/** The reviewers an Owner launched in one turn are one round: their reports reach the Owner together. */
export class ReviewGate {
  private readonly turns = new Map<string, number>();
  private readonly roundOf = new Map<string, string>();
  private readonly awaited = new Map<string, Set<string>>();

  /** An Owner's turn began: reviewers launched from now on are a new round. */
  turnStarted(owner: string): void {
    this.turns.set(owner, (this.turns.get(owner) ?? 0) + 1);
  }

  /** An Owner that is gone starts no more rounds. */
  ownerGone(owner: string): void {
    this.turns.delete(owner);
  }

  /** A reviewer the Owner launched in its current turn joins that turn's round. */
  launched(owner: string, reviewer: string): void {
    const round = `${owner}:${this.turns.get(owner) ?? 0}`;
    this.roundOf.set(reviewer, round);
    this.awaited.set(round, (this.awaited.get(round) ?? new Set()).add(reviewer));
  }

  /** A reviewer that will send no report; returns its round when nobody else of it is awaited. */
  gone(reviewer: string): string | null {
    const left = this.reported(reviewer);
    return left && left.awaited === 0 ? left.round : null;
  }

  /** A reviewer's report is in, or it left: its round and how many of the round are still to report. */
  reported(reviewer: string): { round: string; awaited: number } | null {
    const round = this.roundOf.get(reviewer);
    if (!round) return null;
    this.roundOf.delete(reviewer);
    const rest = this.awaited.get(round);
    rest?.delete(reviewer);
    if (!rest || rest.size === 0) this.awaited.delete(round);
    return { round, awaited: rest?.size ?? 0 };
  }
}
