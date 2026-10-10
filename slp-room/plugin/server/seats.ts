import { execFile } from "node:child_process";
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

/** The seats paseo/seats.yml and this machine's setup.json enable, read from the seats.json that install.sh generates. */
export function enabledSeats(): Seat[] {
  if (!existsSync(SEATS_FILE)) throw new Error(`slp-seat: ${SEATS_FILE} not found; run install.sh`);
  const parsed = JSON.parse(readFileSync(SEATS_FILE, "utf8")) as { providers?: string[] };
  return (parsed.providers ?? []).map(parseSeat).filter((s): s is Seat => s !== null);
}

/**
 * Sets up seats the room does not have yet, as `./install.sh --seat` does by
 * hand: the installer records them in setup.json, writes their providers into
 * Paseo and reloads its config (a reload leaves plugins and running agents alone).
 */
export async function enableSeats(providers: string[]): Promise<void> {
  if (providers.length === 0) return;
  for (const provider of providers) {
    if (!parseSeat(provider)) throw new Error(`"${provider}" is not a seat: a seat is <harness>-<role>, harnesses ${HARNESSES.join(", ")}, roles ${ROLES.join(", ")}`);
  }
  const flags = providers.flatMap((provider) => ["--seat", provider]);
  const { installer } = JSON.parse(readFileSync(SEATS_FILE, "utf8")) as { installer?: string };
  if (!installer || !existsSync(installer)) {
    throw new Error(`slp-seat: install.sh is not where the last install left it (${installer ?? "unknown"}); run \`./install.sh ${flags.join(" ")}\` in slp-room, then repeat`);
  }
  await new Promise<void>((resolve, reject) => {
    // it may install the Pi MCP adapter on the way, hence the long timeout
    execFile("bash", [installer, "--seats-only", ...flags], { env: { ...process.env, SLP_ROOM_HOME: ROOM_HOME }, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`install.sh --seats-only ${flags.join(" ")}: ${stderr.trim() || error.message}`));
      else resolve();
    });
  });
  const enabled = enabledSeats().map((seat) => seat.provider);
  const missing = providers.filter((provider) => !enabled.includes(provider));
  if (missing.length) throw new Error(`slp-seat: install.sh ran but ${missing.join(", ")} is still not set up`);
}

/** `harness/<harness>-harness.md`: how this harness exposes the room's tools (tool names, tool search, what is denied). Named so nobody mistakes `claude.md` for a CLAUDE.md. */
export function harnessSheet(harness: Harness | undefined): string | null {
  if (!harness) return null;
  return readIfExists(join(ROOM_DIR, "harness", `${harness}-harness.md`));
}

/** `specs/<name>.md`, when the seat asked for a specialization. */
export function specSheet(name: string | undefined): string | null {
  if (!name || !/^[a-z0-9-]+$/.test(name)) return null;
  return readIfExists(join(ROOM_DIR, "specs", `${name}.md`));
}

/** `[Peer:research] task` → "research"; otherwise undefined. */
/**
 * Whether `parent` may create `childRole` with this title. A spawn entry is a
 * role (`lead`) or a role with the one specialization it allows (`peer:research`).
 */
export function maySpawn(spawn: Record<string, string[]>, parent: string, childRole: string, title: string | null | undefined): boolean {
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
  /** Knobs quoted by the prompts; with models.json they fill the {{placeholders}}. */
  params: RoomParams;
  /** The project's own table when its room.json carries one; default: the room's. */
  models?: Models;
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
  const vars = promptVars(context.models ?? loadModels(), context.params);
  const missing: string[] = [];
  const rendered = render(roleText.trim(), vars, (name) => missing.push(name));
  if (missing.length) console.error(`slp-seat: roles/${role}.md uses unknown placeholders: ${missing.join(", ")}`);
  const needsRoomDir = role === "hq"; // the model table, the registry log and the room notebook live there; a project seat is shown none of it
  const parts = [
    `# Seat: ${role}${context.spec ? ` (specialization: ${context.spec})` : ""}`,
    `This session is a ${role} seat in a Paseo room.${needsRoomDir ? ` ROOM_DIR=${ROOM_DIR}. ROOM_HOME=${ROOM_HOME}.` : ""} Role skills live in your skills directory: use them for the procedures they name.`,
    rendered,
    spec ? `\n---\n\n${spec.trim()}` : null,
    sheet ? `\n---\n\n${sheet.trim()}` : null,
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n\n");
}
