import { createHash } from "node:crypto";
import type { ToolStatus, TurnEvent } from "../host";

/** Paseo's timeline items as the room's turn events: the words, the reasoning, the tool calls. */

const OUTPUT_CHARS = 2000;
const TEXT_CHARS = 20_000;
const STATUSES: readonly ToolStatus[] = ["running", "completed", "failed", "canceled"];

const text = (value: unknown, most: number): string => (typeof value === "string" ? value.slice(0, most) : "");
/** The end of an output: where a command says how it went. */
const tail = (value: unknown): string => (typeof value === "string" ? value.slice(-OUTPUT_CHARS) : "");

/** One timeline item as a turn event, a skill call with the skill named in its label; null for what the room does not read. */
export function eventOf(item: unknown, at?: string): TurnEvent | null {
  if (!item || typeof item !== "object") return null;
  const entry = item as Record<string, unknown>;
  const dated = at ? { at } : {};
  if (entry.type === "user_message") return { kind: "prompt", text: text(entry.text, TEXT_CHARS), ...dated };
  if (entry.type === "assistant_message") return { kind: "say", text: text(entry.text, TEXT_CHARS), ...dated };
  if (entry.type === "reasoning") return { kind: "think", text: text(entry.text, TEXT_CHARS), ...dated };
  // Claude, Codex, Pi and OpenCode mark a compaction's start `loading` and its end `completed`: only the end is one
  if (entry.type === "compaction") return entry.status === "loading" ? null : { kind: "compaction", ...dated };
  if (entry.type !== "tool_call") return null;
  const status = STATUSES.includes(entry.status as ToolStatus) ? (entry.status as ToolStatus) : "completed";
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  if (detail.type === "shell")
    return {
      kind: "shell",
      command: text(detail.command, TEXT_CHARS),
      exitCode: typeof detail.exitCode === "number" ? detail.exitCode : null,
      output: tail(detail.output),
      status,
      ...dated,
    };
  if ((detail.type === "edit" || detail.type === "write") && typeof detail.filePath === "string")
    return { kind: "change", path: detail.filePath, status, ...dated };
  if (detail.type === "read" && typeof detail.filePath === "string")
    return { kind: "read", path: detail.filePath, ...dated };
  const label = detail.type === "plain_text" && typeof detail.label === "string" ? text(detail.label, 200) : "";
  return { kind: "tool", name: text(entry.name, 200), ...(label ? { label } : {}), status, ...dated };
}

/** Where the room stopped reading a seat's timeline: how many items it held, and a digest of the last one. */
export interface ReadMark {
  count: number;
  last: string;
}

const digest = (item: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(item) ?? "")
    .digest("hex")
    .slice(0, 16);

/** The items of the turn that just ended out of a seat's whole timeline, and the mark to read the next one from. */
export function sinceMark(
  timeline: readonly unknown[],
  mark: ReadMark | undefined,
): { items: readonly unknown[]; mark: ReadMark } {
  let from = -1;
  // a whole timeline only grows from one turn to the next: one that did not grow is read as the turn alone
  if (mark && timeline.length > mark.count) {
    if (mark.count === 0 || digest(timeline[mark.count - 1]) === mark.last) from = mark.count;
    // the timeline was cut at its start: the last item read is looked for where it is now
    else
      for (let i = timeline.length - 2; i >= 0 && from < 0; i -= 1) if (digest(timeline[i]) === mark.last) from = i + 1;
  }
  // with no mark to read from, a turn starts at its prompt
  if (from < 0)
    from = Math.max(
      0,
      timeline.findLastIndex((item) => (item as { type?: unknown } | null)?.type === "user_message"),
    );
  const last = timeline.length ? digest(timeline[timeline.length - 1]) : "";
  return { items: timeline.slice(from), mark: { count: timeline.length, last } };
}

/** A turn's items as events, in order. */
export function eventsOf(items: readonly unknown[]): TurnEvent[] {
  return items.flatMap((item) => eventOf(item) ?? []);
}

/** The latest turn among dated entries: those of the last turn id, else those since the last prompt. */
export function latestTurn(entries: readonly { item: unknown; timestamp?: string; turnId?: string }[]): TurnEvent[] {
  const lastTurn = entries.findLast((entry) => entry.turnId)?.turnId;
  const from = lastTurn
    ? entries.findIndex((entry) => entry.turnId === lastTurn)
    : Math.max(
        0,
        entries.findLastIndex((entry) => (entry.item as { type?: unknown } | null)?.type === "user_message"),
      );
  return entries.slice(from).flatMap((entry) => eventOf(entry.item, entry.timestamp) ?? []);
}

/** The events of the entries dated `since` or later, across turns; the latest turn's when no entry is dated. */
export function eventsSince(
  entries: readonly { item: unknown; timestamp?: string; turnId?: string }[],
  since: string,
): TurnEvent[] {
  if (!entries.some((entry) => entry.timestamp)) return latestTurn(entries);
  return entries
    .filter((entry) => entry.timestamp !== undefined && entry.timestamp >= since)
    .flatMap((entry) => eventOf(entry.item, entry.timestamp) ?? []);
}
