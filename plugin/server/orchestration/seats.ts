import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR, ROOM_HOME, SEATS_FILE } from "../paths";
import { loadModels, promptVars, render, type Models } from "./models";
import type { RoomParams } from "../policy";
import { inRoom, isRole } from "../../shared/workflow";

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

export interface PromptContext {
  harness: Harness;
  spec?: string;
  params: RoomParams;
  models?: Models;
}

/** A seat's prompt: its agent CLI's room prompt, then its role and spec; read on every call. */
export function rolePrompt(role: string, context: PromptContext): string {
  const texts = [join(ROOM_DIR, "harness", `${context.harness}-system.md`), join(ROOM_DIR, "roles", `${role}.md`)].map(
    (file) => {
      const text = readIfExists(file);
      if (!text) throw new Error(`seatwork: missing prompt file ${file} (set the room up again)`);
      return { file, text };
    },
  );
  const spec = specSheet(context.spec);
  const vars = promptVars(context.models ?? loadModels(), context.params);
  const [room, own] = texts.map(({ file, text }) => {
    const missing: string[] = [];
    const rendered = render(text.trim(), vars, (name) => missing.push(name));
    if (missing.length) console.error(`seatwork: ${file} uses unknown placeholders: ${missing.join(", ")}`);
    return rendered;
  });
  // a project seat is shown none of the room's directory
  const needsRoomDir = inRoom(role);
  // what every seat of this CLI shares comes first, word for word the same; what is this seat's own follows
  const parts = [
    room,
    `---\n\n# Seat: ${role}${context.spec ? ` (specialization: ${context.spec})` : ""}`,
    needsRoomDir ? `ROOM_DIR=${ROOM_DIR}. ROOM_HOME=${ROOM_HOME}.` : null,
    own,
    spec ? `---\n\n${spec.trim()}` : null,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}
