import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorkStore, type WorkPolicy } from "./store";
import { projectPolicy, WORK_DIR } from "./tools";

/** The room's work stores, one per project. */

/** One open work store per project, opened on first use; `policy` is the room's, undefined when its files predate the work store. */
export class WorkStores {
  private readonly open = new Map<string, WorkStore>();

  constructor(
    private readonly policy: WorkPolicy | undefined,
    private readonly log: (message: string) => void,
  ) {}

  /** A project's store and the rules in force there; throws when the room's files predate the work store. */
  of(root: string): { store: WorkStore; rules: WorkPolicy } {
    if (!this.policy) throw new Error("the room's files are from an earlier version; set the room up again");
    const rules = projectPolicy(root, this.policy);
    let store = this.open.get(root);
    if (!store) {
      this.open.set(root, (store = new WorkStore(join(root, WORK_DIR), rules)));
      if (store.startedOver)
        this.log(`work: the store of ${root} was damaged; it was set aside and read back from issues.jsonl`);
    }
    return { store, rules };
  }

  /** A project's store when it has one already; null when it has none yet. */
  existing(root: string | null): WorkStore | null {
    if (!root || !this.policy || !existsSync(join(root, WORK_DIR, "work.db"))) return null;
    return this.of(root).store;
  }

  /** Expires the closed issues past their keep in the stores of these projects, those that have one; returns how many left. */
  expire(before: Date, roots: readonly string[]): number {
    let gone = 0;
    for (const root of roots)
      try {
        gone += this.existing(root)?.expire(before) ?? 0;
      } catch (error) {
        this.log(`work: expiring the closed issues of ${root} failed: ${(error as Error).message}`);
      }
    return gone;
  }

  /** Closes every store, the text copy of each written first. */
  close(): void {
    for (const store of this.open.values()) store.close();
    this.open.clear();
  }
}
