/** The decision model behind the gate: questions in, a probability per answer out; a call never throws. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Instructions and criteria may be text or small JSON objects. */
export type DecisionQuestion =
  | { type: "noul"; instructions: JsonValue; criteria?: { true?: JsonValue; false?: JsonValue } }
  | { type: "choice"; instructions: JsonValue; criteria: Record<string, JsonValue> };

export interface DecisionRequest {
  state: JsonValue;
  questions: Record<string, DecisionQuestion>;
}

export type DecisionAnswer =
  /** Probability that the answer is yes. */
  | { type: "noul"; noul: number }
  /** A probability per option, summing to about 1. */
  | { type: "choice"; choice: string; probabilities: Record<string, number> };

export type DecisionReply =
  | { ok: true; model: string; answers: Record<string, DecisionAnswer>; inputTokens: number; ms: number }
  | { ok: false; reason: "no-key" | "resting" | "timeout" | "refused" | "unreachable" | "malformed"; detail: string };

export interface DecisionEngine {
  /** A key is set and the engine is not resting after failures. */
  ready(): boolean;
  ask(request: DecisionRequest): Promise<DecisionReply>;
}

export interface JevOptions {
  apiKey: string | undefined;
  /** The full endpoint (TypeSafe's `…/v1/systemone`, OpenRouter's `…/api/alpha/decisions`). */
  url: string;
  /** A versioned id: thresholds are fitted to one version. */
  model: string;
  /** The whole call, retry included. */
  deadlineMs: number;
  restAfterFailures: number;
  restMinutes: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Statuses that mean "not now": one more try inside the deadline. */
const RETRY = new Set([408, 429, 500, 502, 503, 504, 529]);
/** Statuses that will not change until someone acts (a bad key, no balance): rest at once. */
const STANDING = new Set([401, 402, 403]);

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The answers of a reply, kept only where they have the shape their question asked for. */
function readAnswers(body: unknown, questions: DecisionRequest["questions"]): Record<string, DecisionAnswer> | null {
  const answers = (body as { answers?: Record<string, Record<string, unknown>> } | null)?.answers;
  if (!answers || typeof answers !== "object") return null;
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer || answer.type !== question.type) return null;
    if (question.type === "noul") {
      const noul = number(answer.noul);
      if (noul === null) return null;
      out[id] = { type: "noul", noul };
    } else {
      const probabilities = answer.probabilities as Record<string, unknown> | undefined;
      if (!probabilities || typeof answer.choice !== "string") return null;
      const read: Record<string, number> = {};
      for (const option of Object.keys(question.criteria)) read[option] = number(probabilities[option]) ?? 0;
      out[id] = { type: "choice", choice: answer.choice, probabilities: read };
    }
  }
  return out;
}

export class JevEngine implements DecisionEngine {
  private failures = 0;
  private restUntil = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: JevOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  ready(): boolean {
    return !!this.options.apiKey && this.now() >= this.restUntil;
  }

  private failed(standing: boolean): void {
    this.failures += 1;
    if (standing || this.failures >= this.options.restAfterFailures) {
      this.restUntil = this.now() + this.options.restMinutes * 60_000;
      this.failures = 0;
    }
  }

  async ask(request: DecisionRequest): Promise<DecisionReply> {
    if (!this.options.apiKey) return { ok: false, reason: "no-key", detail: "no API key is set" };
    if (this.now() < this.restUntil) return { ok: false, reason: "resting", detail: `resting after failures until ${new Date(this.restUntil).toISOString()}` };
    const started = this.now();
    const deadline = AbortSignal.timeout(this.options.deadlineMs);
    const body = JSON.stringify({ model: this.options.model, state: request.state, questions: request.questions });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetch(this.options.url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body,
          signal: deadline,
        });
      } catch (error) {
        this.failed(false);
        return deadline.aborted ? { ok: false, reason: "timeout", detail: `no answer within ${this.options.deadlineMs} ms` } : { ok: false, reason: "unreachable", detail: error instanceof Error ? error.message : String(error) };
      }
      if (response.ok) {
        const parsed = await response.json().catch(() => null);
        const answers = readAnswers(parsed, request.questions);
        const inputTokens = number((parsed as { usage?: { input_tokens?: unknown } } | null)?.usage?.input_tokens);
        if (!answers || inputTokens === null) {
          this.failed(false);
          return { ok: false, reason: "malformed", detail: "the reply did not carry an answer of the asked type for every question" };
        }
        this.failures = 0;
        return { ok: true, model: String((parsed as { model?: unknown }).model ?? this.options.model), answers, inputTokens, ms: this.now() - started };
      }
      const detail = `${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`;
      if (attempt === 0 && RETRY.has(response.status)) {
        const wait = Math.min(Number(response.headers.get("retry-after-ms")) || Number(response.headers.get("retry-after")) * 1000 || 300, 1500);
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (!deadline.aborted) continue;
      }
      this.failed(STANDING.has(response.status));
      return { ok: false, reason: "refused", detail };
    }
    return { ok: false, reason: "timeout", detail: `no answer within ${this.options.deadlineMs} ms` };
  }
}

/** A conservative guess at billed input tokens: about 300 fixed, then 3.5 characters per token. */
export function estimateTokens(request: DecisionRequest): number {
  return 300 + Math.ceil(JSON.stringify(request).length / 3.5);
}
