import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_HOME } from "./paths";
import type { Harness, Role } from "./seats";

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
  midTurn: Record<Harness, MidTurnDelivery>;
}

export type RoleName = Role;

/** Knobs that role prompts quote; rendered into {{...}} placeholders at seat creation. */
export interface RoomParams {
  heartbeatCron: string;
  peerStallMinutes: number;
  reviewStallMinutes: number;
  leadStallMinutes: number;
  readBudgetTokens: number;
  cheapReadBudgetTokens: number;
  mailChars: number;
}

/** Who may write to whom and create whom: `routes` keys are "<sender>><recipient>", `spawn` entries `role` or `role:spec`. */
export interface RoomPolicy {
  routes: Record<string, boolean>;
  spawn: Record<RoleName, string[]>;
  params: RoomParams;
}

/** Garbage collection, see gc.ts. Hours of 0 mean "never archive that role". */
export interface GcPolicy {
  everyMinutes: number;
  idleHoursBeforeArchive: Record<RoleName, number>;
  deleteOrphanHeartbeats: boolean;
  tellParent: boolean;
}

/** The watcher (watch/watcher.ts): `off` does nothing, `shadow` scans and logs, `on` also mails the seat above. */
export interface WatcherPolicy {
  mode: "off" | "shadow" | "on";
  watch: RoleName[];
  pollSeconds: number;
  historyEntries: number;
  rules: Record<string, "raise" | "log" | "off">;
  thresholds: {
    sleepSeconds: number;
    repeatRun: number;
    cycleRepeats: number;
    sameFailure: number;
    inFlightFactor: number;
  };
  scores: Record<string, number>;
  maxMailsPerSeat: number;
  engine: {
    url: string;
    model: string;
    keyFile: string;
    keyEnv: string;
    deadlineMs: number;
    restAfterFailures: number;
    restMinutes: number;
  };
  budget: { usdPerMillionTokens: number; monthlyPlanUsd: number; monthlyCapUsd: number };
  state: { messageChars: number; briefLineChars: number };
  calibration: { labelWindowMinutes: number; minLabels: number; minAuroc: number; maxFalseRaiseRate: number };
}

export interface RuntimePolicy {
  room: RoomPolicy;
  mail: MailPolicy;
  gc: GcPolicy;
  owner: OwnerPolicy;
  watcher: WatcherPolicy;
  launch: Record<Harness, LaunchPolicy>;
  claude: ClaudeRuntimePolicy;
  codex: CodexRuntimePolicy;
  pi: PiRuntimePolicy;
  opencode: OpenCodeRuntimePolicy;
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
      routes: need(room.routes, "room.routes"),
      spawn: need(room.spawn, "room.spawn"),
      params: need(room.params, "room.params"),
    },
    mail: need(parsed.mail, "mail"),
    gc: need(parsed.gc, "gc"),
    owner: need(parsed.owner, "owner"),
    watcher: need(parsed.watcher, "watcher"),
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
  };
}
