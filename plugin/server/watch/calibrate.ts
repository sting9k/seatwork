import { CLOSES_WORK } from "../signals";
import type { RuleId } from "./rules";
import type { ScanRecord } from "./scanlog";

/** How well each rule's findings predict what the seat above did next, from the scan and mail logs. */

export interface MailLine {
  at: string;
  kind: string;
  from: string;
  to: string;
  subject: string;
}

/** What the seat above did with a turn's result: sent it back, or took it. */
export type Label = "returned" | "accepted";

// HOLD is no verdict: a Lead writes it for "received, under review", and the verdict follows
const RETURNS = /^\W*(?:REJECT|REVISED BRIEF)\b/i;
const ACCEPTS = /^\W*ACCEPT\b/i;

/** The first verdict of the seat above on a turn that handed work over; null while there is none. */
function verdictOf(scan: ScanRecord, mail: readonly MailLine[], now: number, windowMinutes: number): { label: Label; at: number } | null {
  if (scan.moment !== "end" || !scan.parent || !scan.signal || !CLOSES_WORK.has(scan.signal)) return null;
  const ended = Date.parse(scan.at);
  const until = ended + windowMinutes * 60_000;
  for (const line of mail) {
    const at = Date.parse(line.at);
    if (line.kind !== "queued" || line.from !== scan.parent || line.to !== scan.seat || at <= ended || at > until) continue;
    if (RETURNS.test(line.subject)) return { label: "returned", at };
    if (ACCEPTS.test(line.subject)) return { label: "accepted", at };
  }
  // a DONE is taken in silence: a question about it is not a verdict
  return scan.signal === "DONE" && now > until ? { label: "accepted", at: until } : null;
}

export function labelOf(scan: ScanRecord, mail: readonly MailLine[], now: number, windowMinutes: number): Label | null {
  return verdictOf(scan, mail, now, windowMinutes)?.label ?? null;
}

/** Whether a returned turn bears out a rule's finding; null when nothing shows why the work came back. */
function borneOut(rule: RuleId, scan: ScanRecord, verdictAt: number, scans: readonly ScanRecord[]): boolean | null {
  if (rule !== "unverified-completion") return true;
  const ended = Date.parse(scan.at);
  const above = scans.filter((other) => other.seat === scan.parent && other.moment === "end" && Date.parse(other.at) > ended).sort((a, b) => a.at.localeCompare(b.at));
  for (const turn of above) {
    if (turn.ran === "failed") return true;
    if (turn.ran === "passed") return false;
    // the turn in which the verdict was written is the last that can show its reason
    if (Date.parse(turn.at) >= verdictAt) break;
  }
  return null;
}

export interface Scored {
  score: number;
  positive: boolean;
}

export interface Roc {
  auroc: number;
  /** Standard error (Hanley and McNeil): the interval is wide below a hundred labels. */
  se: number;
  positives: number;
  negatives: number;
}

/** Area under the ROC curve by rank sums, ties sharing their mean rank; null without both classes. */
export function auroc(items: readonly Scored[]): Roc | null {
  const positives = items.filter((item) => item.positive).length;
  const negatives = items.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const sorted = [...items].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const meanRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) if (sorted[k].positive) rankSum += meanRank;
    i = j;
  }
  const a = (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
  const q1 = a / (2 - a);
  const q2 = (2 * a * a) / (1 + a);
  const variance = (a * (1 - a) + (positives - 1) * (q1 - a * a) + (negatives - 1) * (q2 - a * a)) / (positives * negatives);
  return { auroc: a, se: Math.sqrt(Math.max(0, variance)), positives, negatives };
}

export interface Operating {
  threshold: number;
  /** Share of returned turns flagged at this threshold. */
  recall: number;
  /** Share of accepted turns flagged at this threshold. */
  falseRate: number;
}

/** The lowest threshold whose false-flag rate stays within `maxFalseRate`. */
export function operatingPoint(items: readonly Scored[], maxFalseRate: number): Operating | null {
  const positives = items.filter((item) => item.positive).length;
  const negatives = items.length - positives;
  if (positives === 0 || negatives === 0) return null;
  let best: Operating | null = null;
  for (const threshold of [...new Set(items.map((item) => item.score))].sort((a, b) => b - a)) {
    const flagged = items.filter((item) => item.score >= threshold);
    const falseRate = flagged.filter((item) => !item.positive).length / negatives;
    if (falseRate > maxFalseRate) break;
    best = { threshold, recall: flagged.filter((item) => item.positive).length / positives, falseRate };
  }
  return best;
}

export interface RuleReport {
  rule: RuleId;
  by: "facts" | "model";
  spoke: number;
  raised: number;
  /** Turns it spoke in that have a label; `returned` of them were sent back. */
  labelled: number;
  returned: number;
  roc: Roc | null;
  operating: Operating | null;
}

export interface CalibrationPolicy {
  /** Minutes after a turn's end in which the answer of the seat above counts as its label. */
  labelWindowMinutes: number;
  minLabels: number;
  minAuroc: number;
  maxFalseRaiseRate: number;
}

