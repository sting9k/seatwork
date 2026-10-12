import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * What the decision model has cost, per month and per day. `open`: everything may be asked; `saving`: today's share
 * of the plan is spent, only end-of-turn questions; `closed`: the month's cap is reached.
 */

export interface BudgetPolicy {
  /** Per million input tokens; output is not billed. */
  usdPerMillionTokens: number;
  /** What a month is meant to cost. */
  monthlyPlanUsd: number;
  /** What a month may cost at most. */
  monthlyCapUsd: number;
}

export type Pace = "open" | "saving" | "closed";

export interface Spend {
  calls: number;
  tokens: number;
  usd: number;
}

interface Ledger {
  month: string;
  total: Spend;
  byDay: Record<string, Spend>;
  byKind: Record<string, Spend>;
}

const empty = (): Spend => ({ calls: 0, tokens: 0, usd: 0 });

function add(spend: Spend | undefined, tokens: number, usd: number): Spend {
  const base = spend ?? empty();
  return { calls: base.calls + 1, tokens: base.tokens + tokens, usd: base.usd + usd };
}

export class Budget {
  private ledger: Ledger | null = null;

  constructor(
    /** Path with `{month}` where the month goes, e.g. …/watch/usage-{month}.json. */
    private readonly filePattern: string,
    private readonly policy: BudgetPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private month(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private day(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private file(month: string): string {
    return this.filePattern.replace("{month}", month);
  }

  private load(): Ledger {
    const month = this.month();
    if (this.ledger?.month === month) return this.ledger;
    const fresh: Ledger = { month, total: empty(), byDay: {}, byKind: {} };
    const file = this.file(month);
    if (existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, "utf8")) as Ledger;
        if (saved.month === month) return (this.ledger = { ...fresh, ...saved });
      } catch {
        // an unreadable ledger starts again: under-counting a month beats stopping the plugin
      }
    }
    return (this.ledger = fresh);
  }

  /** What is left of the plan, spread over the days left in the month. */
  private allowance(ledger: Ledger): number {
    const today = this.now();
    const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
    const daysLeft = daysInMonth - today.getUTCDate() + 1;
    const spentBefore = ledger.total.usd - (ledger.byDay[this.day()]?.usd ?? 0);
    return Math.max(0, this.policy.monthlyPlanUsd - spentBefore) / daysLeft;
  }

  pace(): Pace {
    const ledger = this.load();
    if (ledger.total.usd >= this.policy.monthlyCapUsd) return "closed";
    return (ledger.byDay[this.day()]?.usd ?? 0) >= this.allowance(ledger) ? "saving" : "open";
  }

  price(tokens: number): number {
    return (tokens * this.policy.usdPerMillionTokens) / 1_000_000;
  }

  /** `kind` is the moment that asked: "end" or "live". */
  record(kind: string, tokens: number): void {
    const ledger = this.load();
    const usd = this.price(tokens);
    const day = this.day();
    ledger.total = add(ledger.total, tokens, usd);
    ledger.byDay[day] = add(ledger.byDay[day], tokens, usd);
    ledger.byKind[kind] = add(ledger.byKind[kind], tokens, usd);
    const file = this.file(ledger.month);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(ledger, null, 1)}\n`);
    renameSync(`${file}.tmp`, file);
  }

  summary(): { month: string; pace: Pace; total: Spend; today: Spend; byKind: Record<string, Spend>; planUsd: number; capUsd: number } {
    const ledger = this.load();
    return { month: ledger.month, pace: this.pace(), total: ledger.total, today: ledger.byDay[this.day()] ?? empty(), byKind: ledger.byKind, planUsd: this.policy.monthlyPlanUsd, capUsd: this.policy.monthlyCapUsd };
  }
}
