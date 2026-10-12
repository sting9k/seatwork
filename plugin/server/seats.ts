import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR, ROOM_HOME, SEATS_FILE } from "./paths";
import { loadModels, promptVars, render, type Models } from "./models";
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

/** A seat is a Paseo provider named `<harness>-<role>`, e.g. `claude-lead`; any other provider id is left alone. */
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

/** The seats the room has on this machine, read from the seats.json written when it was set up. */
export function enabledSeats(): Seat[] {
  if (!existsSync(SEATS_FILE)) throw new Error(`seatwork: ${SEATS_FILE} not found; set the room up again`);
  const parsed = JSON.parse(readFileSync(SEATS_FILE, "utf8")) as { providers?: string[] };
  return (parsed.providers ?? []).map(parseSeat).filter((s): s is Seat => s !== null);
}

/** `harness/<harness>-harness.md`: how this harness exposes the room's tools. */
export function harnessSheet(harness: Harness | undefined): string | null {
  if (!harness) return null;
  return readIfExists(join(ROOM_DIR, "harness", `${harness}-harness.md`));
}

/** `specs/<name>.md`, when the seat asked for a specialization. */
export function specSheet(name: string | undefined): string | null {
  if (!name || !/^[a-z0-9-]+$/.test(name)) return null;
  return readIfExists(join(ROOM_DIR, "specs", `${name}.md`));
}

/** Whether `parent` may create `childRole` with this title; a spawn entry is `role` or `role:spec`. */
export function maySpawn(
  spawn: Record<string, string[]>,
  parent: string,
  childRole: string,
  title: string | null | undefined,
): boolean {
  const allowed = spawn[parent] ?? [];
  if (allowed.includes(childRole)) return true;
  const spec = specFromTitle(title);
  return spec !== undefined && allowed.includes(`${childRole}:${spec}`);
}

export function specFromTitle(title: string | null | undefined): string | undefined {
  const m = /^\s*\[(?:peer|lead|supervisor|hq):([a-z0-9-]+)\]/i.exec(title ?? "");
  return m?.[1]?.toLowerCase();
}

export interface PromptContext {
  harness?: Harness;
  spec?: string;
  params: RoomParams;
  models?: Models;
}

/** The system prompt every seat receives: role file, specialization sheet, harness sheet; read on every call. */
export function rolePrompt(role: Role, context: PromptContext): string {
  const roleText = readIfExists(join(ROOM_DIR, "roles", `${role}.md`));
  if (!roleText) {
    throw new Error(`seatwork: missing role prompt ${join(ROOM_DIR, "roles", `${role}.md`)} (set the room up again)`);
  }
  const spec = specSheet(context.spec);
  const sheet = harnessSheet(context.harness);
  const vars = promptVars(context.models ?? loadModels(), context.params);
  const missing: string[] = [];
  const rendered = render(roleText.trim(), vars, (name) => missing.push(name));
  if (missing.length) console.error(`seatwork: roles/${role}.md uses unknown placeholders: ${missing.join(", ")}`);
  const needsRoomDir = role === "hq"; // a project seat is shown none of the room's directory
  const parts = [
    `# Seat: ${role}${context.spec ? ` (specialization: ${context.spec})` : ""}`,
    `This session is a ${role} seat in a Paseo room.${needsRoomDir ? ` ROOM_DIR=${ROOM_DIR}. ROOM_HOME=${ROOM_HOME}.` : ""} Role skills live in your skills directory: use them for the procedures they name.`,
    rendered,
    spec ? `\n---\n\n${spec.trim()}` : null,
    sheet ? `\n---\n\n${sheet.trim()}` : null,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}
