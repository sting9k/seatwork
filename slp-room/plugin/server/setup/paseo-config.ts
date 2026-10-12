import { copyFileSync, chmodSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "../paseo";
import { parseSeat } from "../seats";
import type { RoomPlan } from "./plan";
import { stamp } from "./room-home";

/** Every profile the room ever wrote carries this id prefix; the user's own profiles do not. */
const OWN_PROFILE = "agent_profile_slp_";
const isRoomSeat = (id: string) => parseSeat(id) !== null;
const NO_BUNDLED_SKILLS = { mode: "custom", skills: [] as string[] };

type Json = Record<string, any>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `before` holds a key, at any depth of plain objects, that `after` no longer has. */
function dropsKeys(before: unknown, after: unknown): boolean {
  if (!isRecord(before)) return false;
  if (!isRecord(after)) return true;
  return Object.keys(before).some((key) => !(key in after) || dropsKeys(before[key], after[key]));
}

const sameDir = (a: string, b: string) => {
  const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : dir);
  return real(a) === real(b);
};

/**
 * Writes the plan's seats and profiles into a running daemon through the SDK: live at once, no
 * reload. Seats the room no longer has are removed; the user's own providers and profiles stay.
 */
export async function applyWithSdk(paseo: PaseoApi, plan: RoomPlan, options: { daemonPolicy: boolean }): Promise<{ removed: string[] }> {
  const { config } = await paseo.config.get();
  const current = (config.providers ?? {}) as Record<string, unknown>;
  const removed = Object.keys(current).filter((id) => isRoomSeat(id) && !(id in plan.providers));
  // Paseo merges a patched provider into the one it has, so a key the new entry dropped would stay: such a seat is removed first
  const rewritten = Object.keys(current).filter((id) => id in plan.providers && dropsKeys(current[id], plan.providers[id]));
  if (removed.length || rewritten.length) await paseo.config.patch({ removeProviders: [...removed, ...rewritten] });

  const owned = new Set(plan.profiles.map((profile) => profile.id));
  const kept = ((config.agentProfiles ?? []) as { id: string }[]).filter((profile) => !profile.id.startsWith(OWN_PROFILE) && !owned.has(profile.id));
  const daemon = (plan.policy.daemon ?? {}) as Json;
  await paseo.config.patch({
    providers: plan.providers as never,
    agentProfiles: [...kept, ...plan.profiles] as never,
    mcp: { injectIntoAgents: true },
    ...(options.daemonPolicy ? { browserTools: { enabled: daemon.browserTools ?? false }, enableTerminalAgentHooks: daemon.enableTerminalAgentHooks ?? false } : {}),
  });
  return { removed };
}

/** Takes the room's seats and profiles out of a running daemon. */
export async function removeWithSdk(paseo: PaseoApi): Promise<{ removed: string[] }> {
  const { config } = await paseo.config.get();
  const removed = Object.keys((config.providers ?? {}) as Json).filter(isRoomSeat);
  const kept = ((config.agentProfiles ?? []) as { id: string }[]).filter((profile) => !profile.id.startsWith(OWN_PROFILE));
  await paseo.config.patch({ removeProviders: removed, agentProfiles: kept as never });
  return { removed };
}

/** Paseo's config.json with the plan laid in: the room's seats, profiles and daemon switches set, everything else kept. */
function mergeIntoConfig(config: Json, plan: RoomPlan): Json {
  const next: Json = structuredClone(config);
  const owned = new Set(plan.profiles.map((profile) => profile.id));
  next.daemon ??= {};
  next.agents ??= {};
  next.daemon.agentProfiles = [...((next.daemon.agentProfiles ?? []) as { id?: string }[]).filter((p) => !(p.id ?? "").startsWith(OWN_PROFILE) && !owned.has(p.id ?? "")), ...plan.profiles];
  next.agents.providers = { ...Object.fromEntries(Object.entries((next.agents.providers ?? {}) as Json).filter(([id]) => !isRoomSeat(id))), ...plan.providers };
  next.daemon.mcp = { ...(next.daemon.mcp ?? {}), enabled: true, injectIntoAgents: true };
  next.pluginsEnabled = true;
  const daemon = (plan.policy.daemon ?? {}) as Json;
  next.daemon.browserTools = { ...(next.daemon.browserTools ?? {}), enabled: daemon.browserTools ?? false };
  next.daemon.enableTerminalAgentHooks = daemon.enableTerminalAgentHooks ?? false;
  next.features ??= {};
  next.features.dictation = { ...(next.features.dictation ?? {}), enabled: daemon.dictation ?? false };
  next.features.voiceMode = { ...(next.features.voiceMode ?? {}), enabled: daemon.voiceMode ?? false };
  if ((daemon.bundledSkills ?? "none") === "none") next.agents.skills = { ...(next.agents.skills ?? {}), selection: NO_BUNDLED_SKILLS };
  return next;
}

/** Replaces a config.json in place, leaving the old one beside it as config.json.bak-<time>. */
function writeConfig(file: string, next: Json): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${stamp()}`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

/** The installer's way in: the plan written into a daemon's config.json, for a `paseo daemon reload` to pick up. */
export function applyToConfigFile(paseoHome: string, plan: RoomPlan): void {
  const file = join(paseoHome, "config.json");
  const config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Json) : { version: 1 };
  writeConfig(file, mergeIntoConfig(config, plan));
}

/** The daemon switches the room cares about and the SDK cannot set, as this daemon's config.json has them. */
export interface DaemonSwitches {
  /** Paseo's own tools for agents: seats cannot create or reach each other without them. */
  paseoTools: boolean | null;
  dictation: boolean | null;
  voiceMode: boolean | null;
  /** Whether Paseo's bundled skills are kept out of every agent. */
  bundledSkillsOff: boolean | null;
}

/** This daemon's config.json, only when it is certain the file is this daemon's: it lists the plugin at its own folder. */
function ownConfig(paseoHome: string, pluginDir: string): { file: string; config: Json } | null {
  const file = join(paseoHome, "config.json");
  if (!existsSync(file)) return null;
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as Json;
    const listed = Object.values((config.plugins ?? {}) as Json).some((plugin) => typeof plugin?.path === "string" && sameDir(plugin.path, pluginDir));
    return listed ? { file, config } : null;
  } catch {
    return null;
  }
}

export function readSwitches(paseoHome: string, pluginDir: string): DaemonSwitches {
  const own = ownConfig(paseoHome, pluginDir);
  if (!own) return { paseoTools: null, dictation: null, voiceMode: null, bundledSkillsOff: null };
  const { config } = own;
  const selection = config.agents?.skills?.selection;
  return {
    paseoTools: config.daemon?.mcp?.enabled ?? true,
    dictation: config.features?.dictation?.enabled ?? null,
    voiceMode: config.features?.voiceMode?.enabled ?? null,
    bundledSkillsOff: selection?.mode === "custom" && Array.isArray(selection.skills) && selection.skills.length === 0,
  };
}

/**
 * Keeps Paseo's bundled skills out of agents by writing the daemon's config.json, the one switch
 * the room sets that the SDK has no call for. Returns whether a `paseo daemon reload` is now due.
 */
export function turnBundledSkillsOff(paseoHome: string, pluginDir: string): boolean {
  const own = ownConfig(paseoHome, pluginDir);
  if (!own || readSwitches(paseoHome, pluginDir).bundledSkillsOff) return false;
  const next = structuredClone(own.config);
  next.agents = { ...(next.agents ?? {}), skills: { ...(next.agents?.skills ?? {}), selection: NO_BUNDLED_SKILLS } };
  writeConfig(own.file, next);
  return true;
}
