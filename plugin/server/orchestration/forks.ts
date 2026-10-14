import catalog from "../../shared/forks.json";

/** Small choices about mail and work put to the decision model: a sharp answer is acted on, a split one keeps the room's rule. */

export type ForkName = keyof typeof catalog.forks;

/** The model's word on one fork: its label, how sure it is, and whether that is sharp enough to act on. */
export interface Fork {
  label: string | null;
  probability: number;
  sharp: boolean;
  askId: number | null;
  why: string | null;
}

/** The decision model as the forks use it; the Jev district gives it. */
export interface Router {
  why(): string | null;
  routes(
    caller: string,
    state: Record<string, unknown>,
    questions: Record<string, never>,
    sharpAt: number,
    options?: { deadlineMs?: number },
  ): Promise<Record<string, Fork>>;
}

/** What forks take from the room: the model, which forks are on, a threshold set apart from the catalog's, and a log. */
interface ForkDeps {
  router: Router | null;
  on(name: ForkName): boolean;
  sharpAt?(name: ForkName): number | undefined;
  log(line: string): void;
}

const FORKS = catalog.forks;

/** The head of a text a fork reads. */
export function clip(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most)}…` : text;
}

/** The catalog of forks asked of the decision model; an answer that fails or is split leaves the room's own rule. */
export class Forks {
  constructor(private readonly deps: ForkDeps) {}

  /** Whether a fork is asked at all: on in the policy, with a model that can answer now. */
  open(name: ForkName): boolean {
    return !!this.deps.router && this.deps.on(name) && this.deps.router.why() === null;
  }

  /** One fork: its sharp label, or null to keep the room's own rule; `labels` stand in for a choice's own when given. */
  async take(
    name: ForkName,
    state: Record<string, unknown>,
    labels?: Record<string, string | null>,
  ): Promise<string | null> {
    return (await this.takeMany(name, state, ["fork"], labels))[0];
  }

  /** Questions of one fork asked in one call, one per id; the sharp label of each in the same order, null where it is split. */
  async takeMany(
    name: ForkName,
    state: Record<string, unknown>,
    ids: readonly string[],
    labels?: Record<string, string | null>,
  ): Promise<(string | null)[]> {
    if (ids.length === 0 || !this.open(name)) return ids.map(() => null);
    const fork = FORKS[name];
    const question = labels ? { ...fork.question, criteria: labels } : fork.question;
    const asked = Object.fromEntries(
      ids.map((id) => [id, { ...question, instructions: question.instructions.replaceAll("{{id}}", id) } as never]),
    );
    let found: Record<string, Fork>;
    try {
      // a threshold the policy sets holds when it is one: from a half up to certainty
      const set = this.deps.sharpAt?.(name);
      const sharpAt = typeof set === "number" && set >= 0.5 && set <= 1 ? set : fork.sharpAt;
      found = await this.deps.router!.routes(`forks.${name}@${fork.version}`, state, asked, sharpAt, {
        deadlineMs: fork.deadlineMs,
      });
    } catch (error) {
      // a fork only advises: a model that fails must not stop the mail or the turn that asked
      this.deps.log(
        `fork ${name}: the decision model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return ids.map(() => null);
    }
    return ids.map((id) => {
      const one = found[id];
      if (!one?.sharp || one.label === null) return null;
      this.deps.log(`fork ${name}${ids.length > 1 ? ` ${id}` : ""}: ${one.label} (${one.probability.toFixed(2)})`);
      return one.label;
    });
  }
}
