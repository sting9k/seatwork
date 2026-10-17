/** A seat's history as Paseo projects it, and a brief written from the room's template. */

let clock = Date.parse("2026-10-11T00:00:00Z");

export const prompt = (text: string, turnId = "turn-1") => ({
  item: { type: "user_message", text },
  turnId,
  timestamp: new Date((clock += 1000)).toISOString(),
});

export const BRIEF = [
  "Project: /work/echo",
  "Outcome: parseDuration accepts hours.",
  "Candidate: extend the regular expression; changeable.",
  "Write scope: src/duration.js, test/**",
  'Contract / invariants: parseDuration("2h") returns 7200000; `npm test` passes',
  "Yours to decide: everything inside the write scope the contract does not name",
  "Constraints: no new dependency; no push",
  "Output: CANDIDATE with the sha and the test output",
  'Acceptance evidence: `npm test` passes; parseDuration("2h") === 7200000',
  "Reopen when: hours need more than the regular expression",
  "Reply with seatwork_mail to: owner",
].join("\n");
