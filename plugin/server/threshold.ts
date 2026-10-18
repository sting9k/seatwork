/** How the room reads a confidence threshold the policy may set. */

/** The policy's threshold when it lies from a half up to certainty, else the default. */
export const thresholdOf = (set: unknown, fallback: number): number =>
  typeof set === "number" && set >= 0.5 && set <= 1 ? set : fallback;
