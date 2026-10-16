import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstNotEnglish } from "../english";
import { probeChat, type ChatProbe } from "./chat";
import { call } from "./client";
import {
  checkRequest,
  DecisionError,
  LIMITS,
  tokensOf,
  type Answer,
  type ChoiceQuestion,
  type DecisionFailure,
  type NoulQuestion,
  type Questions,
  type Reply,
  type State,
} from "./contract";
import { DIALECTS, type Dialect } from "./dialects";
import { cleanState, guarded } from "./input";
import { merged, REVERSED, withReversed } from "./order";
import { JevStore, type CallRow } from "./store";

/** The Jev district: decisions from the provider in force, input made safe, calls logged, costed, capped, and held off while it is down. */

export type ProviderName = "jev" | "openrouter" | "custom";

/** One provider's wire: url, model and dialect, the env variable of its key, and its price per million input tokens. */
export interface ProviderPolicy {
  url: string;
  model: string;
  dialect: Dialect;
  keyEnv?: string;
  usdPerMillionInput: number;
}

/** The policy's jev section: the provider in force and every provider's wire, a call's limits, and the forks. */
export interface JevPolicy {
  provider: ProviderName;
  providers: Record<ProviderName, ProviderPolicy>;
  attemptSeconds: number;
  retries: number;
  keepDays: number;
  forks?: string[];
  sharpAt?: Record<string, number>;
}

