import { checkAnswers, DecisionError, isRecord, type Question, type Reply, type State } from "./contract";
import { asText, postTo, type Wire, type WireRequest } from "./dialects";

/** Chat Completions as a decision wire: each question is one call asked for a single token, its answer read from the log probabilities of that token. */

const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const TOP_TOKENS = 20;
const FLOOR = 1e-6;
const LEAST_COVERAGE = 0.5;

/** What a question may be answered with: each token's key in the answer, and the lines that show the model what each means. */
interface Answers {
  tokens: Map<string, string>;
  keys: string[];
  lines: string[];
}

/** The one-token answers of a question: yes or no, a letter for each label, a digit for each level. */
function answersOf(id: string, question: Question): Answers {
  if (question.type === "noul") {
    const { true: yes, false: no } = question.criteria ?? {};
    return {
      tokens: new Map([
        ["yes", "true"],
        ["y", "true"],
        ["no", "false"],
        ["n", "false"],
      ]),
      keys: ["true", "false"],
      lines: [`yes: ${yes ?? "it holds"}`, `no: ${no ?? "it does not hold"}`],
    };
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    if (labels.length > CODES.length)
      throw new DecisionError("INVALID", `${id}: openai-chat asks at most ${CODES.length} labels in one call`);
    return {
      tokens: new Map(labels.map((label, at) => [CODES[at].toLowerCase(), label])),
      keys: labels,
      lines: labels.map((label, at) => {
        const meaning = question.criteria[label];
        return `${CODES[at]}: ${label}${meaning ? ` (${asText(meaning)})` : ""}`;
      }),
    };
  }
  const levels = question.criteria;
  if (levels.length > DIGITS.length)
    throw new DecisionError("INVALID", `${id}: openai-chat asks at most ${DIGITS.length} levels`);
  return {
    tokens: new Map(levels.map((_, at) => [DIGITS[at], String(at)])),
    keys: levels.map((_, at) => String(at)),
    lines: levels.map((level, at) => `${DIGITS[at]}: ${level}`),
  };
}

/** The request for one question: the state, the question and its answers, one token back with its most likely others. */
export function chatRequest(wire: Wire, state: State, id: string, question: Question): WireRequest {
  const { lines } = answersOf(id, question);
  const shown = lines.map((line) => line.split(":")[0]);
  return postTo(wire, {
    model: wire.model,
    messages: [
      {
        role: "system",
        content: "Read the state and answer the question with exactly one of the answers listed. Write nothing else.",
      },
      {
        role: "user",
        content: [
          "State:",
          asText(state),
          "",
          `Question: ${asText(question.instructions)}`,
          ...lines,
          `Answer with one of: ${shown.join(", ")}.`,
        ].join("\n"),
      },
    ],
    temperature: 0,
    max_tokens: 1,
    logprobs: true,
    top_logprobs: TOP_TOKENS,
  });
}

/** The answer to one question from its reply: the weight of each answer's token variants, a floor for those not seen, made to sum to one. */
export function chatReply(id: string, question: Question, json: unknown): Reply {
  if (!isRecord(json) || !Array.isArray(json.choices))
    throw new DecisionError("CONTRACT", `${id}: the reply is no chat completion`);
  const first = (json.choices[0] as { logprobs?: { content?: { top_logprobs?: unknown }[] } } | undefined)?.logprobs
    ?.content?.[0]?.top_logprobs;
  if (!Array.isArray(first) || first.length === 0)
    throw new DecisionError(
      "NO_LOGPROBS",
      `${id}: the reply holds no log probabilities; openai-chat needs an endpoint that gives them`,
    );
  const { tokens, keys } = answersOf(id, question);
  const weight = new Map(keys.map((key) => [key, 0]));
  for (const one of first) {
    if (!isRecord(one) || typeof one.token !== "string" || typeof one.logprob !== "number") continue;
    const key = tokens.get(
      one.token
        .trim()
        .replace(/^\W+|\W+$/g, "")
        .toLowerCase(),
    );
    if (key !== undefined) weight.set(key, weight.get(key)! + Math.exp(one.logprob));
  }
  const coverage = [...weight.values()].reduce((sum, value) => sum + value, 0);
  if (coverage < LEAST_COVERAGE)
    throw new DecisionError(
      "CONTRACT",
      `${id}: the model put ${coverage.toFixed(2)} of its weight on the answers asked`,
    );
  const total = coverage + FLOOR * keys.length;
  const probabilities = Object.fromEntries(keys.map((key) => [key, (weight.get(key)! + FLOOR) / total]));
  const confidence = Math.max(...Object.values(probabilities));
  const raw =
    question.type === "noul"
      ? { type: "noul", noul: probabilities.true }
      : question.type === "choice"
        ? { type: "choice", choice: keys.find((key) => probabilities[key] === confidence), probabilities, confidence }
        : {
            type: "score",
            score: keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0),
            legend: Object.fromEntries(question.criteria.map((level, at) => [String(at), level])),
            probabilities,
            confidence,
          };
  const usage = isRecord(json.usage) ? json.usage : {};
  const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);
  return {
    model: typeof json.model === "string" ? json.model : "",
    answers: checkAnswers({ [id]: question }, { [id]: raw }),
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    costUsd: null,
  };
}

