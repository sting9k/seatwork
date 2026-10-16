import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR, ROOM_HOME, SEATS_FILE } from "../paths";
import { loadModels, promptVars, render, type Models } from "./models";
import type { RoomParams } from "../policy";
import { inRoom, isRole, RETIRED } from "../../shared/workflow";

/** The seats of the room: a provider named `<harness>-<role>`, the room's prompts for them, and which of them this machine has. */

export const HARNESSES = ["claude", "codex", "pi", "opencode"] as const;

export type Harness = (typeof HARNESSES)[number];

export interface Seat {
  provider: string;
  harness: Harness;
  role: string;
}

/** A seat is a provider named `<harness>-<role>`, e.g. `claude-lead`; any other provider is left alone. */
export function parseSeat(provider: string | undefined): Seat | null {
  if (!provider) return null;
  const dash = provider.indexOf("-");
  if (dash <= 0) return null;
  const harness = provider.slice(0, dash);
  const role = provider.slice(dash + 1);
  if (!(HARNESSES as readonly string[]).includes(harness)) return null;
  if (!isRole(role)) return null;
  return { provider, harness: harness as Harness, role };
}

/** Whether a provider is one the room sets up: a seat of a role it has, or of one it retired and takes out. */
export function isRoomProvider(provider: string): boolean {
  if (parseSeat(provider)) return true;
  const dash = provider.indexOf("-");
  return (
    dash > 0 &&
    (HARNESSES as readonly string[]).includes(provider.slice(0, dash)) &&
    RETIRED.includes(provider.slice(dash + 1))
  );
}

/** A file's text, or null where there is none. */
function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The seats the room has on this machine, read from the seats.json written when it was set up. */
export function enabledSeats(): Seat[] {
  if (!existsSync(SEATS_FILE)) throw new Error(`seatwork: ${SEATS_FILE} not found; set the room up again`);
  const parsed = JSON.parse(readFileSync(SEATS_FILE, "utf8")) as { providers?: string[] };
  return (parsed.providers ?? []).map(parseSeat).filter((s): s is Seat => s !== null);
}

/** `specs/<name>.md`, when the seat asked for a specialization. */
function specSheet(name: string | undefined): string | null {
  if (!name || !/^[a-z0-9-]+$/.test(name)) return null;
  return readIfExists(join(ROOM_DIR, "specs", `${name}.md`));
}

/** The specializations the room has a sheet for. */
export function knownSpecs(): string[] {
  const dir = join(ROOM_DIR, "specs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .sort();
}

/** What a seat's prompt is rendered from: its agent CLI, its specialization, the room's numbers and the table in force. */
interface PromptContext {
  harness: Harness;
  spec?: string;
  params: RoomParams;
  models?: Models;
}

/** A seat's prompt: the room's layer, its agent CLI's part, then its role and spec; read on every call. */
export function rolePrompt(role: string, context: PromptContext): string {
  const texts = [
    join(ROOM_DIR, "harness", "room.md"),
    join(ROOM_DIR, "harness", `${context.harness}-system.md`),
    join(ROOM_DIR, "roles", `${role}.md`),
  ].map((file) => {
    const text = readIfExists(file);
    if (!text) throw new Error(`seatwork: missing prompt file ${file} (set the room up again)`);
    return { file, text };
  });
  const spec = specSheet(context.spec);
  const vars = promptVars(context.models ?? loadModels(), context.params);
  const [shared, cli, own] = texts.map(({ file, text }) => {
    const missing: string[] = [];
    const rendered = render(text.trim(), vars, (name) => missing.push(name));
    if (missing.length) console.error(`seatwork: ${file} uses unknown placeholders: ${missing.join(", ")}`);
    return rendered;
  });
  // a project seat is shown none of the room's directory
  const needsRoomDir = inRoom(role);
  // what every seat of this CLI shares comes first, word for word the same; what is this seat's own follows
  const parts = [
    shared,
    cli,
    `---\n\n# Seat: ${role}${context.spec ? ` (specialization: ${context.spec})` : ""}`,
    needsRoomDir ? `ROOM_DIR=${ROOM_DIR}. ROOM_HOME=${ROOM_HOME}.` : null,
    own,
    spec ? `---\n\n${spec.trim()}` : null,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}
