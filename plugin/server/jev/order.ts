import type { Answer, ChoiceAnswer, ChoiceQuestion, Questions } from "./contract";

/** Each choice asked in both orders of its options in one request: the model leans to the option listed first, and the mean of the two orders cancels that lean. */

export const REVERSED = "~r";

/** The questions with a copy of each choice of two options or more, its options listed the other way round; none are added when the copies would pass `most` questions. */
export function withReversed(questions: Questions, most: number): Questions {
  const choices = Object.entries(questions).filter(
    (entry): entry is [string, ChoiceQuestion] =>
      entry[1].type === "choice" && Object.keys(entry[1].criteria).length > 1,
  );
  if (choices.length === 0 || Object.keys(questions).length + choices.length > most) return questions;
  return {
    ...questions,
    ...Object.fromEntries(
      choices.map(([id, question]) => [
        `${id}${REVERSED}`,
        { ...question, criteria: Object.fromEntries(Object.entries(question.criteria).reverse()) },
      ]),
    ),
  };
}

/** One choice read from its two orders: each option's probability the mean of the two, and its confidence as the provider reckons it from them; two orders that agree to the last digit give the first as it came. */
function mean(first: ChoiceAnswer, second: ChoiceAnswer): ChoiceAnswer {
  const labels = Object.keys(first.probabilities);
  if (labels.every((label) => first.probabilities[label] === second.probabilities[label])) return first;
  const probabilities = Object.fromEntries(
    labels.map((label) => [label, (first.probabilities[label] + (second.probabilities[label] ?? 0)) / 2]),
  );
  const top = Math.max(...Object.values(probabilities));
  const choice =
    probabilities[first.choice] === top ? first.choice : labels.find((label) => probabilities[label] === top)!;
  const n = labels.length;
  return { type: "choice", choice, probabilities, confidence: Math.min(1, Math.max(0, (n * top - 1) / (n - 1))) };
}

/** The answers as the caller asked them, each choice the mean of its two orders; `parted` names the choices whose two orders chose apart, `reversed` keeps the answers to the copies. */
export function merged(answers: Record<string, Answer>): {
  answers: Record<string, Answer>;
  parted: string[];
  reversed: Record<string, Answer>;
} {
  const out: Record<string, Answer> = {};
  const reversed: Record<string, Answer> = {};
  const parted: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (id.endsWith(REVERSED)) {
      reversed[id] = answer;
      continue;
    }
    const other = answers[`${id}${REVERSED}`];
    if (answer.type !== "choice" || other?.type !== "choice") {
      out[id] = answer;
      continue;
    }
    out[id] = mean(answer, other);
    if (answer.choice !== other.choice) parted.push(id);
  }
  return { answers: out, parted, reversed };
}
