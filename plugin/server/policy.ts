import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryPolicy } from "./orchestration/recovery";
import type { JevPolicy } from "./jev/index";
import type { KnowledgePolicy } from "./knowledge/index";
import type { BudgetPolicy } from "./operations/budget";
import type { SafetyPolicy } from "./safety/guard";
import type { WorkPolicy } from "./tasks/store";
import { ROOM_HOME } from "./paths";
import type { Harness } from "./orchestration/seats";

/** Types and loader for policy.json: no defaults here, a broken file stops the plugin. */

export interface ClaudeRuntimePolicy {
  deniedSkills: string[];
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

/** How the room works beside its workflow (shared/workflow.json): its numbers, the instructions every seat reads, recovery, hand-ins, work store. */
export interface RoomPolicy {
  params: RoomParams;
  instructions?: string[];
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
  jev?: JevPolicy;
  knowledge?: KnowledgePolicy;
  budget?: BudgetPolicy;
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

/** A part of the policy that must be there; the message tells the owner to apply the room again. */
function need<T>(value: T | undefined, where: string): T {
  if (value === undefined || value === null)
    throw new Error(`seatwork: ${POLICY_FILE} is missing "${where}" (set the room up again)`);
  return value;
}

/** The policy the room runs on, read from the room home. */
export function loadPolicy(): RuntimePolicy {
  if (!existsSync(POLICY_FILE)) throw new Error(`seatwork: ${POLICY_FILE} not found; set the room up again`);
  const parsed = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as Record<string, any>;
  const claude = need(parsed.claude, "claude");
  const room = need(parsed.room, "room");
  return {
    room: {
      params: need(room.params, "room.params"),
      instructions: room.instructions,
      // absent until the room is applied again after the plugin updates
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
    claude: { deniedSkills: claude.deniedSkills ?? [] },
    codex: need(parsed.codex?.runtime, "codex.runtime"),
    pi: need(parsed.pi?.runtime, "pi.runtime"),
    opencode: need(parsed.opencode?.runtime, "opencode.runtime"),
    safety: parsed.safety,
    jev: parsed.jev,
    knowledge: parsed.knowledge,
    budget: parsed.budget,
  };
}

const stampOf = (file: string): string => {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
};

/** Keeps a running policy's budget as its file has it, read again when the file changes, so a cap the owner raised there holds without a restart. */
export function followBudget(policy: RuntimePolicy, file = POLICY_FILE): () => void {
  let seen = stampOf(file);
  return () => {
    const now = stampOf(file);
    if (now === seen) return;
    try {
      policy.budget = (JSON.parse(readFileSync(file, "utf8")) as { budget?: BudgetPolicy }).budget;
      seen = now;
    } catch {
      // a file half written, or no JSON: the budget read last stands until the file is whole
    }
  };
}
