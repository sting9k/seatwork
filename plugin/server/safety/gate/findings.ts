import { ruleOf } from "./packs";
import type { Doubt, Finding, Severity } from "./types";

/** The findings and doubts of one evaluation; a rule found twice in the same command text is kept once. */
export class Findings {
  readonly found: Finding[] = [];
  readonly doubts: Doubt[] = [];
  private readonly keys = new Set<string>();

  add(pack: string, rule: string, text: string, detail?: string): void {
    const declared = ruleOf(pack, rule);
    if (!declared) throw new Error(`safety: no rule ${pack}:${rule}`);
    const key = `${pack}\0${rule}\0${text}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.found.push({
      pack,
      rule,
      severity: declared.severity as Severity,
      reason: detail ? `${declared.reason} (${detail})` : declared.reason,
      text,
    });
  }

  doubt(reason: string, text: string): void {
    this.doubts.push({ reason, text });
  }
}
