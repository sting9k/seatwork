import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryPolicy } from "./orchestration/recovery";
import type { SafetyPolicy } from "./safety/guard";
import type { WorkPolicy } from "./tasks/store";
import { ROOM_HOME } from "./paths";
import type { Harness } from "./orchestration/seats";

/** Types and loader for policy.json: no defaults here, a broken file stops the plugin. */

export interface ClaudeRuntimePolicy {
  deniedSkills: string[];
  shareFiles: string[];
}

/** How a harness's seats start: `{runtime}` in an env value is the seat's home; `extraArgs` are launch flags. */
export interface LaunchPolicy {
  env: Record<string, string>;
  extraArgs?: Record<string, string | null>;
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

/** What the room does for the Owner in the app. */
export interface OwnerPolicy {
  chime: boolean;
}

export interface PiRuntimePolicy {
  shareFiles: string[];
  shareDirs: string[];
  settings: Record<string, unknown>;
}

export interface OpenCodeRuntimePolicy {
  shareEntries: string[];
  config: Record<string, unknown>;
}

export type MidTurnDelivery = "steer" | "hold";

/** Mail delivery; `midTurn` "steer" hands mail to a running recipient (cancels its tool on Claude and Pi), "hold" waits. */
export interface MailPolicy {
  port: number;
  holdFyiWhileRunning: boolean;
  gatherReviews?: boolean;
  midTurn: Record<Harness, MidTurnDelivery>;
  quietChars?: number;
  dedupeSeconds?: number;
  keepDays?: number;
  expireUnreadDays?: number;
}

/** Knobs that role prompts quote; rendered into {{...}} placeholders at seat creation. */
export interface RoomParams {
  [name: string]: string | number | undefined;
  mailChars: number;
  rotateAtTokens?: number;
}

/** How the room works beside its workflow (shared/workflow.json): its numbers, recovery, hand-ins, work store. */
export interface RoomPolicy {
  params: RoomParams;
  recovery?: RecoveryPolicy;
  rotation?: { answerMinutes: number };
  handin?: { freshEyes: boolean };
  work?: WorkPolicy;
}

/** Garbage collection, see gc.ts. Hours of 0 mean "never archive that role". */
export interface GcPolicy {
  everyMinutes: number;
  idleHoursBeforeArchive: Record<string, number>;
  deleteOrphanHeartbeats: boolean;
  tellParent: boolean;
  runtimes?: Partial<Record<Harness, RuntimeLeftovers>>;
}

/** What an agent CLI leaves in a seat's home: what it makes again, and its session folders. */
export interface RuntimeLeftovers {
  rebuilt: string[];
  sessions: string[];
}

export interface RuntimePolicy {
  room: RoomPolicy;
  mail: MailPolicy;
  gc: GcPolicy;
  owner: OwnerPolicy;
  launch: Record<Harness, LaunchPolicy>;
  claude: ClaudeRuntimePolicy;
  codex: CodexRuntimePolicy;
  pi: PiRuntimePolicy;
  opencode: OpenCodeRuntimePolicy;
  safety?: SafetyPolicy;
}

export const POLICY_FILE = join(ROOM_HOME, "policy.json");

/** A Claude seat's denied tools: the sets its role lists in `claude.disallowedTools`. */
export function claudeDisallowed(raw: Record<string, any>, role: string): string[] {
  const { sets, roles } = raw.claude.disallowedTools as {
    sets: Record<string, string[]>;
    roles: Record<string, string[]>;
  };
  return (roles[role] ?? []).flatMap((name) => {
    if (!sets[name])
      throw new Error(`paseo/policy.json: claude.disallowedTools.roles.${role} names an unknown set "${name}"`);
    return sets[name];
  });
}

function need<T>(value: T | undefined, where: string): T {
  if (value === undefined || value === null)
    throw new Error(`seatwork: ${POLICY_FILE} is missing "${where}" (set the room up again)`);
  return value;
}

export function loadPolicy(): RuntimePolicy {
  if (!existsSync(POLICY_FILE)) throw new Error(`seatwork: ${POLICY_FILE} not found; set the room up again`);
  const parsed = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as Record<string, any>;
  const claude = need(parsed.claude, "claude");
  const room = need(parsed.room, "room");
  return {
    room: {
      params: need(room.params, "room.params"),
      // absent in a home an earlier version wrote, until the update has brought it up
      recovery: room.recovery,
      rotation: room.rotation,
      handin: room.handin,
      work: room.work,
    },
    mail: need(parsed.mail, "mail"),
    gc: need(parsed.gc, "gc"),
    owner: need(parsed.owner, "owner"),
    launch: {
      claude: need(claude.launch, "claude.launch"),
      codex: need(parsed.codex?.launch, "codex.launch"),
      pi: need(parsed.pi?.launch, "pi.launch"),
      opencode: need(parsed.opencode?.launch, "opencode.launch"),
    },
    claude: { shareFiles: need(claude.shareFiles, "claude.shareFiles"), deniedSkills: claude.deniedSkills ?? [] },
    codex: need(parsed.codex?.runtime, "codex.runtime"),
    pi: need(parsed.pi?.runtime, "pi.runtime"),
    opencode: need(parsed.opencode?.runtime, "opencode.runtime"),
    safety: parsed.safety,
  };
}
