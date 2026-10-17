import { existsSync } from "node:fs";
import { join } from "node:path";
import config from "../../shared/work.json";
import { WorkStore, type Lapsed, type Seating, type WorkPolicy } from "./store";
import { projectPolicy, WORK_DIR } from "./tools";

/** The room's work stores, one per project. */

/** The issues that went back to the board in one project. */
interface Passed {
  root: string;
  lapsed: Lapsed[];
}

/** One open work store per project, made on first use. */
export class WorkStores {
  private readonly open = new Map<string, WorkStore>();
  private sweeping = false;

  constructor(
    private readonly policy: WorkPolicy,
    private readonly log: (message: string) => void,
    private readonly leased: (holder: string) => boolean = () => true,
  ) {}

  /** A project's store and the rules in force there. */
  of(root: string): { store: WorkStore; rules: WorkPolicy } {
    const rules = projectPolicy(root, this.policy);
    let store = this.open.get(root);
    if (!store) {
      store = new WorkStore(join(root, WORK_DIR), rules, undefined, this.leased);
      this.open.set(root, store);
      if (store.startedOver) this.log(`work: the store of ${root} was damaged; it was set aside and starts empty`);
    }
    return { store, rules };
  }

  /** A project's store when it has one already; null when it has none yet. */
  existing(root: string | null): WorkStore | null {
    if (!root || !existsSync(join(root, WORK_DIR, "work.db"))) return null;
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

  /** The minute's pass over these projects' leases: when one is due, `seating` is read once, its seats are renewed and the issues of unlisted seats go back to the board; null leaves every lease. */
  async leases(roots: readonly string[], seating: () => Promise<Seating | null>): Promise<Passed[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const due = roots.flatMap((root) => {
        try {
          const store = this.existing(root);
          return store?.leaseDue() ? [{ root, store }] : [];
        } catch (error) {
          this.log(`work: the leases of ${root} could not be read: ${(error as Error).message}`);
          return [];
        }
      });
      const seen = due.length > 0 ? await seating() : null;
      if (!seen) return [];
      const listed = [...seen.alive, ...seen.unsure];
      const out: Passed[] = [];
      for (const { root, store } of due)
        try {
          store.renewLeases(seen.alive);
          const lapsed = store.expireLeases(listed, config.leaseMostPerPass);
          if (lapsed.length > 0) out.push({ root, lapsed });
        } catch (error) {
          this.log(`work: the leases of ${root} could not be swept: ${(error as Error).message}`);
        }
      return out;
    } finally {
      this.sweeping = false;
    }
  }

  /** Closes every store. */
  close(): void {
    for (const store of this.open.values()) store.close();
    this.open.clear();
  }
}
