import {
  checkAnswers,
  isRecord,
  DecisionError,
  type Answer,
  type Question,
  type Questions,
  type Reply,
  type State,
} from "./contract";

/** How each provider's wire is spoken: the request it takes and the reply it gives. */

/** The wires providers speak: System One, OpenRouter's route to it, and OpenAI's Decisions. */
export type Dialect = "systemone" | "openrouter" | "openai-decisions";
export const DIALECTS: readonly Dialect[] = ["systemone", "openrouter", "openai-decisions"];

/** Where a provider is and how to reach it. */
export interface Wire {
  url: string;
  model: string;
  key?: string;
}

export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** OpenAI's Decisions take one instruction string: a noul's criteria join it as plain lines. */
function openAiQuestion(id: string, question: Question): Record<string, unknown> {
  const instructions = asText(question.instructions);
  if (question.type === "noul") {
    const { true: yes, false: no } = question.criteria ?? {};
    const lines = [instructions, ...(yes ? [`Yes means: ${yes}`] : []), ...(no ? [`No means: ${no}`] : [])];
    return { type: "predicate", name: id, instructions: lines.join("\n") };
  }
  if (question.type === "choice") {
    const choices = Object.entries(question.criteria).map(([value, description]) => ({
      value,
      description: description ?? "",
    }));
    if (choices.length < 2) throw new DecisionError("INVALID", `${id}: OpenAI's Decisions need 2 labels or more`);
    return { type: "choice", name: id, instructions, choices };
  }
  return { type: "score", name: id, instructions, levels: question.criteria.map((label) => ({ label })) };
}

/** OpenAI's answer list, keyed by name, in the room's shape before it is checked. */
function fromOpenAi(answers: unknown): Record<string, unknown> {
  if (!Array.isArray(answers)) throw new DecisionError("CONTRACT", "the reply holds no answer list");
  const out: Record<string, unknown> = {};
  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.name !== "string") continue;
    const listed = Array.isArray(answer.probabilities) ? answer.probabilities.filter(isRecord) : [];
    if (answer.type === "predicate") out[answer.name] = { type: "noul", noul: answer.probability };
    else if (answer.type === "choice")
      out[answer.name] = {
        type: "choice",
        choice: String(answer.choice),
        probabilities: Object.fromEntries(listed.map((p) => [String(p.value), p.probability])),
        confidence: answer.confidence,
      };
    else if (answer.type === "score")
      out[answer.name] = {
        type: "score",
        score: answer.score,
        legend: Object.fromEntries(listed.map((p) => [String(p.value), p.label])),
        probabilities: Object.fromEntries(listed.map((p) => [String(p.value), p.probability])),
        confidence: answer.confidence,
      };
  }
  return out;
}

/** The request a provider's wire takes for a state and its questions. */
export function requestOf(dialect: Dialect, wire: Wire, state: State, questions: Questions): WireRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (wire.key) headers.Authorization = `Bearer ${wire.key}`;
  const body =
    dialect === "openai-decisions"
      ? {
          model: wire.model,
          input: asText(state),
          questions: Object.entries(questions).map(([id, question]) => openAiQuestion(id, question)),
        }
      : {
          model: wire.model,
          state,
          questions,
          // OpenRouter routes only to an endpoint that keeps no prompt and collects no data
          ...(dialect === "openrouter" ? { provider: { zdr: true, data_collection: "deny" } } : {}),
        };
  return { url: wire.url, headers, body: JSON.stringify(body) };
}

/** A provider's JSON reply, checked against the questions asked. */
export function replyOf(dialect: Dialect, questions: Questions, json: unknown): Reply {
  if (!isRecord(json)) throw new DecisionError("CONTRACT", "the reply is no JSON object");
  const usage = isRecord(json.usage) ? json.usage : {};
  const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0);
  const cost = usage.cost;
  const answers: Record<string, Answer> = checkAnswers(
    questions,
    dialect === "openai-decisions" ? fromOpenAi(json.answers) : json.answers,
  );
  return {
    model: typeof json.model === "string" ? json.model : "",
    answers,
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}
