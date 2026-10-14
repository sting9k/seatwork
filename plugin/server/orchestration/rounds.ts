import { readJson, writeJson } from "../persisted";
import { note, rotateNote } from "../../shared/workflow";
import { onlyAfterCandidate, verdictOf } from "../signals";

type Task = { pending: boolean; rejected: number; reread?: boolean };

/** Where a task stands: its candidates and the rejections they met since its last ACCEPT. */
export class Rounds {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly file: string) {
    for (const [key, task] of Object.entries(readJson<Record<string, Task>>(file, {}))) this.tasks.set(key, task);
  }

  private save(): void {
    writeJson(this.file, Object.fromEntries(this.tasks));
  }

  /** Whether this candidate still owes its fresh-eyes pass; yes is said once per candidate. */
  owesFreshEyes(key: string): boolean {
    const task = this.tasks.get(key) ?? { pending: false, rejected: 0 };
    if (task.reread) return false;
    task.reread = true;
    this.tasks.set(key, task);
    this.save();
    return true;
  }

  /** A candidate of this task went up; returns the rejections its task has met so far. */
  handedIn(key: string): number {
    const task = this.tasks.get(key) ?? { pending: false, rejected: 0 };
    task.pending = true;
    this.tasks.set(key, task);
    this.save();
    return task.rejected;
  }

  /** The Owner's mail on this task; returns the rejections so far, counting this mail when it is one. */
  answered(key: string, opening: string): number {
    const verdict = verdictOf(opening);
    if (verdict === "accepted" || verdict === "deferred") {
      if (this.tasks.delete(key)) this.save();
      return 0;
    }
    const task = this.tasks.get(key) ?? { pending: false, rejected: 0 };
    // a revised brief that answers a candidate sends it back, whatever its subject calls itself
    const rejects = verdict === "returned" && (task.pending || !onlyAfterCandidate(opening));
    if (rejects) {
      task.rejected += 1;
      task.pending = false;
      // the repair is a new candidate: it owes its own pass
      task.reread = false;
      this.tasks.set(key, task);
      this.save();
    }
    return task.rejected;
  }

  rejected(key: string): number {
    return this.tasks.get(key)?.rejected ?? 0;
  }

  forget(key: string): void {
    if (this.tasks.delete(key)) this.save();
  }

  /** A successor takes the task over as it stands. */
  move(from: string, to: string): void {
    const task = this.tasks.get(from);
    if (!task) return;
    this.tasks.delete(from);
    this.tasks.set(to, task);
    this.save();
  }
}

export interface Standing {
  role: string;
  candidate: boolean;
  rejected: number;
  contextTokens: number | null;
  rotateAtTokens: number;
}

/** The room's line under a report: the task's round, and a context past the rotation mark. */
export function ownerNote(standing: Standing): string | null {
  const lines: string[] = [];
  if (standing.candidate && standing.rejected === 1) lines.push(note("secondCandidate", {}));
  if (standing.candidate && standing.rejected >= 2)
    lines.push(note("lastCandidate", { candidate: standing.rejected + 1, rejected: standing.rejected }));
  if (standing.contextTokens !== null && standing.contextTokens >= standing.rotateAtTokens) {
    const held = `holds ${Math.round(standing.contextTokens / 1000)}K tokens of context and reads them again at every step`;
    const line = rotateNote(standing.role, held);
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines.map((line) => `[room] ${line}`).join("\n") : null;
}

/** What a writing seat reads when its first hand-in comes back for a fresh-eyes pass. */
export const FRESH_EYES = [
  "Your candidate has not gone to your Owner yet: first one pass over it with fresh eyes.",
  "Read again everything you wrote or changed for this task as if another seat had written it and you were hunting its defects:",
  "1. each line of the brief's contract and acceptance evidence, against the code that answers it;",
  "2. each test you added: the wrong behavior it would still let through;",
  "3. each file you changed: an edit the brief did not ask for, a leftover, a check made weaker than it was.",
  "Run again what the brief names as acceptance evidence. Fix what you find and commit it.",
  "Then hand in again exactly as you did, with the final sha, and open the report's second line with `Fresh eyes: <what the pass found and fixed, or nothing>`.",
].join("\n");
