import table from "../shared/tools.json";
import type { McpTool } from "./mcp-http";

/** The room's own MCP tools, written once in shared/tools.json for plugin and evals. */

interface ToolRow {
  callers: "any" | "spawners" | string[];
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS = table.tools as Record<string, ToolRow | undefined>;

function fill(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole);
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)]));
  return value;
}

/** A tool as a seat is shown it, its `{{placeholders}}` filled from `vars`. */
export function roomTool(name: string, vars: Record<string, string>): McpTool {
  const row = TOOLS[name];
  if (!row) throw new Error(`seatwork: shared/tools.json defines no tool ${name}`);
  const shown = fill({ description: row.description, inputSchema: row.inputSchema }, vars) as Omit<McpTool, "name">;
  return { name, ...shown };
}

/** Whether a tool that lists its callers lists this role. */
export function namesCaller(name: string, role: string | undefined): boolean {
  const callers = TOOLS[name]?.callers;
  return Array.isArray(callers) && role !== undefined && callers.includes(role);
}
