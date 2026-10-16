/** Timing for tests that check how work grows with its input. */

/** The fastest of `runs` timings of `small` and of `large` in milliseconds, taken in turns after a warm-up so a busy machine slows both alike. */
export async function fastestInTurns(
  small: () => unknown,
  large: () => unknown,
  runs = 7,
): Promise<[small: number, large: number]> {
  const work = [small, large];
  const best = [Infinity, Infinity];
  await small();
  await large();
  for (let i = 0; i < runs; i += 1)
    for (const which of i % 2 === 0 ? [0, 1] : [1, 0]) {
      const started = process.hrtime.bigint();
      const done = work[which]();
      if (done instanceof Promise) await done;
      best[which] = Math.min(best[which], Number(process.hrtime.bigint() - started) / 1e6);
    }
  return [best[0], best[1]];
}
