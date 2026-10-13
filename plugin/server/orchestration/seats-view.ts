import type { Role } from "./seats";

/** The seats under an orchestrating seat, as one text it reads in a single call. */

export interface SeatRow {
  agentId: string;
  role: Role;
  title: string | null;
  depth: number;
  status: string;
  waiting: boolean;
  updatedAt: string | null;
  turnStartedAt: string | null;
  heldMail: number;
  retry: string | null;
  error: string | null;
  contextTokens: number | null;
  costUsd: number | null;
  lastSignal: string | null;
  rejected: number;
}

const minutesSince = (at: string | null, now: number) =>
  at ? Math.max(0, Math.floor((now - Date.parse(at)) / 60_000)) : null;

function state(row: SeatRow, now: number): string {
  if (row.waiting) return "waiting for a permission";
  if (row.status === "running") {
    const inTurn = minutesSince(row.turnStartedAt, now);
    return inTurn === null ? "at work" : `at work for ${inTurn} min`;
  }
  // a retry the room has planned says more than the failure it answers
  if (row.retry) return row.retry;
  if (row.status === "error") return row.error ? `its last turn failed: ${row.error}` : "its last turn failed";
  if (row.status !== "idle" && row.status !== "closed") return "starting";
  const rested = minutesSince(row.updatedAt, now);
  return rested === null ? "at rest" : `at rest for ${rested} min`;
}

export function describeSeats(rows: readonly SeatRow[], rotateAtTokens: number, now: number): string {
  if (rows.length === 0) return "No seat you launched is open.";
  const atWork = rows.filter((row) => row.status === "running" && !row.waiting).length;
  const lines = rows.map((row) => {
    const parts = [`${row.role} ${row.title ?? "(no title)"}`, row.agentId, state(row, now)];
    if (row.contextTokens !== null) {
      const past =
        row.contextTokens >= rotateAtTokens ? ", past the rotation line: its next task goes to a fresh seat" : "";
      parts.push(`context ${Math.round(row.contextTokens / 1000)}K tokens${past}`);
    }
    if (row.costUsd !== null) parts.push(`$${row.costUsd.toFixed(2)}`);
    if (row.lastSignal) parts.push(`last turn ended with ${row.lastSignal}`);
    if (row.rejected > 0) parts.push(`${row.rejected} rejection${row.rejected === 1 ? "" : "s"} since its last ACCEPT`);
    if (row.heldMail > 0) parts.push(`${row.heldMail} mail${row.heldMail === 1 ? "" : "s"} held for it`);
    return `${"  ".repeat(row.depth)}- ${parts.join(" · ")}`;
  });
  return [`${rows.length} open seat${rows.length === 1 ? "" : "s"} under you, ${atWork} at work.`, ...lines].join("\n");
}
