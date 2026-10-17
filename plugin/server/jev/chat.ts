import { isObject } from "../../shared/json";
import { checkAnswers, DecisionError, type Question, type Reply, type State } from "./contract";
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
  if (!isObject(json) || !Array.isArray(json.choices))
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
    if (!isObject(one) || typeof one.token !== "string" || typeof one.logprob !== "number") continue;
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
  const usage = isObject(json.usage) ? json.usage : {};
  const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);
  return {
    model: typeof json.model === "string" ? json.model : "",
    answers: checkAnswers({ [id]: question }, { [id]: raw }),
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    costUsd: null,
  };
}