/** What a Chat Completions endpoint gives the decision wire: whether it fits, how many likely tokens it shows, their summed weight, and how long a call takes. */
export interface ChatProbe {
  fits: boolean;
  topLogprobs: number | null;
  weight: number | null;
  latencyMs: number;
  notes: string[];
}

const PROBES = {
  sharp: "Answer with one word, yes or no: is water wet?",
  even: "Answer with one word, yes or no: is a hot dog a sandwich?",
};

/** Asks an endpoint two one-token questions, the most likely tokens first at 20, then at 5: what the wire needs of it, measured. */
export async function probeChat(wire: Wire, send: typeof fetch = fetch): Promise<ChatProbe> {
  const notes: string[] = [];
  const ask = async (content: string, top: number) => {
    const request = postTo(wire, {
      model: wire.model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 1,
      logprobs: true,
      top_logprobs: top,
    });
    const started = Date.now();
    const response = await send(request.url, { method: "POST", headers: request.headers, body: request.body });
    const text = await response.text();
    const latencyMs = Date.now() - started;
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // the status and the text say what went wrong
    }
    const shown = (json as { choices?: { logprobs?: { content?: { top_logprobs?: { logprob?: unknown }[] }[] } }[] })
      ?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
    const logprobs = Array.isArray(shown)
      ? shown.map((one) => one?.logprob).filter((lp) => typeof lp === "number")
      : [];
    return { status: response.status, text: asText(text).slice(0, 200), latencyMs, logprobs: logprobs as number[] };
  };
  let sharp = await ask(PROBES.sharp, TOP_TOKENS);
  if (sharp.status === 400) sharp = await ask(PROBES.sharp, 5);
  const none = { fits: false, topLogprobs: null, weight: null, latencyMs: sharp.latencyMs };
  if (sharp.status !== 200) return { ...none, notes: [`HTTP ${sharp.status}: ${sharp.text}`] };
  if (sharp.logprobs.length < 2)
    return { ...none, notes: ["the endpoint answers without the log probabilities of the tokens it might have given"] };
  const weight = sharp.logprobs.reduce((sum, lp) => sum + Math.exp(lp), 0);
  const fits = weight <= 1.05 && sharp.logprobs.every((lp) => lp <= 0);
  if (!fits) notes.push(`the values shown sum to ${weight.toFixed(2)}: they are no log probabilities`);
  if (sharp.logprobs.length < TOP_TOKENS)
    notes.push(`it shows ${sharp.logprobs.length} likely tokens; a choice of more labels than that loses weight`);
  const even = await ask(PROBES.even, sharp.logprobs.length);
  if (
    even.status === 200 &&
    Math.exp(Math.max(...even.logprobs)) >= 0.999 &&
    Math.exp(Math.max(...sharp.logprobs)) >= 0.999
  )
    notes.push("it is all but certain of an open question too: its answers may carry little");
  return { fits, topLogprobs: sharp.logprobs.length, weight, latencyMs: sharp.latencyMs, notes };
}