/** What the district takes: its folder and policy, and stand-ins for the environment, clock, network and log. */
export interface JevDeps {
  dir: string;
  policy(): JevPolicy | undefined;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** A decision as its caller reads it: the answers, the ids they were logged under, the choices whose two orders chose apart, its cost, and whether memory gave it. */
export interface Decision {
  model: string;
  answers: Record<string, Answer>;
  asks: Record<string, number>;
  parted: string[];
  usd: number | null;
  latencyMs: number;
  attempts: number;
  suspect: string | null;
  cached: boolean;
}

/** A check of the provider in force: when, whether it answered, in how many milliseconds, or why not. */
export interface JevCheck {
  at: string;
  ok: boolean;
  ms: number | null;
  why: string | null;
}

/** A fork the room takes on the model's word: `sharp` when the model is sure and the state gave it no orders. */
export interface Fork {
  label: string | null;
  probability: number;
  sharp: boolean;
  askId: number | null;
  why: string | null;
}

const BUSY_MS = 2000;
const DEADLINE_MS = 20_000;
const KEYLESS: readonly ProviderName[] = ["custom"];
const KEY_KEPT_MS = 30_000;
const CHECK = {
  state: "The test suite ran after the last edit, and all 42 tests passed.",
  questions: { passed: { type: "noul", instructions: "Does the text say the tests passed?" } } as Questions,
};
const FLOW = { inFlight: 8, waiting: 32 } as const;
const BREAKER = { trips: 3, firstMs: 30_000, mostMs: 600_000 } as const;
const CACHE = { entries: 256, keptMs: 600_000 } as const;
const PROVIDER_DOWN: readonly DecisionFailure[] = ["TIMEOUT", "NETWORK", "HTTP"];
const OWN_FAULT = new Set([400, 413, 422]);

/** The first number of the policy that no call could run with, by its name. */
function outOfRange(policy: JevPolicy, settings: ProviderPolicy): string | null {
  const within = (value: unknown, least: number, most: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= least && value <= most;
  if (!within(policy.attemptSeconds, 1, 120)) return "attemptSeconds";
  if (!Number.isInteger(policy.retries) || !within(policy.retries, 0, 5)) return "retries";
  if (!within(policy.keepDays, 1, 3650)) return "keepDays";
  if (!within(settings.usdPerMillionInput, 0, 1000)) return `providers.${policy.provider}.usdPerMillionInput`;
  return null;
}

/** What a reply cost: the provider's figure, else the price on its input tokens, or on what was sent when it counts none. */
function costOf(
  reply: Reply,
  usdPerMillionInput: number,
  sentTokens: () => number,
): { usd: number | null; usdSource: CallRow["usdSource"] } {
  const tokens = reply.inputTokens > 0 ? reply.inputTokens : sentTokens();
  const priced = usdPerMillionInput > 0 ? (tokens * usdPerMillionInput) / 1e6 : null;
  return {
    usd: reply.costUsd ?? priced,
    usdSource: reply.costUsd !== null ? "provider" : priced !== null ? "price" : null,
  };
}

/** The log row of a call that failed or was refused. */
function failedRow(
  logged: Pick<CallRow, "caller" | "provider" | "modelAsked" | "stateHash" | "suspect">,
  error: DecisionError,
  latencyMs: number,
): CallRow {
  return {
    ...logged,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    usd: null,
    usdSource: null,
    latencyMs,
    attempts: error.attempts,
    error: `${error.code}: ${error.message}`,
  };
}

/** An answer's label and how sure it is of it, the way a fork weighs it. */
function labelOf(answer: Answer): { label: string; probability: number } {
  if (answer.type === "noul")
    return { label: answer.noul >= 0.5 ? "true" : "false", probability: Math.max(answer.noul, 1 - answer.noul) };
  if (answer.type === "choice")
    return { label: answer.choice, probability: answer.probabilities[answer.choice] ?? answer.confidence };
  return { label: String(answer.score), probability: answer.confidence };
}

/** The district: puts questions to the provider in force and logs every call. */
export class Jev {
  private storeHandle: JevStore | null = null;
  private readonly keys = new Map<ProviderName, { at: number; key: string | undefined }>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly down = { failures: 0, opens: 0, until: 0, round: 0, probing: false };
  private readonly cache = new Map<string, { at: number; decision: Decision }>();
  private unfit: { wire: string; why: string } | null = null;
  private lastCheck: JevCheck | null = null;

  constructor(private readonly deps: JevDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Where a provider's key is kept, when no env variable names it. */
  private keyFile(name: ProviderName): string {
    return join(this.deps.dir, `${name}.key`);
  }

  /** A provider's key from its env variable, or its file read again at most every half minute. */
  private key(name: ProviderName, settings: ProviderPolicy): string | undefined {
    const fromEnv = settings.keyEnv ? (this.deps.env ?? process.env)[settings.keyEnv]?.trim() : undefined;
    if (fromEnv) return fromEnv;
    const now = this.now().getTime();
    const kept = this.keys.get(name);
    if (kept && now - kept.at < KEY_KEPT_MS) return kept.key;
    let key: string | undefined;
    try {
      key = readFileSync(this.keyFile(name), "utf8").trim() || undefined;
    } catch {
      // a file that is missing or unreadable is no key; `why()` names the file
    }
    this.keys.set(name, { at: now, key });
    return key;
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
    if (this.unfit?.wire === `${settings.url}\0${settings.model}`) return { why: this.unfit.why };
    const bad = outOfRange(policy, settings);
    if (bad) return { why: `the policy's jev.${bad} is out of range` };
    const key = this.key(name, settings);
    if (!key && !KEYLESS.includes(name))
      return {
        why: `no key for ${name}: put it in ${this.keyFile(name)}${settings.keyEnv ? ` or ${settings.keyEnv}` : ""}`,
      };
    return { name, settings, policy, key };
  }

  /** Where the key of the provider in force comes from: its env variable, its file, nowhere, or none is needed. */
  keySource(): "file" | "env" | "none" | "keyless" {
    const policy = this.deps.policy();
    const name = policy?.provider;
    const settings = name ? policy?.providers?.[name] : undefined;
    if (!name || !settings) return "none";
    if (KEYLESS.includes(name)) return "keyless";
    if (settings.keyEnv && (this.deps.env ?? process.env)[settings.keyEnv]?.trim()) return "env";
    return this.key(name, settings) ? "file" : "none";
  }

  /** Keeps the person's key for the provider in force in its file, readable by them alone; the next call reads it. */
  saveKey(key: string): void {
    const name = this.deps.policy()?.provider;
    if (!name) throw new Error("no decision provider is set up in the policy");
    mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    const file = this.keyFile(name);
    writeFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    this.keys.delete(name);
  }

  /** One call with a plain question, to tell whether the provider in force answers: how long it took, or why not. */
  async check(): Promise<JevCheck> {
    const at = this.now().toISOString();
    try {
      const { latencyMs } = await this.decide("check", CHECK.state, CHECK.questions, { fresh: true });
      this.lastCheck = { at, ok: true, ms: latencyMs, why: null };
    } catch (error) {
      this.lastCheck = { at, ok: false, ms: null, why: error instanceof Error ? error.message : String(error) };
    }
    return this.lastCheck;
  }

  /** The last check since the room started, if any. */
  checked(): JevCheck | null {
    return this.lastCheck;
  }

  /** What a Chat Completions provider's endpoint gives the wire, measured with two calls; null for another dialect or for no provider. */
  async probeEndpoint(): Promise<ChatProbe | null> {
    const found = this.provider();
    if ("why" in found || found.settings.dialect !== "openai-chat") return null;
    const { url, model } = found.settings;
    return probeChat({ url, model, key: found.key }, this.deps.fetch ?? fetch);
  }

  /** Why no decision can be asked now; null when one can. */
  why(): string | null {
    const found = this.provider();
    if ("why" in found) return found.why;
    return this.now().getTime() < this.down.until ? this.downWhy() : null;
  }

  /** Why the provider is held off, and until when. */
  private downWhy(): string {
    return `the provider failed ${BREAKER.trips} times in a row; it is asked again after ${new Date(this.down.until).toISOString()}`;
  }

  /** After a hold, one call tries the provider again while the others are refused; null when no hold is on. */
  private probe(): boolean | null {
    if (this.down.opens === 0) return null;
    if (this.down.probing) throw new DecisionError("DOWN", "another call is trying the provider again after its hold");
    return (this.down.probing = true);
  }

  /** A provider's failure in a call that began in this round counts toward holding it off; a failed try after a hold holds it off longer. */
  private failed(error: DecisionError, round: number, probing: boolean): void {
    // the caller's own fault, or a call that never reached the provider, says nothing of the provider
    if (!PROVIDER_DOWN.includes(error.code) || OWN_FAULT.has(error.status ?? 0) || error.attempts === 0) return;
    // a call that began before the last hold was counted by that hold already
    if (round !== this.down.round) return;
    if (!probing && (this.down.failures += 1) < BREAKER.trips) return;
    this.down.opens += 1;
    this.down.failures = 0;
    this.down.round += 1;
    this.down.until = this.now().getTime() + Math.min(BREAKER.mostMs, BREAKER.firstMs * 2 ** (this.down.opens - 1));
    this.deps.log?.(`jev: ${this.downWhy()} (${error.code}: ${error.message.slice(0, 120)})`);
  }

  /** A place among the calls in flight, waited for until the deadline; refused when too many already wait. */
  private async slot(deadline: number): Promise<() => void> {
    const release = () => {
      this.running -= 1;
      const next = this.waiting.shift();
      if (next) next();
    };
    if (this.running < FLOW.inFlight) {
      this.running += 1;
      return release;
    }
    if (this.waiting.length >= FLOW.waiting)
      throw new DecisionError("BUSY", `${FLOW.inFlight} calls are in flight and ${FLOW.waiting} wait`);
    await new Promise<void>((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        this.running += 1;
        resolve();
      };
      const timer = setTimeout(
        () => {
          this.waiting.splice(this.waiting.indexOf(turn), 1);
          reject(new DecisionError("BUSY", "no call ended in time to make room for this one"));
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiting.push(turn);
    });
    return release;
  }

  /** The same question about the same state asked again lately: its answer, without a call. */
  private remembered(key: string): Decision | null {
    const kept = this.cache.get(key);
    if (!kept) return null;
    this.cache.delete(key);
    if (this.now().getTime() - kept.at > CACHE.keptMs) return null;
    this.cache.set(key, kept);
    return { ...kept.decision, usd: 0, latencyMs: 0, attempts: 0, cached: true };
  }

  /** Keeps a decision for its question; past the cache's size the longest unused goes. */
  private remember(key: string, decision: Decision): void {
    this.cache.set(key, { at: this.now().getTime(), decision });
    if (this.cache.size > CACHE.entries) this.cache.delete(this.cache.keys().next().value!);
  }

  /** The log, opened on first use. */
  store(): JevStore {
    return (this.storeHandle ??= new JevStore(this.deps.dir, BUSY_MS, () => this.now()));
  }

  /** The log when one exists: reading the district never makes its file. */
  private existing(): JevStore | null {
    return this.storeHandle || existsSync(join(this.deps.dir, "decisions.db")) ? this.store() : null;
  }

  /** This month's spending, in USD. */
  spent(): { month: string; usd: number } {
    const month = this.now().toISOString().slice(0, 7);
    return { month, usd: this.existing()?.spent(month) ?? 0 };
  }

  /** Asks the provider in force; every call is logged, a failed one with its error; `fresh` asks again what was answered lately. */
  async decide(
    caller: string,
    state: State,
    questions: Questions,
    options: { signal?: AbortSignal; deadlineMs?: number; fresh?: boolean } = {},
  ): Promise<Decision> {
    const found = this.provider();
    if ("why" in found) throw new DecisionError(found.why.startsWith("no key") ? "NO_KEY" : "OFF", found.why);
    if (this.now().getTime() < this.down.until) throw new DecisionError("DOWN", this.downWhy());
    const { name, settings, policy, key } = found;
    // every string's secrets are hidden before the state leaves the machine or is logged
    const { state: sent, suspect } = cleanState(state);
    const asked = withReversed(guarded(questions), LIMITS.questions);
    const text = JSON.stringify(sent);
    const stateHash = createHash("sha256").update(text).digest("hex");
    const logged = { caller, provider: name, modelAsked: settings.model, stateHash, suspect };
    const refused = this.refusal(sent, asked);
    if (refused) {
      this.store().record(failedRow(logged, refused, 0));
      throw refused;
    }
    checkRequest(sent, asked);
    const memo = createHash("sha256")
      .update(`${caller}\u0000${name}\u0000${settings.model}\u0000${text}\u0000${JSON.stringify(asked)}`)
      .digest("hex");
    const again = options.fresh ? null : this.remembered(memo);
    if (again) return again;
    const deadline = Date.now() + (options.deadlineMs ?? DEADLINE_MS);
    const probing = this.probe() === true;
    const round = this.down.round;
    let release = () => {};
    const started = Date.now();
    try {
      release = await this.slot(deadline);
      const reply = await call(settings.dialect, { url: settings.url, model: settings.model, key }, sent, asked, {
        attemptMs: policy.attemptSeconds * 1000,
        retries: policy.retries,
        deadlineMs: Math.max(0, deadline - Date.now()),
        signal: options.signal,
        fetch: this.deps.fetch,
      });
      Object.assign(this.down, { failures: 0, opens: 0, until: 0 });
      const { usd, usdSource } = costOf(reply, settings.usdPerMillionInput, () => tokensOf(sent, asked));
      const read = merged(reply.answers);
      // the log keeps each choice as the room reads it, and the reversed order beside it
      const asks = this.store().record(
        {
          ...logged,
          model: reply.model || null,
          inputTokens: reply.inputTokens,
          outputTokens: reply.outputTokens,
          usd,
          usdSource,
          latencyMs: reply.latencyMs,
          attempts: reply.attempts,
          error: null,
        },
        { ...read.answers, ...read.reversed },
        { hash: stateHash, text },
      );
      const decision: Decision = {
        model: reply.model,
        answers: read.answers,
        asks: Object.fromEntries(Object.entries(asks).filter(([id]) => !id.endsWith(REVERSED))),
        parted: read.parted,
        usd,
        latencyMs: reply.latencyMs,
        attempts: reply.attempts,
        suspect,
        cached: false,
      };
      this.remember(memo, decision);
      return decision;
    } catch (error) {
      if (error instanceof DecisionError) {
        if (error.code === "NO_LOGPROBS") {
          const why = `${name} gives no log probabilities for ${settings.model}, and ${settings.dialect} reads its answers from them: set a model or an endpoint that gives them`;
          this.unfit = { wire: `${settings.url}\0${settings.model}`, why };
          this.deps.log?.(`jev: ${why}`);
        }
        this.failed(error, round, probing);
        this.store().record(failedRow(logged, error, Date.now() - started));
      }
      throw error;
    } finally {
      if (probing) this.down.probing = false;
      release();
    }
  }

  /** Puts forks to the model in one call: for each id its label and probability, sharp at `sharpAt` or more when its two orders agree; a failed call leaves every fork unsure, never thrown. */
  async routes(
    caller: string,
    state: State,
    questions: Record<string, ChoiceQuestion | NoulQuestion>,
    sharpAt: number,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<Record<string, Fork>> {
    const ids = Object.keys(questions);
    const unsure = (why: string): Record<string, Fork> =>
      Object.fromEntries(ids.map((id) => [id, { label: null, probability: 0, sharp: false, askId: null, why }]));
    const off = this.why();
    if (off) return unsure(off);
    let decided: Decision;
    try {
      decided = await this.decide(caller, state, questions, options);
    } catch (error) {
      if (error instanceof DecisionError) return unsure(`${error.code}: ${error.message}`);
      throw error;
    }
    const spoken = decided.suspect ? `the state speaks to the model: ${decided.suspect}` : null;
    return Object.fromEntries(
      ids.map((id) => {
        const { label, probability } = labelOf(decided.answers[id]);
        const why =
          spoken ?? (decided.parted.includes(id) ? "its options listed the other way round chose apart" : null);
        return [
          id,
          { label, probability, sharp: probability >= sharpAt && !why, askId: decided.asks[id] ?? null, why },
        ];
      }),
    );
  }

  /** Why a call may not go out before it is sent: text that is not English; null when it may. */
  private refusal(state: State, questions: Questions): DecisionError | null {
    const foreign = firstNotEnglish({ state, questions });
    return foreign ? new DecisionError("NOT_ENGLISH", `${foreign.path} ${foreign.why}; only English is sent`) : null;
  }

  /** What one caller's questions got since a time: answers, those as sure as `sharpAt`, failed calls. */
  answered(caller: string, sharpAt: number, since: Date): { asked: number; sure: number; failed: number } {
    const store = this.existing();
    if (!store) return { asked: 0, sure: 0, failed: 0 };
    const { answers, failed } = store.answersOf(`${caller}@`, `${caller}@\uffff`, since.toISOString());
    const sure = answers.filter(
      ({ answer, suspect }) => suspect === null && labelOf(JSON.parse(answer) as Answer).probability >= sharpAt,
    ).length;
    return { asked: answers.length, sure, failed };
  }

  /** Today's calls and failed calls per district, for the room's status. */
  today(): { district: string; calls: number; failed: number }[] {
    return this.existing()?.dayOf(this.now().toISOString().slice(0, 10)) ?? [];
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

  /** Closes the log. */
  close(): void {
    this.storeHandle?.close();
    this.storeHandle = null;
  }
}
