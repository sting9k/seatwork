import type { Role } from "./seats";

/** Where a Peer's task stands: the candidates it handed in and the rejections they met since its last ACCEPT. */
export class Rounds {
  private readonly tasks = new Map<string, { pending: boolean; rejected: number; reread?: boolean }>();

  /** Whether this candidate still owes its pass with fresh eyes; the answer yes is given once per candidate. */
  owesFreshEyes(peer: string): boolean {
    const task = this.tasks.get(peer) ?? { pending: false, rejected: 0 };
    if (task.reread) return false;
    task.reread = true;
    this.tasks.set(peer, task);
    return true;
  }

  /** A candidate went up from this Peer; returns the rejections its task has met so far. */
  handedIn(peer: string): number {
    const task = this.tasks.get(peer) ?? { pending: false, rejected: 0 };
    task.pending = true;
    this.tasks.set(peer, task);
    return task.rejected;
  }

  /** The Owner's mail to this Peer; returns the rejections so far, counting this mail when it is one. */
  answered(peer: string, opening: string): number {
    if (opening === "ACCEPT" || opening === "DEFER") {
      this.tasks.delete(peer);
      return 0;
    }
    const task = this.tasks.get(peer) ?? { pending: false, rejected: 0 };
    // a revised brief that answers a candidate sends it back, whatever its subject calls itself
    const rejects = opening === "REJECT" || (opening === "REVISED BRIEF" && task.pending);
    if (rejects) {
      task.rejected += 1;
      task.pending = false;
      // the repair is a new candidate: it owes its own pass
      task.reread = false;
      this.tasks.set(peer, task);
    }
    return task.rejected;
  }

  rejected(peer: string): number {
    return this.tasks.get(peer)?.rejected ?? 0;
  }

  forget(peer: string): void {
    this.tasks.delete(peer);
  }

  /** A successor takes the task over as it stands. */
  move(from: string, to: string): void {
    const task = this.tasks.get(from);
    if (!task) return;
    this.tasks.delete(from);
    this.tasks.set(to, task);
  }
}

export interface Standing {
  role: Role;
  candidate: boolean;
  rejected: number;
  contextTokens: number | null;
  rotateAtTokens: number;
}

/** What the room writes under a report for the seat above: the task's round, and a context past the rotation line. */
export function ownerNote(standing: Standing): string | null {
  const lines: string[] = [];
  if (standing.candidate && standing.rejected === 1)
    lines.push(
      "Second candidate of this task: one rejection since its last ACCEPT. Should this one fail too, the repair goes to a new Peer with a fresh context (its brief: the defects as failing tests, this candidate's sha, what was tried), and a defect of a kind the first review did not report puts the design in question: `lens` on the design, or DECISION_NEEDED, before a writer continues.",
    );
  if (standing.candidate && standing.rejected >= 2)
    lines.push(
      `Candidate ${standing.rejected + 1} of this task: ${standing.rejected} rejections since its last ACCEPT. One more rejection is your Owner's call (accept-candidate, step 5): DECISION_NEEDED with what each round found and what one more costs.`,
    );
  if (standing.contextTokens !== null && standing.contextTokens >= standing.rotateAtTokens) {
    const held = `holds ${Math.round(standing.contextTokens / 1000)}K tokens of context and reads them again at every step`;
    if (standing.role === "lead")
      lines.push(`This Lead ${held}. Hand its workstream to a successor at its next quiet point (lead-handoff).`);
    else if (standing.role === "peer")
      lines.push(`This Peer ${held}. Its next task, or its next repair, goes to a new Peer.`);
  }
  return lines.length > 0 ? lines.map((line) => `[room] ${line}`).join("\n") : null;
}

/** What a writing Peer reads when its first hand-in of a candidate comes back for one pass with fresh eyes. */
export const FRESH_EYES = [
  "Your candidate has not gone to your Owner yet: first one pass over it with fresh eyes.",
  "Read again everything you wrote or changed for this task as if another seat had written it and you were hunting its defects:",
  "1. each line of the brief's contract and acceptance evidence, against the code that answers it;",
  "2. each test you added: the wrong behavior it would still let through;",
  "3. each file you changed: an edit the brief did not ask for, a leftover, a check made weaker than it was.",
  "Run again what the brief names as acceptance evidence. Fix what you find and commit it.",
  "Then hand in again exactly as you did, with the final sha, and open the report's second line with `Fresh eyes: <what the pass found and fixed, or nothing>`.",
].join("\n");
