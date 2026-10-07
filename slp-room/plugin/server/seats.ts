import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR, SEATS_FILE } from "./paths";
import { loadModels, promptVars, render } from "./models";
import type { RoomParams } from "./policy";

export const HARNESSES = ["claude", "codex", "pi", "opencode"] as const;
export const ROLES = ["hq", "supervisor", "lead", "peer", "lens"] as const;

export type Harness = (typeof HARNESSES)[number];
export type Role = (typeof ROLES)[number];

export interface Seat {
  provider: string;
  harness: Harness;
  role: Role;
}

/**
 * A seat is a Paseo provider named `<harness>-<role>`, e.g. `claude-lead` or
 * `codex-peer`. Any other provider id is not a room seat and is left alone.
 */
export function parseSeat(provider: string | undefined): Seat | null {
  if (!provider) return null;
  const dash = provider.indexOf("-");
  if (dash <= 0) return null;
  const harness = provider.slice(0, dash);
  const role = provider.slice(dash + 1);
  if (!(HARNESSES as readonly string[]).includes(harness)) return null;
  if (!(ROLES as readonly string[]).includes(role)) return null;
  return { provider, harness: harness as Harness, role: role as Role };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The seats paseo/seats.yml enables, read from the seats.json that install.sh generates. */
export function enabledSeats(): Seat[] {
  if (!existsSync(SEATS_FILE)) throw new Error(`slp-seat: ${SEATS_FILE} not found; run install.sh`);
  const parsed = JSON.parse(readFileSync(SEATS_FILE, "utf8")) as { providers?: string[] };
  return (parsed.providers ?? []).map(parseSeat).filter((s): s is Seat => s !== null);
}

/** `harness/<harness>.md`: how this harness exposes the room's tools (tool names, tool search, what is denied). */
export function harnessSheet(harness: Harness | undefined): string | null {
  if (!harness) return null;
  return readIfExists(join(ROOM_DIR, "harness", `${harness}.md`));
}

/** `specs/<name>.md`, when the seat asked for a specialization. */
export function specSheet(name: string | undefined): string | null {
  if (!name || !/^[a-z0-9-]+$/.test(name)) return null;
  return readIfExists(join(ROOM_DIR, "specs", `${name}.md`));
}

/** `[Peer:research] task` → "research"; otherwise undefined. */
export function specFromTitle(title: string | null | undefined): string | undefined {
  const m = /^\s*\[(?:peer|lead|supervisor|hq):([a-z0-9-]+)\]/i.exec(title ?? "");
  return m?.[1]?.toLowerCase();
}

export interface PromptContext {
  harness?: Harness;
  spec?: string;
  /** Knobs quoted by the prompts; with models.json they fill the {{placeholders}}. */
  params: RoomParams;
}

/**
 * The system prompt every seat receives: the role file (self-contained: a seat
 * learns nothing about what sits above its "Owner"), the optional
 * specialization sheet, and the harness sheet. Read on every
 * call so edits to the room files apply to the next agent without a reload.
 */
export function rolePrompt(role: Role, context: PromptContext): string {
  const roleText = readIfExists(join(ROOM_DIR, "roles", `${role}.md`));
  if (!roleText) {
    throw new Error(`slp-seat: missing role prompt ${join(ROOM_DIR, "roles", `${role}.md`)} (run install.sh)`);
  }
  const spec = specSheet(context.spec);
  const sheet = harnessSheet(context.harness);
  const vars = promptVars(loadModels(), context.params);
  const missing: string[] = [];
  const rendered = render(roleText.trim(), vars, (name) => missing.push(name));
  if (missing.length) console.error(`slp-seat: roles/${role}.md uses unknown placeholders: ${missing.join(", ")}`);
  const needsRoomDir = role === "hq" || role === "supervisor"; // the law template and projects.json live there
  const parts = [
    `# Seat: ${role}${context.spec ? ` (specialization: ${context.spec})` : ""}`,
    `This session is a ${role} seat in a Paseo room.${needsRoomDir ? ` ROOM_DIR=${ROOM_DIR}.` : ""} Role skills live in your skills directory: use them for the procedures they name.`,
    rendered,
    spec ? `\n---\n\n${spec.trim()}` : null,
    sheet ? `\n---\n\n${sheet.trim()}` : null,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}
