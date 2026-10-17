/** Exact one-sided binomial bounds of a rate, by Clopper-Pearson: what a few labels can and cannot show. */

const CONFIDENCE = 0.9;

/** ln(k!) for k up to n, built once per call. */
function logFactorials(n: number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let k = 2; k <= n; k += 1) out[k] = out[k - 1] + Math.log(k);
  return out;
}

/** P(X >= k) for X binomial with n trials and chance p, summed in log space. */
function upperTail(k: number, n: number, p: number, lf: Float64Array): number {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let sum = 0;
  for (let i = k; i <= n; i += 1)
    sum += Math.exp(lf[n] - lf[i] - lf[n - i] + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, sum);
}

/** The p where a tail that grows with p crosses `target`, by bisection. */
function solve(tail: (p: number) => number, target: number): number {
  let [low, high] = [0, 1];
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (tail(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** The one-sided Clopper-Pearson lower bound of a rate with `hits` of `n`. */
export function lowerBound(hits: number, n: number): number {
  if (n === 0 || hits === 0) return 0;
  const lf = logFactorials(n);
  return solve((p) => upperTail(hits, n, p, lf), 1 - CONFIDENCE);
}

/** The one-sided Clopper-Pearson upper bound of a rate with `hits` of `n`, solved on the complement tail, which rises with p. */
export function upperBound(hits: number, n: number): number {
  if (n === 0 || hits >= n) return 1;
  const lf = logFactorials(n);
  return solve((p) => upperTail(hits + 1, n, p, lf), CONFIDENCE);
}
