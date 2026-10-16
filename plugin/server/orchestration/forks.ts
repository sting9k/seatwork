import catalog from "../../shared/forks.json";
import type { Meaning } from "../jev/contract";

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
  answered?(caller: string, sharpAt: number, since: Date): { asked: number; sure: number; failed: number };
}

/** One fork over the last week: on or off, its threshold, its answers acted on and left split, its failed calls. */
interface ForkReading {
  on: boolean;
  sharpAt: number;
  asked: number;
  acted: number;
  split: number;
  failed: number;
}

/** What forks take from the room: the model, which forks are on, a threshold set apart from the catalog's, and a log. */
interface ForkDeps {
  router: Router | null;
  on(name: ForkName): boolean;
  sharpAt?(name: ForkName): number | undefined;
  log(line: string): void;
}

const FORKS = catalog.forks;
const READING_DAYS = 7;

/** The head of a text a fork reads. */
export function clip(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most)}…` : text;
}

/** Whether the room needs a fork, so it is on whatever the policy lists. */
export const required = (name: ForkName): boolean => "required" in FORKS[name] && FORKS[name].required === true;

/** The words the catalog gives a fork's labels; empty for a fork whose labels come with the call. */
export function meanings(name: ForkName): Record<string, Meaning> {
  return FORKS[name].question.criteria as Record<string, Meaning>;
}

/** The catalog of forks asked of the decision model; an answer that fails or is split leaves the room's own rule. */
export class Forks {
  constructor(private readonly deps: ForkDeps) {}

  /** A fork's threshold: the policy's when it is one, from a half up to certainty, else the catalog's. */
  private sharpAtOf(name: ForkName): number {
    const set = this.deps.sharpAt?.(name);
    return typeof set === "number" && set >= 0.5 && set <= 1 ? set : FORKS[name].sharpAt;
  }

  /** Each fork that is on or was asked in the last week: its threshold, its answers acted on and left split, its failed calls. */
  reading(now = new Date()): Record<string, ForkReading> {
    const since = new Date(now.getTime() - READING_DAYS * 86_400_000);
    const out: Record<string, ForkReading> = {};
    for (const name of Object.keys(FORKS) as ForkName[]) {
      const sharpAt = this.sharpAtOf(name);
      const counts = this.deps.router?.answered?.(`forks.${name}`, sharpAt, since) ?? { asked: 0, sure: 0, failed: 0 };
      const on = this.isOn(name);
      if (on || counts.asked > 0 || counts.failed > 0)
        out[name] = {
          on,
          sharpAt,
          asked: counts.asked,
          acted: counts.sure,
          split: counts.asked - counts.sure,
          failed: counts.failed,
        };
    }
    return out;
  }

  /** Whether a fork is asked at all: needed by the room or on in the policy, with a model that can answer now. */
  open(name: ForkName): boolean {
    return !!this.deps.router && this.isOn(name) && this.deps.router.why() === null;
  }

  /** Whether a fork is on: the room needs it, or the policy lists it. */
  private isOn(name: ForkName): boolean {
    return required(name) || this.deps.on(name);
  }

  /** One fork: its sharp label, or null to keep the room's own rule; `labels` stand in for a choice's own when given. */
  async take(name: ForkName, state: Record<string, unknown>, labels?: Record<string, Meaning>): Promise<string | null> {
    return (await this.takeMany(name, state, ["fork"], labels))[0];
  }

  /** Questions of one fork asked in one call, one per id; the sharp label of each in the same order, null where it is split. */
  async takeMany(
    name: ForkName,
    state: Record<string, unknown>,
    ids: readonly string[],
    labels?: Record<string, Meaning>,
  ): Promise<(string | null)[]> {
    if (ids.length === 0 || !this.open(name)) return ids.map(() => null);
    const fork = FORKS[name];
    const question = labels ? { ...fork.question, criteria: labels } : fork.question;
    const asked = Object.fromEntries(
      ids.map((id) => [id, { ...question, instructions: question.instructions.replaceAll("{{id}}", id) } as never]),
    );
    let found: Record<string, Fork>;
    try {
      found = await this.deps.router!.routes(`forks.${name}@${fork.version}`, state, asked, this.sharpAtOf(name), {
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

/** What a district asks of the forks: whether one is on, and its sharp label, for one question or several. */
export type Asker = Pick<Forks, "open" | "take" | "takeMany">;
