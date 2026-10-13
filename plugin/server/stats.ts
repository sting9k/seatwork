import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEEP_LOG_DAYS } from "./gc";
import { hqDir } from "./hq";
import type { PaseoApi } from "./paseo";
import { ROOM_HOME, REGISTRY_LOG, USAGE_LOG } from "./paths";

/** Better-Seatwork input: what the mail log says happened, counted per project and per signal. */

const MAIL_LOG = join(ROOM_HOME, "mail", "log.jsonl");
const SIGNALS = [
  "CANDIDATE",
  "ACCEPT",
  "REJECT",
  "REVIEW",
  "QUESTION",
  "ANSWER",
  "REOPEN_REQUEST",
  "REVISED BRIEF",
  "HOLD",
  "DEPENDENCY_REQUEST",
  "BLOCKED",
  "DECISION_NEEDED",
  "FAILED",
  "PERMISSION",
  "GC",
  "SPAWN REFUSED",
] as const;

interface LogLine {
  at: string;
  kind: string;
  from: string;
  to: string;
  subject: string;
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

function signalOf(subject: string): string {
  const upper = subject.toUpperCase();
  return SIGNALS.find((s) => upper.startsWith(s)) ?? "other";
}

interface UsageLine {
  at: string;
  agentId: string;
  role: string;
  cwd: string;
  usage: { outputTokens?: number; totalCostUsd?: number };
}

/** Notes what a seat has used at the end of a turn, as its agent CLI reports it. */
export async function noteUsage(paseo: PaseoApi, agent: { id: string; cwd: string }, role: string): Promise<void> {
  const handle = paseo.agents.ref(agent.id);
  await handle.refresh();
  const now = handle.current();
  if (!now?.lastUsage) return;
  const line = { at: new Date().toISOString(), agentId: agent.id, role, cwd: agent.cwd, model: now.model ?? null };
  appendFileSync(USAGE_LOG, `${JSON.stringify({ ...line, usage: now.lastUsage })}\n`, { mode: 0o600 });
}

/** Dollars and output tokens per project and role since `since`, one line per project. */
export function costLines(since: number, file: string = USAGE_LOG): string[] {
  const seats = new Map<string, { role: string; cwd: string; usd: number; last: number; out: number }>();
  for (const line of readJsonl<UsageLine>(file)) {
    if (!(Date.parse(line.at) >= since) || !line.usage) continue;
    const seat = seats.get(line.agentId) ?? { role: line.role, cwd: line.cwd, usd: 0, last: 0, out: 0 };
    const total = line.usage.totalCostUsd ?? 0;
    // the total starts again at zero when the seat is resumed
    seat.usd += total >= seat.last ? total - seat.last : total;
    seat.last = total;
    seat.out += line.usage.outputTokens ?? 0;
    seats.set(line.agentId, seat);
  }
  const perProject = new Map<string, Map<string, { seats: number; usd: number; out: number }>>();
  for (const seat of seats.values()) {
    const roles = perProject.get(seat.cwd) ?? new Map<string, { seats: number; usd: number; out: number }>();
    const sum = roles.get(seat.role) ?? { seats: 0, usd: 0, out: 0 };
    roles.set(seat.role, { seats: sum.seats + 1, usd: sum.usd + seat.usd, out: sum.out + seat.out });
    perProject.set(seat.cwd, roles);
  }
  return [...perProject].map(([cwd, roles]) => {
    const all = [...roles.values()];
    const usd = all.reduce((sum, role) => sum + role.usd, 0);
    const row = [...roles].map(([role, sum]) => `${role} ${sum.seats} seats $${sum.usd.toFixed(2)}`).join(", ");
    return `${cwd}: $${usd.toFixed(2)} as the agent CLIs report it, ${Math.round(all.reduce((sum, role) => sum + role.out, 0) / 1000)}k output tokens (${row})`;
  });
}

/** Signals mailed in the last `asked` days per project, then what the seats used. */
export function roomStats(asked: number): string {
  const days = Math.min(Math.max(1, asked), KEEP_LOG_DAYS);
  const since = Date.now() - days * 86_400_000;
  const cost = costLines(since);
  const used = cost.length ? [`used in the last ${days} days:`, ...cost] : [];
  const cwdOf = new Map<string, string>();
  for (const rec of readJsonl<{ agentId: string; cwd?: string }>(REGISTRY_LOG))
    if (rec.cwd) cwdOf.set(rec.agentId, rec.cwd);
  const lines = readJsonl<LogLine>(MAIL_LOG).filter((l) => l.kind === "queued" && Date.parse(l.at) >= since);
  if (lines.length === 0) return [`no mail in the last ${days} days`, ...used].join("\n");

  // a mail between hq and a project counts for the project, whichever side wrote it
  const hq = hqDir();
  const perProject = new Map<string, Map<string, number>>();
  const sentBack = new Map<string, Map<string, number>>();
  for (const line of lines) {
    const candidates = [cwdOf.get(line.from), cwdOf.get(line.to)].filter((c): c is string => !!c);
    const project = candidates.find((c) => c !== hq) ?? candidates[0] ?? "(unknown)";
    const counts = perProject.get(project) ?? new Map<string, number>();
    const signal = signalOf(line.subject);
    counts.set(signal, (counts.get(signal) ?? 0) + 1);
    perProject.set(project, counts);
    if (signal === "REJECT") {
      const seats = sentBack.get(project) ?? new Map<string, number>();
      sentBack.set(project, seats.set(line.to, (seats.get(line.to) ?? 0) + 1));
    }
  }

  const out: string[] = [`mail in the last ${days} days: ${lines.length}`];
  for (const [project, counts] of perProject) {
    const n = (s: string) => counts.get(s) ?? 0;
    const row = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `${s} ${c}`)
      .join(", ");
    out.push(`${project}: ${row}`);
    const notes: string[] = [];
    if (n("REOPEN_REQUEST") > 0)
      notes.push(`reopen requests ${n("REOPEN_REQUEST")} → revised briefs ${n("REVISED BRIEF")}, holds ${n("HOLD")}`);
    if (n("CANDIDATE") > 0)
      notes.push(
        `candidates ${n("CANDIDATE")} → accepted ${n("ACCEPT")}, rejected ${n("REJECT")}, reviews ${n("REVIEW")}`,
      );
    const thrice = [...(sentBack.get(project)?.values() ?? [])].filter((count) => count >= 3).length;
    if (thrice > 0) notes.push(`seats sent back 3 times or more: ${thrice}`);
    if (n("DECISION_NEEDED") > 0) notes.push(`decisions escalated ${n("DECISION_NEEDED")}`);
    if (n("QUESTION") >= 3)
      notes.push(`questions ${n("QUESTION")}: a recurring class means the brief template is the defect`);
    if (notes.length) out.push(`  ${notes.join(" · ")}`);
  }
  return [...out, ...used].join("\n");
}
