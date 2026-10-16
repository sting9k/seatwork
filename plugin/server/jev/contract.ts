/** The decision contract: typed questions about a state, typed answers with probabilities. */

export type State = string | Record<string, unknown> | unknown[];
export type Instructions = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  criteria: string[];
}

/** A question about a state: a `noul` (the probability of yes), a `choice` among labels, or a `score` on a scale. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

/** The answer to a question, of the same type, with the probabilities the provider gave. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** A provider's reply read into the room's shape; `costUsd` is null when the provider names no cost. */
export interface Reply {
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Why a decision was not made. */
export type DecisionFailure =
  | "OFF"
  | "NO_KEY"
  | "CAP"
  | "NOT_ENGLISH"
  | "INVALID"
  | "TOO_LARGE"
  | "CONTRACT"
  | "NO_LOGPROBS"
  | "HTTP"
  | "TIMEOUT"
  | "NETWORK"
  | "ABORTED"
  | "DOWN"
  | "BUSY";

/** A decision that was not made: `code` says why, `attempts` how many tries were made, `status` the HTTP status if any. */
export class DecisionError extends Error {
  attempts = 0;

  constructor(
    readonly code: DecisionFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const LIMITS = { questions: 64, idChars: 100, labels: 255, levels: [2, 10], tokens: 32_000 } as const;
const SUM_TOLERANCE = 0.025;

/** A rough count, four characters a token, of what a request puts before the model. */
export const tokensOf = (state: State, questions: Questions): number =>
  Math.ceil(JSON.stringify({ state, questions }).length / 4);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Refuses what no provider would answer: no questions, an unknown type, labels or levels out of range, too much. */
export function checkRequest(state: State, questions: Questions): void {
  const invalid = (message: string) => new DecisionError("INVALID", message);
  const ids = Object.keys(questions);
  if (ids.length === 0 || ids.length > LIMITS.questions)
    throw invalid(`a request asks 1 to ${LIMITS.questions} questions, not ${ids.length}`);
  for (const id of ids) {
    const question = questions[id];
    if (!id.trim() || id.length > LIMITS.idChars) throw invalid(`question id "${id}" is empty or too long`);
    const instructions = question.instructions;
    if (typeof instructions === "string" ? !instructions.trim() : typeof instructions !== "object" || !instructions)
      throw invalid(`${id}: instructions are empty`);
    if (question.type === "noul") {
      const criteria = question.criteria;
      if (
        criteria !== undefined &&
        (!isRecord(criteria) || Object.keys(criteria).some((k) => k !== "true" && k !== "false"))
      )
        throw invalid(`${id}: a noul's criteria name only true and false`);
    } else if (question.type === "choice") {
      const labels = isRecord(question.criteria) ? Object.keys(question.criteria) : [];
      if (labels.length === 0 || labels.length > LIMITS.labels)
        throw invalid(`${id}: a choice has 1 to ${LIMITS.labels} labels, not ${labels.length}`);
      if (labels.some((label) => !label.trim())) throw invalid(`${id}: a choice label is empty`);
    } else if (question.type === "score") {
      const [least, most] = LIMITS.levels;
      const levels = question.criteria;
      if (!Array.isArray(levels) || levels.length < least || levels.length > most)
        throw invalid(`${id}: a score has ${least} to ${most} levels`);
      if (levels.some((level) => typeof level !== "string" || !level.trim()))
        throw invalid(`${id}: a score level is empty`);
    } else throw invalid(`${id}: unknown question type ${(question as { type?: unknown }).type}`);
  }
  const tokens = tokensOf(state, questions);
  if (tokens > LIMITS.tokens)
    throw new DecisionError(
      "TOO_LARGE",
      `the state and questions come to about ${tokens} tokens; ${LIMITS.tokens} at most`,
    );
}

/** Reads a distribution: every expected key, each a probability, summing to one. */
function distribution(id: string, raw: unknown, keys: readonly string[]): Record<string, number> {
  if (!isRecord(raw)) throw new DecisionError("CONTRACT", `${id}: no probabilities`);
  const extra = Object.keys(raw).find((key) => !keys.includes(key));
  if (extra !== undefined)
    throw new DecisionError("CONTRACT", `${id}: a probability for "${extra}", which was not asked`);
  const out: Record<string, number> = {};
  for (const key of keys) {
    if (!isProbability(raw[key])) throw new DecisionError("CONTRACT", `${id}: no probability for "${key}"`);
    out[key] = raw[key];
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) throw new DecisionError("CONTRACT", `${id}: probabilities sum to ${sum}`);
  return out;
}

/** Holds a provider's answers to the questions asked; anything off is a contract error. */
export function checkAnswers(questions: Questions, raw: unknown): Record<string, Answer> {
  if (!isRecord(raw)) throw new DecisionError("CONTRACT", "the reply holds no answers");
  const out: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = raw[id];
    if (!isRecord(answer) || answer.type !== question.type)
      throw new DecisionError("CONTRACT", `${id}: no ${question.type} answer`);
    const confidence = () => {
      if (!isProbability(answer.confidence)) throw new DecisionError("CONTRACT", `${id}: no confidence`);
      return answer.confidence;
    };
    if (question.type === "noul") {
      if (!isProbability(answer.noul)) throw new DecisionError("CONTRACT", `${id}: noul is no probability`);
      out[id] = { type: "noul", noul: answer.noul };
    } else if (question.type === "choice") {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== "string" || !labels.includes(answer.choice))
        throw new DecisionError("CONTRACT", `${id}: the choice is not one of the labels asked`);
      out[id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: distribution(id, answer.probabilities, labels),
        confidence: confidence(),
      };
    } else {
      const keys = question.criteria.map((_, index) => String(index));
      const score = answer.score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > keys.length - 1)
        throw new DecisionError("CONTRACT", `${id}: the score is outside the scale`);
      const legend = answer.legend;
      if (!isRecord(legend) || keys.some((key) => typeof legend[key] !== "string"))
        throw new DecisionError("CONTRACT", `${id}: the legend does not name every level`);
      out[id] = {
        type: "score",
        score,
        legend: Object.fromEntries(keys.map((key) => [key, legend[key] as string])),
        probabilities: distribution(id, answer.probabilities, keys),
        confidence: confidence(),
      };
    }
  }
  return out;
}
