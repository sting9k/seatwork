/** Long texts cut for the decision model: the head and the tail kept, the cut said where it was made. */

const HEAD_SHARE = 0.4;

/** `text` within `most` characters: two fifths from its head, the rest from its tail, and how much was cut between them. */
export function excerpt(text: string, most: number): string {
  if (text.length <= most) return text;
  const head = Math.floor(most * HEAD_SHARE);
  const tail = most - head;
  return `${text.slice(0, head)} … (${text.length - most} characters cut) … ${text.slice(text.length - tail)}`;
}

/** The head of a text, `most` characters and an ellipsis when it is longer. */
export function clip(text: string, most: number): string {
  return text.length > most ? `${text.slice(0, most)}…` : text;
}
