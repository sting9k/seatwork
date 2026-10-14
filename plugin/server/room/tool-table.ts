import table from "../../shared/tools.json";
import type { McpTool } from "../mcp-http";
import { inRoom, owns } from "../../shared/workflow";

/** The room's own MCP tools, written once in shared/tools.json for plugin and evals. */

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
