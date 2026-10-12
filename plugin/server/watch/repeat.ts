import { createHash } from "node:crypto";

/** Finding a seat that goes in circles: actions become fingerprints, and their tail is tested for a run and for a cycle. */

export function digest(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** A failure's output reduced to what stays the same next time: numbers, addresses, temp paths and hashes blanked, last lines only. */
export function failureSignature(output: string): string {
  const lines = output
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-12)
    .map((line) =>
      line
        .replace(/0x[0-9a-f]+/gi, "#")
        .replace(/\b[0-9a-f]{7,40}\b/gi, "#")
        .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, "#")
        .replace(/\d+(?:\.\d+)?/g, "#"),
    );
  return digest(lines.join("\n"));
}

/** How many times the last item repeats at the end of the sequence. */
export function trailingRun(sequence: readonly string[]): number {
  if (sequence.length === 0) return 0;
  const last = sequence[sequence.length - 1];
  let run = 1;
  while (run < sequence.length && sequence[sequence.length - 1 - run] === last) run += 1;
  return run;
}

export interface Cycle {
  /** Length of the repeated pattern, 2 or more. */
  period: number;
  /** Whole copies of the pattern at the end. */
  repeats: number;
}

/**
 * The shortest pattern of 2..maxPeriod items that ends the sequence at least `minRepeats` times, or null.
 * Per period, walk back from the end while item[i] equals item[i - period]: the matches give the copies.
 */
export function trailingCycle(sequence: readonly string[], maxPeriod: number, minRepeats: number): Cycle | null {
  const n = sequence.length;
  for (let period = 2; period <= maxPeriod && period * minRepeats <= n; period += 1) {
    let matched = 0;
    while (matched + period < n && sequence[n - 1 - matched] === sequence[n - 1 - matched - period]) matched += 1;
    const repeats = Math.floor(matched / period) + 1;
    // one item over and over is a run, not a cycle
    const pattern = sequence.slice(n - period);
    if (repeats >= minRepeats && pattern.some((item) => item !== pattern[0])) return { period, repeats };
  }
  return null;
}
