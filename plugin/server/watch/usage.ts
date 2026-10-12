import type { UsageReport } from "@getpaseo/plugin/server/usage";
import type { Budget } from "./budget";

const PACE_TONE = { saving: "warning", closed: "danger" } as const;

/** The month's spending on the decision model against its cap, as Paseo's Usage screen takes it. */
export function usageReport(spend: ReturnType<Budget["summary"]>): UsageReport {
  // to a tenth of a percent: the screen shows whole percents
  const usedPct = spend.capUsd > 0 ? Math.round((spend.total.usd / spend.capUsd) * 1000) / 10 : null;
  return {
    status: "available",
    planLabel: `plan $${spend.planUsd} a month`,
    windows: [{ id: "month", label: `Cap for ${spend.month}`, shortLabel: "mo", summary: true, usedPct }],
    balances: [{ id: "month", label: "Spent this month", used: spend.total.usd, limit: spend.capUsd, unit: "usd" }],
    details: [
      { id: "calls", label: "Questions asked", value: String(spend.total.calls) },
      { id: "tokens", label: "Tokens read", value: String(spend.total.tokens) },
      { id: "today", label: "Spent today", value: `$${spend.today.usd.toFixed(4)}` },
      { id: "pace", label: "Asking", value: spend.pace, ...(spend.pace === "open" ? {} : { tone: PACE_TONE[spend.pace] }) },
    ],
  };
}
