import { redact } from "../redact";
import { chatReply, chatRequest } from "./chat";
import { DecisionError, type Questions, type Reply, type State } from "./contract";
import { replyOf, requestOf, type Dialect, type Wire, type WireRequest } from "./dialects";

/** One decision call: a deadline, retries on what may pass, the reply read into the room's shape. */

/** How one call goes: time per attempt and in all, retries, the caller's signal, and stand-ins for fetch, sleep and random. */
export interface CallOptions {
  attemptMs: number;
  retries: number;
  deadlineMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  random?: () => number;
}

/** A reply with how long the call took and how many attempts it made. */
export interface CallResult extends Reply {
  latencyMs: number;
  attempts: number;
}

const RETRIED = (status: number) => status === 408 || status === 429 || status >= 500;
const BACKOFF = { firstMs: 500, maxMs: 5000, jitter: 0.25 };
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const CHAT_AT_ONCE = 8;

/** `Retry-After` in seconds or as a date, and OpenRouter's `retry-after-ms`; null when absent. */
function retryAfterMs(headers: Headers, now: number): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** A body read up to `max` bytes: past it a reply is refused, an error body is cut. */
async function readCapped(response: Response, max: number, over: "refuse" | "cut"): Promise<string> {
  const refuse = () => new DecisionError("CONTRACT", `the reply is larger than ${max} bytes`);
  if (over === "refuse" && Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw refuse();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      await reader.cancel();
      if (over === "refuse") throw refuse();
      chunks.push(value.subarray(0, max - size));
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Waits `ms`, or rejects at once when the signal aborts. */
const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(new DecisionError("ABORTED", "the call was cancelled"));
    }
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
  });

/** One attempt, its own timer and its own listener on the caller's signal, both gone when it ends. */
async function attempt(
  send: typeof fetch,
  request: WireRequest,
  limitMs: number,
  caller: AbortSignal | undefined,
): Promise<{ response: Response; text: string } | { failed: "timeout" | "network"; error: unknown }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);
  const cancel = () => controller.abort();
  caller?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await send(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readCapped(
      response,
      response.ok ? MAX_REPLY_BYTES : MAX_ERROR_BYTES,
      response.ok ? "refuse" : "cut",
    );
    return { response, text };
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    if (caller?.aborted) throw new DecisionError("ABORTED", "the call was cancelled");
    return { failed: timedOut ? "timeout" : "network", error };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", cancel);
  }
}

/** Sends one request, retried with backoff on what may pass within the deadline; the reply is read by `read`. */
async function sent(request: WireRequest, read: (json: unknown) => Reply, options: CallOptions): Promise<CallResult> {
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? pause;
  const random = options.random ?? Math.random;
  const caller = options.signal;
  const started = Date.now();
  const deadline = started + options.deadlineMs;
  let last = new DecisionError("TIMEOUT", "no time was left for the call");
  let attempts = 0;
  try {
    for (let tried = 0; tried <= options.retries; tried += 1) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      if (caller?.aborted) throw new DecisionError("ABORTED", "the call was cancelled");
      attempts += 1;
      const done = await attempt(send, request, Math.min(options.attemptMs, left), caller);
      let wait: number | null = null;
      if ("failed" in done) {
        last =
          done.failed === "timeout"
            ? new DecisionError("TIMEOUT", `no reply within ${options.attemptMs} ms`)
            : new DecisionError("NETWORK", redact(String((done.error as Error)?.cause ?? done.error)).slice(0, 300));
      } else if (done.response.ok) {
        let json: unknown;
        try {
          json = JSON.parse(done.text);
        } catch {
          throw new DecisionError("CONTRACT", "the reply is no JSON");
        }
        return { ...read(json), latencyMs: Date.now() - started, attempts };
      } else {
        const status = done.response.status;
        last = new DecisionError(
          "HTTP",
          `HTTP ${status}: ${redact(done.text.replace(/\s+/g, " ").trim()).slice(0, 300)}`,
          status,
        );
        wait = retryAfterMs(done.response.headers, Date.now());
        // OpenRouter's 402 passes only while a spending limit refills, which it says with Retry-After
        if (!RETRIED(status) && !(status === 402 && wait !== null)) throw last;
      }
      if (tried === options.retries) break;
      const backoff = Math.min(BACKOFF.maxMs, BACKOFF.firstMs * 2 ** tried) * (1 - random() * BACKOFF.jitter);
      const delay = Math.max(backoff, wait ?? 0);
      if (Date.now() + delay >= deadline) break;
      await sleep(delay, caller);
    }
    throw last;
  } catch (error) {
    if (error instanceof DecisionError) error.attempts = attempts;
    throw error;
  }
}

/** One decision: one request on most wires, one request a question on Chat Completions, a few at a time; any that fails fails the decision. */
export async function call(
  dialect: Dialect,
  wire: Wire,
  state: State,
  questions: Questions,
  options: CallOptions,
): Promise<CallResult> {
  if (dialect !== "openai-chat")
    return sent(requestOf(dialect, wire, state, questions), (json) => replyOf(dialect, questions, json), options);
  const started = Date.now();
  const stop = new AbortController();
  const cancel = () => stop.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const asked = Object.entries(questions);
  const parts: CallResult[] = [];
  try {
    for (let at = 0; at < asked.length; at += CHAT_AT_ONCE)
      parts.push(
        ...(await Promise.all(
          asked.slice(at, at + CHAT_AT_ONCE).map(([id, question]) =>
            sent(chatRequest(wire, state, id, question), (json) => chatReply(id, question, json), {
              ...options,
              signal: stop.signal,
            }).catch((error: unknown) => {
              stop.abort();
              throw error;
            }),
          ),
        )),
      );
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
  return {
    model: parts[0]?.model ?? wire.model,
    answers: Object.assign({}, ...parts.map((part) => part.answers)),
    inputTokens: parts.reduce((sum, part) => sum + part.inputTokens, 0),
    outputTokens: parts.reduce((sum, part) => sum + part.outputTokens, 0),
    costUsd: null,
    latencyMs: Date.now() - started,
    attempts: parts.reduce((sum, part) => sum + part.attempts, 0),
  };
}
