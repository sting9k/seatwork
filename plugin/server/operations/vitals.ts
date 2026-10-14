import { storeStats, type StoreStat } from "../sqlite";

/** The room's vital signs, read each minute: how long its event loop was held, its memory, and how its stores did. */

const HELD_MS = 200;
const LAG_TICK_MS = 100;
const MB = 1024 * 1024;
const WAL_MB = 64;

/** The vital signs of the process: lines of trouble each minute, and a reading on demand. */
export class Vitals {
  private readonly seen = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private lagMs = 0;
  private last = { maxMs: 0 };

  constructor(private readonly stats: () => StoreStat[] = storeStats) {
    // a timer that fires late by as long as something held the loop: Node's own delay histogram misses one long hold
    let expected = Date.now() + LAG_TICK_MS;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.lagMs = Math.max(this.lagMs, now - expected);
      expected = now + LAG_TICK_MS;
    }, LAG_TICK_MS);
    this.timer.unref();
  }

  /** The minute's lines of trouble: an event loop held too long, a store with new slow statements, a write-ahead log grown large. */
  minute(): string[] {
    const lines: string[] = [];
    this.last = { maxMs: this.lagMs };
    this.lagMs = 0;
    if (this.last.maxMs >= HELD_MS)
      lines.push(`room: the event loop was slow, held up to ${this.last.maxMs} ms in the last minute`);
    for (const store of this.stats()) {
      const before = this.seen.get(store.file) ?? 0;
      this.seen.set(store.file, store.slow);
      if (store.slow > before)
        lines.push(
          `sqlite: ${store.name} was slow ${store.slow - before} times in the last minute, its slowest so far ${store.slowestMs} ms on ${store.slowest}`,
        );
      if (store.walBytes >= WAL_MB * MB)
        lines.push(
          `sqlite: ${store.name} has a write-ahead log of ${Math.round(store.walBytes / MB)} MB not checkpointed`,
        );
    }
    return lines;
  }

  /** The process now: the last minute's event loop delay, memory, and each open store. */
  reading(): Record<string, unknown> {
    const memory = process.memoryUsage();
    return {
      loop: this.last,
      heapMb: Math.round(memory.heapUsed / MB),
      rssMb: Math.round(memory.rss / MB),
      stores: this.stats().map(({ name, file, calls, slow, slowestMs, walBytes }) => ({
        name,
        file,
        calls,
        slow,
        slowestMs,
        walMb: Math.round((walBytes / MB) * 10) / 10,
      })),
    };
  }

  close(): void {
    clearInterval(this.timer);
  }
}
