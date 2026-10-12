import type { TimelineInput } from "../../server/watch/events";

/** Timeline entries as Paseo projects them, for tests that feed the watcher a turn. */

let clock = Date.parse("2026-10-11T00:00:00Z");
// an entry's timestamp is the end of its call: `took` is how long the call lasted
const entry = (item: object, turnId = "turn-1", took = 1): TimelineInput => ({
  item,
  turnId,
  timestamp: new Date((clock += took * 1000)).toISOString(),
});

export const prompt = (text: string, turnId?: string) => entry({ type: "user_message", text }, turnId);
export const say = (text: string, turnId?: string) => entry({ type: "assistant_message", text }, turnId);
export const edit = (filePath: string, turnId?: string) =>
  entry({ type: "tool_call", name: "Edit", status: "completed", detail: { type: "edit", filePath } }, turnId);
export const read = (filePath: string, turnId?: string) =>
  entry({ type: "tool_call", name: "Read", status: "completed", detail: { type: "read", filePath } }, turnId);

export function bash(
  command: string,
  result: { fails?: boolean; running?: boolean; output?: string; exitCode?: number; took?: number } = {},
  turnId?: string,
): TimelineInput {
  const status = result.running ? "running" : result.fails ? "failed" : "completed";
  return entry(
    {
      type: "tool_call",
      name: "Bash",
      status,
      detail: {
        type: "shell",
        command,
        output: result.output ?? "",
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      },
    },
    turnId,
    result.took,
  );
}

/** A failed call as Claude reports it: nothing in the detail, the exit code and the output beside it. */
export const claudeFailure = (command: string, content: string) =>
  entry({
    type: "tool_call",
    name: "Bash",
    status: "failed",
    detail: { type: "shell", command },
    error: { type: "tool_result", content, is_error: true },
  });

/** A command Claude sent to the background, and the harness's later word on how it ended. */
export const background = (command: string, callId: string) =>
  entry({
    type: "tool_call",
    name: "Bash",
    callId,
    status: "completed",
    detail: {
      type: "shell",
      command,
      output: `Command running in background with ID: ${callId}. Output is being written to: /tmp/${callId}.output`,
    },
  });
export const ended = (callId: string, exitCode: number) =>
  entry({
    type: "tool_call",
    name: "task_notification",
    status: exitCode === 0 ? "completed" : "failed",
    detail: {
      type: "plain_text",
      text:
        exitCode === 0
          ? "Background command completed (exit code 0)"
          : `Background command failed with exit code ${exitCode}`,
    },
    metadata: {
      synthetic: true,
      source: "claude_task_notification",
      toolUseId: callId,
      status: exitCode === 0 ? "completed" : "failed",
    },
  });

export const mail = (subject: string, turnId?: string) =>
  entry(
    {
      type: "tool_call",
      name: "mcp__seatwork__seatwork_mail",
      status: "completed",
      detail: { type: "unknown", input: { to: "owner", subject, body: "…" }, output: "sent" },
    },
    turnId,
  );

/** A mail as the room delivers it to a seat. */
export const letter = (id: string, subject: string, body: string, from = "owner") =>
  [
    `SEATWORK MAIL #${id} ACTION from ${from} re: ${subject}`,
    "why now: owner is waiting for your answer to continue",
    "needs: reply",
    "--- body ---",
    body,
    "--- how to handle ---",
    "ACTION — handle it in this turn.",
  ].join("\n");

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
