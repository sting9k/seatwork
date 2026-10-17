import type { SeatUsage } from "../host";

/** A compaction read from a seat's reported context, for when its timeline did not show it. */

const FALL = { tokens: 20_000, share: 0.5 } as const;

/** Whether a seat's reported context fell by half or more, and by 20,000 tokens or more, between two turns: a compaction. */
export function contextFell(before: SeatUsage | undefined, after: SeatUsage): boolean {
  const [was, now] = [before?.contextWindowUsedTokens, after.contextWindowUsedTokens];
  if (typeof was !== "number" || typeof now !== "number" || !Number.isFinite(was) || !Number.isFinite(now))
    return false;
  return was - now >= FALL.tokens && now <= was * FALL.share;
}
