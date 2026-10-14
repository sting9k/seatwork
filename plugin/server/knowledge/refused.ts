/** A seat's call to the knowledge tool that cannot be done as asked; it reaches the seat as a refusal it can fix. */
export class KnowledgeRefused extends Error {
  readonly code = "BAD_REQUEST";
  readonly retryable = false;
}
