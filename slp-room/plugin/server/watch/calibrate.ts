import { subjectSignal } from "../signals";
import type { RuleId } from "./rules";
import type { ScanRecord } from "./scanlog";

/** How well each rule's findings predict what the seat above did next, read from the scan log and the mail log. */

export interface MailLine {
  at: string;
  kind: string;
  from: string;
  to: string;
  subject: string;
}

/** What the seat above did with a turn's result: sent it back, or took it. */
export type Label = "returned" | "accepted";

const RETURNS = /^\W*(?:REJECT|REVISED BRIEF|HOLD)\b/i;
const ACCEPTS = /^\W*ACCEPT\b/i;

/** The label of a finished turn, or null while the seat above has not shown its hand. */
export function labelOf(scan: ScanRecord, mail: readonly MailLine[], now: number, windowMinutes: number): Label | null {
  if (scan.moment !== "end" || !scan.parent || !scan.signal) return null;
  const ended = Date.parse(scan.at);
  const until = ended + windowMinutes * 60_000;
  for (const line of mail) {
    const at = Date.parse(line.at);
    if (line.kind !== "queued" || line.from !== scan.parent || line.to !== scan.seat || at <= ended || at > until) continue;
    if (RETURNS.test(line.subject)) return "returned";
    if (ACCEPTS.test(line.subject)) return "accepted";
    // a DONE is taken in silence; any other word back about it is a return
    if (scan.signal === "DONE" && subjectSignal(line.subject) !== "ACK") return "returned";
  }
  return scan.signal === "DONE" && now > until ? "accepted" : null;
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

/** Area under the ROC curve by rank sums; tied scores share the mean of their ranks. Null without both classes. */
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

/** The lowest threshold whose false-flag rate stays within `maxFalseRate`: the most it can catch at that price. */
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
  /** Of the turns it spoke in that have a label: how many were sent back. */
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
  labelled: number;
  returned: number;
  /** Returned turns that had any finding at all. */
  returnedWithFinding: number;
  rules: RuleReport[];
}

export function calibrate(scans: readonly ScanRecord[], mail: readonly MailLine[], policy: CalibrationPolicy, now: number, rev: number): Calibration {
  const turnKey = (scan: ScanRecord) => `${scan.seat}:${scan.turn ?? scan.at}`;
  const labels = new Map<string, Label>();
  for (const scan of scans) {
    const label = labelOf(scan, mail, now, policy.labelWindowMinutes);
    if (label) labels.set(turnKey(scan), label);
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
      if (label) report.scored.push({ score: entry.score, positive: label === "returned" });
      rules.set(entry.rule, report);
    }
  }
  const labelledTurns = [...turns].filter((key) => labels.has(key));
  const returnedTurns = labelledTurns.filter((key) => labels.get(key) === "returned");
  return {
    turns: turns.size,
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
  const lines = [`watched turns ${result.turns}; labelled by what the seat above did ${result.labelled} (sent back ${result.returned}); sent back with a finding ${result.returnedWithFinding}/${result.returned}`];
  for (const rule of result.rules.sort((a, b) => b.spoke - a.spoke)) {
    const precision = rule.labelled > 0 ? `${rule.returned}/${rule.labelled} of its labelled turns were sent back` : "no labelled turn yet";
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
