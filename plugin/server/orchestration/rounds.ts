import { readJson, writeJson } from "../persisted";
import { note, rotateNote } from "../../shared/workflow";
import { onlyAfterCandidate, verdictOf } from "../signals";

/** The rounds of a task: its candidates and the rejections they met, and the room's lines about them. */

interface Task {
  pending: boolean;
  rejected: number;
  reread?: boolean;
  at: number;
}

type Stored = Omit<Task, "at"> & { at?: number };

/** Where each task stands since its last ACCEPT, kept on disk, by the task key a seat works under (TaskKeys). */
export class Rounds {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly file: string) {
    let undated = false;
    for (const [key, task] of Object.entries(readJson<Record<string, Stored>>(file, {}))) {
      undated ||= task.at === undefined;
      this.tasks.set(key, { ...task, at: task.at ?? Date.now() });
    }
    // rounds an older file kept have no date: their keep starts now, and stays started across restarts
    if (undated) this.save();
  }

  private save(): void {
    writeJson(this.file, Object.fromEntries(this.tasks));
  }

  private stateOf(key: string): Task {
    return this.tasks.get(key) ?? { pending: false, rejected: 0, at: Date.now() };
  }

  private keep(key: string, task: Task): void {
    this.tasks.set(key, { ...task, at: Date.now() });
    this.save();
  }

  /** Whether this candidate still owes its fresh-eyes pass; yes is said once per candidate. */
  owesFreshEyes(key: string): boolean {
    const task = this.stateOf(key);
    if (task.reread) return false;
    this.keep(key, { ...task, reread: true });
    return true;
  }

  /** A candidate of this task went up; returns the rejections its task has met so far. */
  handedIn(key: string): number {
    const task = this.stateOf(key);
    this.keep(key, { ...task, pending: true });
    return task.rejected;
  }

  /** The Owner's mail on this task; returns the rejections so far, counting this mail when it is one. `seat` is the key the task may also have been counted under. */
  answered(key: string, opening: string, seat?: string): number {
    const verdict = verdictOf(opening);
    if (verdict === "accepted" || verdict === "deferred") {
      const ended = [key, ...(seat ? [seat] : [])].filter((one) => this.tasks.delete(one));
      if (ended.length > 0) this.save();
      return 0;
    }
    const task = this.stateOf(key);
    // a revised brief that answers a candidate sends it back, whatever its subject calls itself
    if (verdict === "returned" && (task.pending || !onlyAfterCandidate(opening))) {
      // the repair is a new candidate: it owes its own pass
      this.keep(key, { ...task, rejected: task.rejected + 1, pending: false, reread: false });
      return task.rejected + 1;
    }
    return task.rejected;
  }

  /** The rejections a task has met since its last ACCEPT. */
  rejected(key: string): number {
    return this.tasks.get(key)?.rejected ?? 0;
  }

  forget(key: string): void {
    if (this.tasks.delete(key)) this.save();
  }

  /** Drops the tasks untouched since `before`: a task nobody finished leaves its rounds behind. */
  expire(before: Date): number {
    const stale = [...this.tasks].filter(([, task]) => task.at < before.getTime());
    for (const [key] of stale) this.tasks.delete(key);
    if (stale.length > 0) this.save();
    return stale.length;
  }
}

interface Standing {
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

export const FRESH_EYES = [
  "Your candidate has not gone to your Owner yet: first one pass over it with fresh eyes.",
  "Read again everything you wrote or changed for this task as if another seat had written it and you were hunting its defects:",
  "1. each line of the brief's contract and acceptance evidence, against the code that answers it;",
  "2. each test you added: the wrong behavior it would still let through;",
  "3. each file you changed: an edit the brief did not ask for, a leftover, a check made weaker than it was.",
  "Run again what the brief names as acceptance evidence. Fix what you find and commit it.",
  "Then hand in again exactly as you did, with the final sha, and open the report's second line with `Fresh eyes: <what the pass found and fixed, or nothing>`.",
].join("\n");
