import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_HOME } from "./paths";

/** Types and loader for policy.json: no defaults here, a broken file stops the plugin. */

export interface ClaudeRuntimePolicy {
  /** Bundled skills denied through the provider's disallowedTools as Skill(skill:<name>). */
  deniedSkills: string[];
  /** Files of the user's ~/.claude appended to a seat's prompt (the seat loads no user settings). */
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
  /** Laid over the user's settings.json: it empties `packages` and `extensions`. */
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
  /** With midTurn "steer": FYI mail still waits for the turn to end. */
  holdFyiWhileRunning: boolean;
  /** "steer" hands mail to a running recipient (cancels its tool on Claude and Pi); "hold" waits for the turn's end. */
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
  /** "<senderRole>><recipientRole>": whether that role may write to that role; a missing pair is refused. */
  routes: Record<string, boolean>;
  /** Per role: the roles it may create, as `role` or `role:spec`; anything else is archived. */
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
  /** Per rule: mail it, only log it, or skip it. A rule not listed is logged. */
  rules: Record<string, "raise" | "log" | "off">;
  thresholds: { sleepSeconds: number; repeatRun: number; cycleRepeats: number; sameFailure: number; inFlightFactor: number };
  /** Per rule that asks the model: the score from which its finding counts. */
  scores: Record<string, number>;
  maxMailsPerSeat: number;
  engine: { url: string; model: string; keyFile: string; keyEnv: string; deadlineMs: number; restAfterFailures: number; restMinutes: number };
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
  launch: Record<"claude" | "codex" | "pi" | "opencode", LaunchPolicy>;
  claude: ClaudeRuntimePolicy;
  codex: CodexRuntimePolicy;
  pi: PiRuntimePolicy;
  opencode: OpenCodeRuntimePolicy;
}

export const POLICY_FILE = join(ROOM_HOME, "policy.json");

function need<T>(value: T | undefined, where: string): T {
  if (value === undefined || value === null) throw new Error(`seatwork: ${POLICY_FILE} is missing "${where}" (set the room up again)`);
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
