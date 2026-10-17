import table from "../../shared/tools.json";
import type { McpTool } from "../mcp-http";
import { inRoom, owns } from "../../shared/workflow";
import { refusal } from "../refusal";

/** The room's own MCP tools, written once in shared/tools.json. */

interface ToolRow {
  callers: "any" | "spawners" | "room";
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS = table.tools as Record<string, ToolRow | undefined>;
export const TOOL_NAMES: readonly string[] = Object.keys(table.tools);

function fill(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)]));
  return value;
}

/** A tool as a seat is shown it, its `{{placeholders}}` filled from `vars`; `TOOL_NAMES` is the order a seat is shown them. */
export function roomTool(name: string, vars: Record<string, string>): McpTool {
  const row = TOOLS[name];
  if (!row) throw new Error(`seatwork: shared/tools.json defines no tool ${name}`);
  const shown = fill({ description: row.description, inputSchema: row.inputSchema }, vars) as Omit<McpTool, "name">;
  return { name, ...shown };
}

/** Why a seat of this role may not call a tool; null when it may. */
export function refusedCaller(name: string, role: string | undefined): string | null {
  const callers = TOOLS[name]?.callers;
  if (callers === "any" || (callers === "spawners" && owns(role)) || (callers === "room" && inRoom(role))) return null;
  return callers === "room"
    ? `it belongs to the seats at home in the room, and a ${role} seat is not one`
    : `a ${role} seat creates no seats, so none is under it`;
}

/** The value of `choices` a word most likely meant: the same in other case, else the only one within a few edits or starting with it. */
function nearest(word: string, choices: readonly string[]): string | null {
  const lower = word.toLowerCase();
  const same = choices.find((choice) => choice.toLowerCase() === lower);
  if (same) return same;
  const distance = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= b.length; j += 1)
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  const close = choices.filter(
    (choice) => distance(lower, choice.toLowerCase()) <= Math.max(1, Math.floor(choice.length / 3)),
  );
  if (close.length === 1) return close[0];
  const started = choices.filter((choice) => lower.length >= 2 && choice.toLowerCase().startsWith(lower));
  return started.length === 1 ? started[0] : null;
}

/** A call whose argument lies outside an enum of its tool's schema, refused with the value it most likely meant; null when every one is in its enum. */
export function enumRefusal(name: string, args: Record<string, unknown>): string | null {
  const properties = (TOOLS[name]?.inputSchema.properties ?? {}) as Record<
    string,
    { enum?: string[]; items?: { enum?: string[] } }
  >;
  for (const [key, schema] of Object.entries(properties)) {
    const allowed = schema.enum ?? schema.items?.enum;
    const value = args[key];
    if (!allowed || value === undefined || value === null) continue;
    const wrong = (Array.isArray(value) ? value : [value]).find((one) => !allowed.includes(one as string));
    if (wrong === undefined) continue;
    const meant = typeof wrong === "string" ? nearest(wrong, allowed) : null;
    return refusal({
      code: "INVALID_ARGUMENT",
      message: `\`${key}\` is one of ${allowed.join(", ")}; ${JSON.stringify(wrong)} is none of them`,
      retryable: false,
      ...(meant
        ? { fix: { [key]: Array.isArray(value) ? value.map((one) => (one === wrong ? meant : one)) : meant } }
        : {}),
    });
  }
  return null;
}
