import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hqDir } from "./hq";
import { ROOM_HOME, REGISTRY_LOG } from "./paths";

/**
 * Better-SLP input: what the mail log says happened, counted per project and
 * per signal, so the one who watches the room argues from numbers instead of
 * from the last episode it remembers.
 */

const MAIL_LOG = join(ROOM_HOME, "mail", "log.jsonl");
const SIGNALS = ["CANDIDATE", "ACCEPT", "REJECT", "REVIEW", "QUESTION", "ANSWER", "REOPEN_REQUEST", "REVISED BRIEF", "HOLD", "DEPENDENCY_REQUEST", "BLOCKED", "DECISION_NEEDED", "FAILED", "PERMISSION", "GC", "SPAWN REFUSED"] as const;

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

/** Counts of every signal mailed in the last `days`, per project (by the sender's cwd), plus the ratios Better-SLP asks about. */
export function roomStats(days: number): string {
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  const cwdOf = new Map<string, string>();
  for (const rec of readJsonl<{ agentId: string; cwd?: string }>(REGISTRY_LOG)) if (rec.cwd) cwdOf.set(rec.agentId, rec.cwd);
  const lines = readJsonl<LogLine>(MAIL_LOG).filter((l) => l.kind === "queued" && Date.parse(l.at) >= since);
  if (lines.length === 0) return `no mail in the last ${days} days`;

  // a mail between hq and a project counts for the project, whichever side wrote it
  const hq = hqDir();
  const perProject = new Map<string, Map<string, number>>();
  for (const line of lines) {
    const candidates = [cwdOf.get(line.from), cwdOf.get(line.to)].filter((c): c is string => !!c);
    const project = candidates.find((c) => c !== hq) ?? candidates[0] ?? "(unknown)";
    const counts = perProject.get(project) ?? new Map<string, number>();
    const signal = signalOf(line.subject);
    counts.set(signal, (counts.get(signal) ?? 0) + 1);
    perProject.set(project, counts);
  }

  const out: string[] = [`mail in the last ${days} days: ${lines.length}`];
  for (const [project, counts] of perProject) {
    const n = (s: string) => counts.get(s) ?? 0;
    const row = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join(", ");
    out.push(`${project}: ${row}`);
    const notes: string[] = [];
    if (n("REOPEN_REQUEST") > 0) notes.push(`reopen requests ${n("REOPEN_REQUEST")} → revised briefs ${n("REVISED BRIEF")}, holds ${n("HOLD")}`);
    if (n("CANDIDATE") > 0) notes.push(`candidates ${n("CANDIDATE")} → accepted ${n("ACCEPT")}, rejected ${n("REJECT")}, reviews ${n("REVIEW")}`);
    if (n("DECISION_NEEDED") > 0) notes.push(`decisions escalated ${n("DECISION_NEEDED")}`);
    if (n("QUESTION") >= 3) notes.push(`questions ${n("QUESTION")}: a recurring class means the brief template is the defect`);
    if (notes.length) out.push(`  ${notes.join(" · ")}`);
  }
  return out.join("\n");
}
