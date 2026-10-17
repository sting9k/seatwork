/** Whether a value is a plain JSON object: not null, not an array. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
