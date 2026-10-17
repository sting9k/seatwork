/** Timing for tests that check how work grows with its input. */

/** The CPU milliseconds this process spent on `work`, its own threads' included: unlike the wall clock, it does not grow when other processes hold the cores. */
async function cpuOf(work: () => unknown): Promise<number> {
  const started = process.cpuUsage();
  const done = work();
  if (done instanceof Promise) await done;
  const used = process.cpuUsage(started);
  return (used.user + used.system) / 1000;
}

/** The least CPU time of `runs` timings of `small` and of `large` in milliseconds, taken in turns after a warm-up so what slows one slows both. */
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
    for (const which of i % 2 === 0 ? [0, 1] : [1, 0]) best[which] = Math.min(best[which], await cpuOf(work[which]));
  return [best[0], best[1]];
}
