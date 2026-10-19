/** The seats under an orchestrating seat, as one text it reads in a single call. */

export interface SeatRow {
  agentId: string;
  role: string;
  title: string | null;
  depth: number;
  status: string;
  waiting: boolean;
  updatedAt: string | null;
  turnStartedAt: string | null;
  heldMail: number;
  heldSince?: string;
  heldForRound?: { reports: number; dueAt: string };
  owes?: { asks: number; oldestAt: string };
  retry: string | null;
  error: string | null;
  contextTokens: number | null;
  costUsd: number | null;
  lastSignal: string | null;
  rejected: number;
}

/** What the caller's project spent on the UTC day, in all and by role, beside its daily cap; a cap field left out is no cap. */
export interface ProjectSpend {
  usd: number;
  turns: number;
  byRole: { role: string; usd: number }[];
  cap: { dailyUsd?: number; dailyTurns?: number } | null;
}

const turnsOf = (n: number) => `${n} turn${n === 1 ? "" : "s"}`;

/** The line of what the caller's project spent today, beside its cap. */
function spendLine(spend: ProjectSpend): string {
  const caps = [
    spend.cap?.dailyUsd !== undefined ? `$${spend.cap.dailyUsd.toFixed(2)}` : null,
    spend.cap?.dailyTurns !== undefined ? turnsOf(spend.cap.dailyTurns) : null,
  ].filter((cap) => cap !== null);
  const roles = spend.byRole.map(({ role, usd }) => `${role} $${usd.toFixed(2)}`).join(", ");
  const capped = caps.length ? `of a daily cap of ${caps.join(" and ")}` : "with no daily cap";
  return `Your project spent $${spend.usd.toFixed(2)} over ${turnsOf(spend.turns)} today (UTC), ${capped}${roles ? `: ${roles}` : ""}.`;
}

const minutesSince = (at: string | null, now: number) =>
  at ? Math.max(0, Math.floor((now - Date.parse(at)) / 60_000)) : null;

/** What a seat is doing, in words: at work, waiting, failed, or at rest, and for how long; a planned retry is said in place of the failure it answers. */
function state(row: SeatRow, now: number): string {
  if (row.waiting) return "waiting for a permission";
  if (row.status === "running") {
    const inTurn = minutesSince(row.turnStartedAt, now);
    return inTurn === null ? "at work" : `at work for ${inTurn} min`;
  }
  if (row.retry) return row.retry;
  if (row.status === "error") return row.error ? `its last turn failed: ${row.error}` : "its last turn failed";
  if (row.status !== "idle" && row.status !== "closed") return "starting";
  const rested = minutesSince(row.updatedAt, now);
  return rested === null ? "at rest" : `at rest for ${rested} min`;
}

/** One line per seat, nested by depth, under a head line that counts them, and a last line of what the caller's project spent today. */
export function describeSeats(
  rows: readonly SeatRow[],
  rotateAtTokens: number,
  now: number,
  spend: ProjectSpend | null = null,
): string {
  const spent = spend ? [spendLine(spend)] : [];
  if (rows.length === 0) return ["No seat you launched is open.", ...spent].join("\n");
  const atWork = rows.filter((row) => row.status === "running" && !row.waiting).length;
  const lines = rows.map((row) => {
    const parts = [`${row.role} ${row.title ?? "(no title)"}`, row.agentId, state(row, now)];
    if (row.contextTokens !== null) {
      const past =
        row.contextTokens >= rotateAtTokens
          ? ", past the rotation line: seatwork_rotate moves its work to a fresh seat"
          : "";
      parts.push(`context ${Math.round(row.contextTokens / 1000)}K tokens${past}`);
    }
    if (row.costUsd !== null) parts.push(`$${row.costUsd.toFixed(2)}`);
    if (row.lastSignal) parts.push(`last turn ended with ${row.lastSignal}`);
    if (row.rejected > 0) parts.push(`${row.rejected} rejection${row.rejected === 1 ? "" : "s"} since its last ACCEPT`);
    if (row.heldMail > 0) {
      const waited = minutesSince(row.heldSince ?? null, now);
      parts.push(
        `${row.heldMail} mail${row.heldMail === 1 ? "" : "s"} held for it${waited === null ? "" : `, the oldest for ${waited} min`}`,
      );
    }
    if (row.heldForRound) {
      const { reports, dueAt } = row.heldForRound;
      const due = Math.max(0, Math.ceil((Date.parse(dueAt) - now) / 60_000));
      parts.push(`${reports} report${reports === 1 ? "" : "s"} held for a round, due in ${due} min`);
    }
    if (row.owes)
      parts.push(
        `owes ${row.owes.asks === 1 ? "an answer" : `${row.owes.asks} answers`}, the oldest for ${minutesSince(row.owes.oldestAt, now)} min`,
      );
    return `${"  ".repeat(row.depth)}- ${parts.join(" · ")}`;
  });
  return [
    `${rows.length} open seat${rows.length === 1 ? "" : "s"} under you, ${atWork} at work.`,
    ...lines,
    ...spent,
  ].join("\n");
}
