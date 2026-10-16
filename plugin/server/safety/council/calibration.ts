import council from "../../../shared/safety/council.json";
import { lowerBound, upperBound } from "../../bounds";

/** How labels move a council member: exact binomial bounds, the level they allow, a juror's threshold. */

/** One label with what calibration reads of the reading it is about. */
export interface Label {
  reading: number;
  source: string;
  value: "right" | "wrong";
  task: string | null;
  score: number | null;
  tier: "fact" | "juror";
}

const BARS: readonly { level: number; labels: number; tasks: number; lower: number }[] = council.bars;
const RECENT = 20;
const AGREEMENT = { least: 10, rate: 0.8 };

const isExplicit = (source: string): boolean => source.startsWith("seat:");

/** The implied sources whose labels agree with the seats' own on the same readings, often enough to count. */
function trustedSources(labels: readonly Label[]): Set<string> {
  const said = new Map<number, string>();
  for (const label of labels) if (isExplicit(label.source)) said.set(label.reading, label.value);
  const tally = new Map<string, { same: number; all: number }>();
  for (const label of labels) {
    const own = said.get(label.reading);
    if (isExplicit(label.source) || own === undefined) continue;
    const count = tally.get(label.source) ?? { same: 0, all: 0 };
    count.all += 1;
    if (own === label.value) count.same += 1;
    tally.set(label.source, count);
  }
  return new Set(
    [...tally]
      .filter(([, count]) => count.all >= AGREEMENT.least && count.same / count.all >= AGREEMENT.rate)
      .map(([source]) => source),
  );
}

/** One label per reading, newest first: the seat's own word wins over any implied one. */
export function counted(labels: readonly Label[]): Label[] {
  const trusted = trustedSources(labels);
  const best = new Map<number, Label>();
  for (const label of labels) {
    if (!isExplicit(label.source) && !trusted.has(label.source)) continue;
    const held = best.get(label.reading);
    if (!held || (isExplicit(label.source) && !isExplicit(held.source))) best.set(label.reading, label);
  }
  return [...best.values()];
}

/** The level a member's counted labels allow; a member already up drops one level when its recent labels fail it. */
export function levelFor(labels: readonly Label[], current: number): number {
  const right = labels.filter((label) => label.value === "right").length;
  const tasks = new Set(labels.map((label) => label.task ?? `reading:${label.reading}`)).size;
  let level = 0;
  for (const bar of BARS)
    if (labels.length >= bar.labels && tasks >= bar.tasks && lowerBound(right, labels.length) >= bar.lower)
      level = bar.level;
  const recent = labels.slice(0, RECENT);
  const bar = BARS.find((one) => one.level === current);
  if (bar && recent.length === RECENT) {
    const recentRight = recent.filter((label) => label.value === "right").length;
    if (lowerBound(recentRight, RECENT) < bar.lower) level = Math.min(level, current - 1);
  }
  return level;
}

const GRID = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5];
const WRONG_AT_MOST = 0.2;

/** A juror's `hi`: the lowest grid step where findings above it are rarely wrong, one step from `current` at most. */
export function hiFor(labels: readonly Label[], current: number): number {
  const scored = labels.filter(
    (label): label is Label & { score: number } => label.tier === "juror" && typeof label.score === "number",
  );
  let lowest: number | null = null;
  // fixed sequence: from the top down, stop at the first step that fails
  for (const step of GRID) {
    const above = scored.filter((label) => label.score >= step);
    if (above.length === 0) continue;
    const wrong = above.filter((label) => label.value === "wrong").length;
    if (upperBound(wrong, above.length) > WRONG_AT_MOST) break;
    lowest = step;
  }
  const target = lowest ?? GRID[0];
  const at = GRID.findIndex((step) => Math.abs(step - current) < 1e-9);
  if (at < 0) return target;
  const want = GRID.indexOf(target);
  return GRID[want > at ? at + 1 : want < at ? at - 1 : at];
}