export interface Calibration {
  turns: number;
  reads: number;
  labelled: number;
  returned: number;
  returnedWithFinding: number;
  rules: RuleReport[];
}

export function calibrate(scans: readonly ScanRecord[], mail: readonly MailLine[], policy: CalibrationPolicy, now: number, rev: number): Calibration {
  const turnKey = (scan: ScanRecord) => `${scan.seat}:${scan.turn ?? scan.at}`;
  const labels = new Map<string, Label>();
  /** Per turn that was sent back: the scan that ended it and when the verdict came. */
  const returns = new Map<string, { scan: ScanRecord; at: number }>();
  const reads = new Map<string, number>();
  for (const scan of scans) {
    if (scan.rev === rev) reads.set(turnKey(scan), Math.max(reads.get(turnKey(scan)) ?? 0, scan.reads ?? 1));
    const verdict = verdictOf(scan, mail, now, policy.labelWindowMinutes);
    if (!verdict) continue;
    labels.set(turnKey(scan), verdict.label);
    if (verdict.label === "returned") returns.set(turnKey(scan), { scan, at: verdict.at });
  }
  // per turn and rule, the strongest thing the rule said
  const said = new Map<string, Map<string, { score: number; raised: boolean; by: "facts" | "model"; rule: RuleId }>>();
  const turns = new Set<string>();
  for (const scan of scans) {
    if (scan.rev !== rev) continue;
    const key = turnKey(scan);
    turns.add(key);
    for (const finding of scan.findings) {
      const perRule = said.get(key) ?? new Map();
      const score = finding.by === "facts" ? 1 : finding.score ?? 0;
      const before = perRule.get(finding.rule);
      perRule.set(finding.rule, { rule: finding.rule, by: finding.by, score: Math.max(score, before?.score ?? 0), raised: finding.outcome === "raised" || before?.raised === true });
      said.set(key, perRule);
    }
  }
  const rules = new Map<RuleId, { by: "facts" | "model"; spoke: number; raised: number; scored: Scored[] }>();
  for (const [key, perRule] of said) {
    const label = labels.get(key);
    for (const entry of perRule.values()) {
      const report = rules.get(entry.rule) ?? { by: entry.by, spoke: 0, raised: 0, scored: [] };
      report.spoke += 1;
      if (entry.raised) report.raised += 1;
      const sentBack = returns.get(key);
      const positive = sentBack ? borneOut(entry.rule, sentBack.scan, sentBack.at, scans) : false;
      if (label && positive !== null) report.scored.push({ score: entry.score, positive });
      rules.set(entry.rule, report);
    }
  }
  const labelledTurns = [...turns].filter((key) => labels.has(key));
  const returnedTurns = labelledTurns.filter((key) => labels.get(key) === "returned");
  return {
    turns: turns.size,
    reads: [...reads.values()].reduce((sum, count) => sum + count, 0),
    labelled: labelledTurns.length,
    returned: returnedTurns.length,
    returnedWithFinding: returnedTurns.filter((key) => (said.get(key)?.size ?? 0) > 0).length,
    rules: [...rules.entries()].map(([rule, report]) => ({
      rule,
      by: report.by,
      spoke: report.spoke,
      raised: report.raised,
      labelled: report.scored.length,
      returned: report.scored.filter((item) => item.positive).length,
      roc: report.by === "model" ? auroc(report.scored) : null,
      operating: report.by === "model" ? operatingPoint(report.scored, policy.maxFalseRaiseRate) : null,
    })),
  };
}

export function renderCalibration(result: Calibration, policy: CalibrationPolicy): string {
  const lines = [`watched turns ${result.turns}, read ${result.reads} times; labelled by what the seat above did ${result.labelled} (sent back ${result.returned}); sent back with a finding ${result.returnedWithFinding}/${result.returned}`];
  for (const rule of result.rules.sort((a, b) => b.spoke - a.spoke)) {
    const precision = rule.labelled > 0 ? `${rule.returned}/${rule.labelled} of its labelled turns were sent back${rule.rule === "unverified-completion" ? " after a test failed for the seat above" : ""}` : "no labelled turn yet";
    if (rule.by === "facts") {
      lines.push(`${rule.rule} (facts): spoke in ${rule.spoke} turns, mailed ${rule.raised}; ${precision}`);
      continue;
    }
    const roc = rule.roc ? `AUROC ${rule.roc.auroc.toFixed(2)} ±${(1.96 * rule.roc.se).toFixed(2)}` : "AUROC needs both kinds of label";
    const ready = rule.roc && rule.labelled >= policy.minLabels && rule.roc.auroc >= policy.minAuroc && rule.operating;
    const advice = ready ? `fit to mail at ${rule.operating!.threshold.toFixed(2)} (catches ${(rule.operating!.recall * 100).toFixed(0)}% at ${(rule.operating!.falseRate * 100).toFixed(0)}% false)` : `keep logging until ${policy.minLabels} labels and AUROC ${policy.minAuroc}`;
    lines.push(`${rule.rule} (model): asked in ${rule.spoke} turns, mailed ${rule.raised}; ${precision}; ${roc}; ${advice}`);
  }
  return lines.join("\n");
}
