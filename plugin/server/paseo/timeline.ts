import type { ToolStatus, TurnEvent } from "../host";

/** Paseo's timeline items as the room's turn events: the words, the reasoning, the tool calls. */

const OUTPUT_CHARS = 2000;
const TEXT_CHARS = 20_000;
const STATUSES: readonly ToolStatus[] = ["running", "completed", "failed", "canceled"];

const text = (value: unknown, most: number): string => (typeof value === "string" ? value.slice(0, most) : "");
/** The end of an output is where a command says how it went. */
const tail = (value: unknown): string => (typeof value === "string" ? value.slice(-OUTPUT_CHARS) : "");

/** One timeline item as a turn event; null for what the room does not read. */
export function eventOf(item: unknown, at?: string): TurnEvent | null {
  if (!item || typeof item !== "object") return null;
  const entry = item as Record<string, unknown>;
  const dated = at ? { at } : {};
  if (entry.type === "user_message") return { kind: "prompt", text: text(entry.text, TEXT_CHARS), ...dated };
  if (entry.type === "assistant_message") return { kind: "say", text: text(entry.text, TEXT_CHARS), ...dated };
  if (entry.type === "reasoning") return { kind: "think", text: text(entry.text, TEXT_CHARS), ...dated };
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
  return { kind: "tool", name: text(entry.name, 200), status, ...dated };
}

/** A turn's items as events, in order. */
export function eventsOf(items: readonly unknown[]): TurnEvent[] {
  return items.flatMap((item) => eventOf(item) ?? []);
}

/** The latest turn among dated entries: those of the last turn id, else those since the last prompt. */
export function latestTurn(entries: readonly { item: unknown; timestamp?: string; turnId?: string }[]): TurnEvent[] {
  const lastTurn = entries.findLast((entry) => entry.turnId)?.turnId;
  let from = 0;
  if (lastTurn) from = entries.findIndex((entry) => entry.turnId === lastTurn);
  else
    for (let i = entries.length - 1; i >= 0; i -= 1)
      if ((entries[i].item as { type?: unknown })?.type === "user_message") {
        from = i;
        break;
      }
  return entries.slice(from).flatMap((entry) => eventOf(entry.item, entry.timestamp) ?? []);
}
