import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../redact";
import { call } from "./client";
import { checkRequest, DecisionError, type Answer, type Questions, type State } from "./contract";
import { DIALECTS, type Dialect } from "./dialects";
import { JevStore } from "./store";

/** The Jev district: decisions from the provider in force, logged, costed and held under a monthly cap. */

export type ProviderName = "jev" | "openrouter" | "custom";

export interface ProviderPolicy {
  url: string;
  model: string;
  dialect: Dialect;
  keyEnv?: string;
  usdPerMillionInput: number;
}

export interface JevPolicy {
  provider: ProviderName;
  providers: Record<ProviderName, ProviderPolicy>;
  monthlyCapUsd: number;
  attemptSeconds: number;
  retries: number;
  keepDays: number;
}

export interface JevDeps {
  dir: string;
  policy(): JevPolicy | undefined;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  fetch?: typeof fetch;
}

export interface Decision {
  callId: number;
  model: string;
  answers: Record<string, Answer>;
  asks: Record<string, number>;
  usd: number | null;
  latencyMs: number;
  attempts: number;
}

const BUSY_MS = 2000;
const DEADLINE_MS = 20_000;
const KEYLESS: readonly ProviderName[] = ["custom"];

/** A state with every string's secrets hidden, before it leaves the machine or is logged. */
function hidden(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(hidden);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, hidden(inner)]));
  return value;
}

/** The first number of the policy that no call could run with, by its name. */
function outOfRange(policy: JevPolicy, settings: ProviderPolicy): string | null {
  const within = (value: unknown, least: number, most: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= least && value <= most;
  if (!within(policy.monthlyCapUsd, 0, 10_000)) return "monthlyCapUsd";
  if (!within(policy.attemptSeconds, 1, 120)) return "attemptSeconds";
  if (!Number.isInteger(policy.retries) || !within(policy.retries, 0, 5)) return "retries";
  if (!within(policy.keepDays, 1, 3650)) return "keepDays";
  if (!within(settings.usdPerMillionInput, 0, 1000)) return `providers.${policy.provider}.usdPerMillionInput`;
  return null;
}

export class Jev {
  private storeHandle: JevStore | null = null;

  constructor(private readonly deps: JevDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Where a provider's key is kept, when no env variable names it. */
  keyFile(name: ProviderName): string {
    return join(this.deps.dir, `${name}.key`);
  }

  private key(name: ProviderName, settings: ProviderPolicy): string | undefined {
    const fromEnv = settings.keyEnv ? (this.deps.env ?? process.env)[settings.keyEnv]?.trim() : undefined;
    if (fromEnv) return fromEnv;
    const file = this.keyFile(name);
    return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
  }

  /** The provider in force, or why there is none. */
  private provider():
    { name: ProviderName; settings: ProviderPolicy; policy: JevPolicy; key: string | undefined } | { why: string } {
    const policy = this.deps.policy();
    const name = policy?.provider;
    const settings = name ? policy?.providers?.[name] : undefined;
    if (!policy || !name || !settings) return { why: "no decision provider is set up in the policy" };
    if (!settings.url || !settings.model) return { why: `${name} has no url or model in the policy` };
    if (!DIALECTS.includes(settings.dialect)) return { why: `${name} names an unknown dialect ${settings.dialect}` };
    const bad = outOfRange(policy, settings);
    if (bad) return { why: `the policy's jev.${bad} is out of range` };
    const key = this.key(name, settings);
    if (!key && !KEYLESS.includes(name))
      return {
        why: `no key for ${name}: put it in ${this.keyFile(name)}${settings.keyEnv ? ` or ${settings.keyEnv}` : ""}`,
      };
    return { name, settings, policy, key };
  }

  /** Why no decision can be asked now; null when one can. */
  why(): string | null {
    const found = this.provider();
    return "why" in found ? found.why : null;
  }

  store(): JevStore {
    return (this.storeHandle ??= new JevStore(this.deps.dir, BUSY_MS, () => this.now()));
  }

  /** The log when one exists: reading the district never makes its file. */
  private existing(): JevStore | null {
    return this.storeHandle || existsSync(join(this.deps.dir, "decisions.db")) ? this.store() : null;
  }

  /** This month's spending, in USD, against the cap. */
  spent(): { month: string; usd: number; capUsd: number } {
    const month = this.now().toISOString().slice(0, 7);
    return { month, usd: this.existing()?.spent(month) ?? 0, capUsd: this.deps.policy()?.monthlyCapUsd ?? 0 };
  }

  /** Asks the provider in force; every call is logged, a failed one with its error. */
  async decide(
    caller: string,
    state: State,
    questions: Questions,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<Decision> {
    const found = this.provider();
    if ("why" in found) throw new DecisionError(found.why.startsWith("no key") ? "NO_KEY" : "OFF", found.why);
    const { name, settings, policy, key } = found;
    const { usd: spent, capUsd } = this.spent();
    if (spent >= capUsd)
      throw new DecisionError("CAP", `this month's decisions cost ${spent.toFixed(4)} USD; the cap is ${capUsd} USD`);
    const sent = hidden(state) as State;
    checkRequest(sent, questions);
    const text = JSON.stringify(sent);
    const stateHash = createHash("sha256").update(text).digest("hex");
    const logged = { caller, provider: name, modelAsked: settings.model, stateHash };
    const started = Date.now();
    try {
      const reply = await call(settings.dialect, { url: settings.url, model: settings.model, key }, sent, questions, {
        attemptMs: policy.attemptSeconds * 1000,
        retries: policy.retries,
        deadlineMs: options.deadlineMs ?? DEADLINE_MS,
        signal: options.signal,
        fetch: this.deps.fetch,
      });
      const priced = settings.usdPerMillionInput > 0 ? (reply.inputTokens * settings.usdPerMillionInput) / 1e6 : null;
      const usd = reply.costUsd ?? priced;
      const { callId, asks } = this.store().record(
        {
          ...logged,
          model: reply.model || null,
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          usd,
          usdSource: reply.costUsd !== null ? "provider" : priced !== null ? "price" : null,
          latencyMs: reply.latencyMs,
          attempts: reply.attempts,
          error: null,
        },
        reply.answers,
        { hash: stateHash, text },
      );
      return {
        callId,
        model: reply.model,
        answers: reply.answers,
        asks,
        usd,
        latencyMs: reply.latencyMs,
        attempts: reply.attempts,
      };
    } catch (error) {
      if (error instanceof DecisionError)
        this.store().record({
          ...logged,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          usd: null,
          usdSource: null,
          latencyMs: Date.now() - started,
          attempts: error.attempts,
          error: `${error.code}: ${error.message}`,
        });
      throw error;
    }
  }

  /** A label that came later for one logged answer. */
  label(askId: number, source: string, value: string, note?: string): boolean {
    return this.store().label(askId, source, value, note ?? null);
  }

  /** Drops states read before `before`, and calls older than the policy keeps that no label holds. */
  expire(before: Date): number {
    const keepDays = this.deps.policy()?.keepDays ?? 90;
    const gone = this.existing()?.expire(before, new Date(this.now().getTime() - keepDays * 86_400_000));
    return gone ? gone.states + gone.calls : 0;
  }

  close(): void {
    this.storeHandle?.close();
    this.storeHandle = null;
  }
}
