import settings from "../../shared/operations.json";
import { storeStats, type StoreStat } from "../sqlite";

/** The room's vital signs, read each minute: how long its event loop was held, its memory, how its stores did, and the trend of each as a series of minutes. */

const LAG_TICK_MS = 100;
const MB = 1024 * 1024;
const { heldMs: HELD_MS, walMb: WAL_MB, trend: TREND } = settings.vitals;
const RISE = TREND.rise as Record<string, number>;

const round = (value: number): number => Math.round(value * 10) / 10;

/** The vital signs of the process: lines of trouble each minute, a series of each measure, and a reading on demand. */
export class Vitals {
  private readonly seen = new Map<string, number>();
  private readonly series = new Map<string, { kind: string; values: number[]; at: number }>();
  private readonly told = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private lagMs = 0;
  private minutes = 0;
  private last = { maxMs: 0 };

  constructor(
    private readonly stats: () => StoreStat[] = storeStats,
    private readonly gauges: () => Record<string, number> = () => ({}),
    private readonly memory: () => { heapUsed: number; rss: number } = () => process.memoryUsage(),
  ) {
    // a timer that fires late by as long as something held the loop: Node's own delay histogram misses one long hold
    let expected = Date.now() + LAG_TICK_MS;
    this.timer = setInterval(() => {
      const now = Date.now();
      this.lagMs = Math.max(this.lagMs, now - expected);
      expected = now + LAG_TICK_MS;
    }, LAG_TICK_MS);
    this.timer.unref();
  }

  /** The minute's lines of trouble: an event loop held too long, new slow statements, a large write-ahead log, a measure whose low point keeps rising. */
  minute(): string[] {
    const lines: string[] = [];
    this.last = { maxMs: this.lagMs };
    this.lagMs = 0;
    this.minutes += 1;
    if (this.last.maxMs >= HELD_MS)
      lines.push(`room: the event loop was slow, held up to ${this.last.maxMs} ms in the last minute`);
    const memory = this.memory();
    this.sample("room loop ms", "loopMs", this.last.maxMs);
    this.sample("room heap MB", "heapMb", memory.heapUsed / MB);
    this.sample("room rss MB", "rssMb", memory.rss / MB);
    for (const [name, value] of Object.entries(this.gauges())) this.sample(name, name, value);
    const open = new Set<string>();
    for (const store of this.stats()) {
      open.add(store.file);
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
      this.sample(`${store.name} log MB`, "walMb", store.walBytes / MB);
      this.sample(`${store.name} file MB`, "fileMb", store.fileBytes / MB);
    }
    // a store that closed, or a measure no longer given, takes its counts and series with it
    for (const file of this.seen.keys()) if (!open.has(file)) this.seen.delete(file);
    for (const [name, one] of this.series) if (one.at !== this.minutes) this.drop(name);
    return [...lines, ...this.rising()];
  }

  /** Keeps a measure's value for this minute; a series holds its last `keepMinutes`. */
  private sample(name: string, kind: string, value: number): void {
    const one = this.series.get(name) ?? { kind, values: [], at: 0 };
    one.at = this.minutes;
    one.values.push(round(value));
    if (one.values.length > TREND.keepMinutes) one.values.splice(0, one.values.length - TREND.keepMinutes);
    this.series.set(name, one);
  }

  private drop(name: string): void {
    this.series.delete(name);
    this.told.delete(name);
  }

  /** A line for each measure whose low point over the last minutes stands above its low point at the window's start by its kind's rise, told once a window. */
  private rising(): string[] {
    const lines: string[] = [];
    for (const [name, { kind, values }] of this.series) {
      const rise = RISE[kind];
      if (rise === undefined || values.length < TREND.windowMinutes) continue;
      const window = values.slice(-TREND.windowMinutes);
      const before = Math.min(...window.slice(0, TREND.lowPointMinutes));
      const now = Math.min(...window.slice(-TREND.lowPointMinutes));
      const toldAt = this.told.get(name);
      if (now - before < rise || (toldAt !== undefined && this.minutes - toldAt < TREND.windowMinutes)) continue;
      this.told.set(name, this.minutes);
      lines.push(
        `room: ${name} did not come down in the last ${TREND.windowMinutes} minutes: its low point rose from ${before} to ${now}`,
      );
    }
    return lines;
  }

  /** The process now: the last minute's event loop delay, memory, each open store, and the change of each measure over the last 10 and 60 minutes. */
  reading(): Record<string, unknown> {
    const memory = this.memory();
    const change = (values: number[], minutes: number) =>
      values.length > minutes ? round(values[values.length - 1] - values[values.length - 1 - minutes]) : null;
    return {
      loop: this.last,
      heapMb: Math.round(memory.heapUsed / MB),
      rssMb: Math.round(memory.rss / MB),
      stores: this.stats().map(({ name, file, calls, slow, slowestMs, walBytes, fileBytes }) => ({
        name,
        file,
        calls,
        slow,
        slowestMs,
        walMb: round(walBytes / MB),
        fileMb: round(fileBytes / MB),
      })),
      trend: [...this.series].map(([name, { values }]) => ({
        name,
        now: values[values.length - 1],
        change10: change(values, 10),
        change60: change(values, 60),
        minutes: values.length,
      })),
    };
  }

  close(): void {
    clearInterval(this.timer);
  }
}
