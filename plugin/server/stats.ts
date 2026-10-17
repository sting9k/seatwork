import { existsSync, readFileSync } from "node:fs";
import { KEEP_LOG_DAYS } from "./gc";
import { REGISTRY_LOG } from "./paths";
import { roomProjectDir } from "./orchestration/registry";
import { COUNTED } from "./signals";

/** What the room did, for its owner: mail counted per project and signal. */

interface LogLine {
  at: string;
  from: string;
  to: string;
  subject: string;
}

/** The lines of a JSON-lines file that parse; a missing file is none. */
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

/** The counted signal a mail subject opens with, "other" for none. */
function countedSignal(subject: string): string {
  const upper = subject.toUpperCase();
  return COUNTED.find((s) => upper.startsWith(s)) ?? "other";
}

/** The mail counted by project and signal, and how often each seat was sent back; a mail between the room's own seats and a project counts for the project. */
function tally(lines: readonly LogLine[], cwdOf: ReadonlyMap<string, string>) {
  const own = roomProjectDir();
  const perProject = new Map<string, Map<string, number>>();
  const sentBack = new Map<string, Map<string, number>>();
  for (const line of lines) {
    const candidates = [cwdOf.get(line.from), cwdOf.get(line.to)].filter((c): c is string => !!c);
    const project = candidates.find((c) => c !== own) ?? candidates[0] ?? "(unknown)";
    const counts = perProject.get(project) ?? new Map<string, number>();
    const signal = countedSignal(line.subject);
    counts.set(signal, (counts.get(signal) ?? 0) + 1);
    perProject.set(project, counts);
    if (signal === "REJECT") {
      const seats = sentBack.get(project) ?? new Map<string, number>();
      sentBack.set(project, seats.set(line.to, (seats.get(line.to) ?? 0) + 1));
    }
  }
  return { perProject, sentBack };
}

/** What a project's counts say about how the room is working. */
function notesOf(counts: ReadonlyMap<string, number>, sentBack: ReadonlyMap<string, number> | undefined): string[] {
  const n = (signal: string) => counts.get(signal) ?? 0;
  const notes: string[] = [];
  if (n("REOPEN_REQUEST") > 0)
    notes.push(`reopen requests ${n("REOPEN_REQUEST")} → revised briefs ${n("REVISED BRIEF")}, holds ${n("HOLD")}`);
  if (n("CANDIDATE") > 0)
    notes.push(
      `candidates ${n("CANDIDATE")} → accepted ${n("ACCEPT")}, rejected ${n("REJECT")}, reviews ${n("REVIEW")}`,
    );
  const thrice = [...(sentBack?.values() ?? [])].filter((count) => count >= 3).length;
  if (thrice > 0) notes.push(`seats sent back 3 times or more: ${thrice}`);
  if (n("DECISION_NEEDED") > 0) notes.push(`decisions escalated ${n("DECISION_NEEDED")}`);
  if (n("QUESTION") >= 3)
    notes.push(`questions ${n("QUESTION")}: a recurring class means the brief template is the defect`);
  return notes;
}

/** Signals mailed in the last `asked` days per project, then the lines `mail` adds. */
export function roomStats(
  asked: number,
  posted: (since: string) => readonly LogLine[],
  mail: (since: string) => readonly string[] = () => [],
): string {
  const days = Math.min(Math.max(1, asked), KEEP_LOG_DAYS);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const used = mail(since);
  const lines = posted(since);
  if (lines.length === 0) return [`no mail in the last ${days} days`, ...used].join("\n");

  const cwdOf = new Map<string, string>();
  for (const rec of readJsonl<{ agentId: string; cwd?: string }>(REGISTRY_LOG))
    if (rec.cwd) cwdOf.set(rec.agentId, rec.cwd);
  const { perProject, sentBack } = tally(lines, cwdOf);
  const out: string[] = [`mail in the last ${days} days: ${lines.length}`];
  for (const [project, counts] of perProject) {
    const row = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([signal, count]) => `${signal} ${count}`)
      .join(", ");
    out.push(`${project}: ${row}`);
    const notes = notesOf(counts, sentBack.get(project));
    if (notes.length) out.push(`  ${notes.join(" · ")}`);
  }
  return [...out, ...used].join("\n");
}
