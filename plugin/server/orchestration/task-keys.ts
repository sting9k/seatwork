import { readJson, writeJson } from "../persisted";

/** The key of the task a seat works on, steady across its issue's states and its own rotations, kept on disk. */

const CHAIN_MOST = 20;

/** A seat's key: an issue it claimed, else the first seat of its rotation chain; `before` are the seats it replaced. */
interface Held {
  key: string;
  issue: boolean;
  before: string[];
}

/** Whether a value read from the file has the shape of a seat's key. */
const isHeld = (value: unknown): value is Held => {
  const held = value as Partial<Held> | null;
  return (
    typeof held?.key === "string" &&
    held.key !== "" &&
    typeof held.issue === "boolean" &&
    Array.isArray(held.before) &&
    held.before.every((seat) => typeof seat === "string")
  );
};

/** The task of each seat that has one beyond its own id: what task-scoped decisions and rounds are filed under. `claimed` is told when a seat's first claim replaces its own id or its chain's head as its key. */
export class TaskKeys {
  private readonly seats = new Map<string, Held>();

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = () => {},
    private readonly claimed: (seat: string, from: string, to: string) => void = () => {},
  ) {
    for (const [seat, held] of Object.entries(readJson<Record<string, unknown>>(file, {})))
      if (isHeld(held)) this.seats.set(seat, held);
  }

  /** The seat's task given the issues it holds in progress now: the first it claimed while held, else a new claim, else the key it had. */
  of(seat: string, held: readonly string[]): string {
    const kept = this.seats.get(seat);
    if (held.length > 0 && !(kept && held.includes(kept.key))) {
      this.seats.set(seat, { key: held[0], issue: true, before: kept?.before ?? [] });
      this.save();
      if (!kept?.issue) this.tell(seat, kept?.key ?? seat, held[0]);
      return held[0];
    }
    return kept?.key ?? seat;
  }

  /** The seat that follows `from` takes its key, and may read the seats before it. */
  succeed(from: string, to: string): void {
    const was = this.seats.get(from) ?? { key: from, issue: false, before: [] };
    this.seats.set(to, { key: was.key, issue: was.issue, before: [...was.before, from].slice(-CHAIN_MOST) });
    this.save();
  }

  /** The seats a seat replaced, oldest first. */
  before(seat: string): readonly string[] {
    return this.seats.get(seat)?.before ?? [];
  }

  /** A seat is gone; the key whose rounds go with it, or null when they are an issue's or another seat still holds the key. */
  forget(seat: string): string | null {
    const was = this.seats.get(seat);
    if (was && this.seats.delete(seat)) this.save();
    const key = was?.key ?? seat;
    if (was?.issue) return null;
    return [...this.seats.values()].some((other) => other.key === key) ? null : key;
  }

  /** Drops the keys of seats `known` no longer names; returns how many. */
  expire(known: (seat: string) => boolean): number {
    const lost = [...this.seats.keys()].filter((seat) => !known(seat));
    for (const seat of lost) this.seats.delete(seat);
    if (lost.length > 0) this.save();
    return lost.length;
  }

  private tell(seat: string, from: string, to: string): void {
    try {
      this.claimed(seat, from, to);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`task keys: what ${seat} recorded under ${from} did not follow it to ${to}: ${reason}`);
    }
  }

  private save(): void {
    try {
      writeJson(this.file, Object.fromEntries(this.seats));
    } catch (error) {
      this.log(`task keys: not written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
