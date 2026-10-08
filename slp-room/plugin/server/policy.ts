import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_HOME } from "./paths";

/** Types and loader for policy.json, the single source of truth: no defaults here, a broken file stops the plugin. */

export interface ClaudeRuntimePolicy {
  /** Bundled skills denied through the provider's disallowedTools as Skill(skill:<name>). */
  deniedSkills: string[];
  /** Files of the user's ~/.claude appended to a seat's prompt (the seat loads no user settings). */
  shareFiles: string[];
}

export interface CodexRuntimePolicy {
  shareFiles: string[];
  shareSkills: string[];
  sharePlugins: boolean;
  shareHooks: boolean;
  stripTables: string[];
  stripKeys: string[];
  featuresOff: string[];
  multiAgentV2Off: boolean;
  agentsOff: boolean;
}

export interface PiRuntimePolicy {
  shareFiles: string[];
  shareDirs: string[];
  /** Substrings of user `packages` entries to keep (e.g. the MCP adapter); all others are dropped. */
  keepPackages: string[];
  settings: Record<string, unknown>;
}

export interface OpenCodeRuntimePolicy {
  shareEntries: string[];
  config: Record<string, unknown>;
}

export type MidTurnDelivery = "steer" | "hold";

export interface MailPolicy {
  /** Fixed port for the room's MCP server, so seat URLs survive plugin reloads. */
  port: number;
  /** Longest body delivered verbatim; longer bodies are cut with a marker. */
  maxBodyChars: number;
  /** With midTurn "steer": FYI mail still waits for the turn to end. */
  holdFyiWhileRunning: boolean;
  /** "steer" hands mail to Paseo's steer while the recipient runs (cancels its tool on Claude and Pi); "hold" waits for the turn to end. */
  midTurn: Record<"claude" | "codex" | "pi" | "opencode", MidTurnDelivery>;
}

export type RoleName = "hq" | "supervisor" | "lead" | "peer" | "lens";

/** Knobs that role prompts quote; rendered into {{...}} placeholders at seat creation. */
export interface RoomParams {
  heartbeatCron: string;
  peerStallMinutes: number;
  reviewStallMinutes: number;
  leadStallMinutes: number;
  readBudgetTokens: number;
  cheapReadBudgetTokens: number;
}

export interface RoomPolicy {
  /** "<senderRole>><recipientRole>": may that role write to that role. The tree relation is still required. A missing pair is refused. */
  routes: Record<string, boolean>;
  /** Roles each role may create. Anything else a seat creates is archived at once and its parent told. */
  /** Per role: the roles it may create, as `role` or `role:spec` (only that specialization). */
  spawn: Record<RoleName, string[]>;
  params: RoomParams;
}

/** Garbage collection, see gc.ts. Hours of 0 mean "never archive that role". */
export interface GcPolicy {
  everyMinutes: number;
  idleHoursBeforeArchive: Record<RoleName, number>;
  deleteOrphanHeartbeats: boolean;
  /** FYI mail to the parent when one of its seats is archived by GC. */
  tellParent: boolean;
}

export interface RuntimePolicy {
  room: RoomPolicy;
  mail: MailPolicy;
  gc: GcPolicy;
  claude: ClaudeRuntimePolicy;
  codex: CodexRuntimePolicy;
  pi: PiRuntimePolicy;
  opencode: OpenCodeRuntimePolicy;
}

export const POLICY_FILE = join(ROOM_HOME, "policy.json");

function need<T>(value: T | undefined, where: string): T {
  if (value === undefined || value === null) throw new Error(`slp-seat: ${POLICY_FILE} is missing "${where}" (re-run install.sh)`);
  return value;
}

export function loadPolicy(): RuntimePolicy {
  if (!existsSync(POLICY_FILE)) throw new Error(`slp-seat: ${POLICY_FILE} not found; run install.sh`);
  const parsed = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as Record<string, any>;
  const claude = need(parsed.claude, "claude");
  const room = need(parsed.room, "room");
  return {
    room: {
      routes: need(room.routes, "room.routes"),
      spawn: need(room.spawn, "room.spawn"),
      params: need(room.params, "room.params"),
    },
    mail: need(parsed.mail, "mail"),
    gc: need(parsed.gc, "gc"),
    claude: { shareFiles: need(claude.shareFiles, "claude.shareFiles"), deniedSkills: claude.deniedSkills ?? [] },
    codex: need(parsed.codex?.runtime, "codex.runtime"),
    pi: need(parsed.pi?.runtime, "pi.runtime"),
    opencode: need(parsed.opencode?.runtime, "opencode.runtime"),
  };
}
