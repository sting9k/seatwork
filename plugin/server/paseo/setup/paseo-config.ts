import { copyFileSync, chmodSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "../api";
import { stamp } from "../../gc";
import { isRoomProvider } from "../../orchestration/seats";
import type { RoomPlan } from "./plan";
import { isObject } from "../../../shared/json";

/** Whether a profile is the room's own, by the id prefixes the room has written. */
const isOwnProfile = (id: string) => id.startsWith("agent_profile_seatwork_");
const NO_BUNDLED_SKILLS = { mode: "custom", skills: [] as string[] };
const VOICE = ["dictation", "voiceMode"] as const;

type Json = Record<string, any>;
/** Whether `before` holds a key, at any depth of plain objects, that `after` no longer has. */
function dropsKeys(before: unknown, after: unknown): boolean {
  if (!isObject(before)) return false;
  if (!isObject(after)) return true;
  return Object.keys(before).some((key) => !(key in after) || dropsKeys(before[key], after[key]));
}

/** Whether two paths are one folder, links resolved. */
const sameDir = (a: string, b: string) => {
  const real = (dir: string) => (existsSync(dir) ? realpathSync(dir) : dir);
  return real(a) === real(b);
};

/** Writes the plan's seats and profiles into a running daemon through the SDK, the user's own staying; with `daemonPolicy`, also the daemon-wide switches and the Paseo tools of the owner's own agents. */
export async function applyWithSdk(
  paseo: PaseoApi,
  plan: RoomPlan,
  options: { daemonPolicy: boolean },
): Promise<{ removed: string[] }> {
  const { config } = await paseo.config.get();
  const current = (config.providers ?? {}) as Record<string, unknown>;
  const removed = Object.keys(current).filter((id) => isRoomProvider(id) && !(id in plan.providers));
  // Paseo merges a patched provider into the one it has: one that dropped a key is removed first
  const rewritten = Object.keys(current).filter(
    (id) => id in plan.providers && dropsKeys(current[id], plan.providers[id]),
  );
  if (removed.length || rewritten.length) await paseo.config.patch({ removeProviders: [...removed, ...rewritten] });

  const owned = new Set(plan.profiles.map((profile) => profile.id));
  const kept = ((config.agentProfiles ?? []) as { id: string }[]).filter(
    (profile) => !isOwnProfile(profile.id) && !owned.has(profile.id),
  );
  const daemon = (plan.policy.daemon ?? {}) as Json;
  // Paseo merges each into the owner's own entry for that agent CLI
  const ownTools = options.daemonPolicy
    ? Object.fromEntries(Object.entries(plan.ownTools).map(([id, paseoTools]) => [id, { paseoTools }]))
    : {};
  await paseo.config.patch({
    providers: { ...ownTools, ...plan.providers } as never,
    agentProfiles: [...kept, ...plan.profiles] as never,
    mcp: { injectIntoAgents: true },
    ...(options.daemonPolicy
      ? {
          browserTools: { enabled: daemon.browserTools ?? false },
          enableTerminalAgentHooks: daemon.enableTerminalAgentHooks ?? false,
        }
      : {}),
  });
  return { removed };
}

/** Takes the room's seats and profiles out of a running daemon. */
export async function removeWithSdk(paseo: PaseoApi): Promise<{ removed: string[] }> {
  const { config } = await paseo.config.get();
  const removed = Object.keys((config.providers ?? {}) as Json).filter(isRoomProvider);
  const kept = ((config.agentProfiles ?? []) as { id: string }[]).filter((profile) => !isOwnProfile(profile.id));
  await paseo.config.patch({ removeProviders: removed, agentProfiles: kept as never });
  return { removed };
}

/** Replaces a config.json in place, leaving the old one beside it as config.json.bak-<time>. */
function writeConfig(file: string, next: Json): void {
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${stamp()}`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

/** The daemon switches the room cares about and the SDK cannot set, as this daemon's config.json has them. */
interface DaemonSwitches {
  paseoTools: boolean | null;
  dictation: boolean | null;
  voiceMode: boolean | null;
}

/** This daemon's config.json, only when it lists the plugin at its own folder: then it is surely this daemon's. */
function ownConfig(paseoHome: string, pluginDir: string): { file: string; config: Json } | null {
  const file = join(paseoHome, "config.json");
  if (!existsSync(file)) return null;
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as Json;
    const listed = Object.values((config.plugins ?? {}) as Json).some(
      (plugin) => typeof plugin?.path === "string" && sameDir(plugin.path, pluginDir),
    );
    return listed ? { file, config } : null;
  } catch {
    return null;
  }
}

/** The daemon switches as this daemon's config.json has them; null for each where the file does not say. */
export function readSwitches(paseoHome: string, pluginDir: string): DaemonSwitches {
  const own = ownConfig(paseoHome, pluginDir);
  if (!own) return { paseoTools: null, dictation: null, voiceMode: null };
  const { config } = own;
  return {
    paseoTools: config.daemon?.mcp?.enabled ?? true,
    dictation: config.features?.dictation?.enabled ?? null,
    voiceMode: config.features?.voiceMode?.enabled ?? null,
  };
}

/** Whether a skill selection is the room's own: none of Paseo's bundled skills. */
const noBundled = (selection: any) =>
  selection?.mode === "custom" && Array.isArray(selection.skills) && selection.skills.length === 0;

/** What this daemon's config.json held of the switches the room sets there because the SDK cannot: the skill selection, and dictation and voice mode; null where the file names none. */
export interface FileSwitches {
  path: string;
  skills: unknown;
  dictation: boolean | null;
  voiceMode: boolean | null;
}

/** Those switches as this daemon's config.json has them; null when the file is not surely this daemon's. */
export function readFileSwitches(paseoHome: string, pluginDir: string): FileSwitches | null {
  const own = ownConfig(paseoHome, pluginDir);
  if (!own) return null;
  const { config } = own;
  return {
    path: own.file,
    skills: config.agents?.skills?.selection ?? null,
    dictation: config.features?.dictation?.enabled ?? null,
    voiceMode: config.features?.voiceMode?.enabled ?? null,
  };
}

/** Writes into this daemon's config.json, in one write, what the policy asks there: Paseo's bundled skills kept out of agents, dictation and voice mode off; whether the file changed, and whether a voice switch did, which waits for the daemon's next restart. */
export function writeFileSwitches(
  paseoHome: string,
  pluginDir: string,
  daemon: Json,
): { changed: boolean; voice: boolean } {
  const own = ownConfig(paseoHome, pluginDir);
  if (!own) return { changed: false, voice: false };
  const next = structuredClone(own.config);
  let skills = false;
  let voice = false;
  if ((daemon.bundledSkills ?? "none") === "none" && !noBundled(next.agents?.skills?.selection)) {
    next.agents = { ...(next.agents ?? {}), skills: { ...(next.agents?.skills ?? {}), selection: NO_BUNDLED_SKILLS } };
    skills = true;
  }
  if (daemon.voice === false)
    for (const key of VOICE)
      if (next.features?.[key]?.enabled !== false) {
        next.features = { ...(next.features ?? {}), [key]: { ...(next.features?.[key] ?? {}), enabled: false } };
        voice = true;
      }
  if (skills || voice) writeConfig(own.file, next);
  return { changed: skills || voice, voice };
}

/** Puts back into the config.json the room found its daemon's what the file held before setup, each switch only while the room's value still stands there; true when a daemon reload is due. */
export function restoreFileSwitches(before: FileSwitches): boolean {
  let config: Json;
  try {
    config = JSON.parse(readFileSync(before.path, "utf8")) as Json;
  } catch {
    return false;
  }
  const next = structuredClone(config);
  let changed = false;
  if (!noBundled(before.skills) && noBundled(next.agents?.skills?.selection)) {
    if (before.skills !== null) next.agents.skills.selection = before.skills;
    else if (Object.keys(next.agents.skills).length > 1) delete next.agents.skills.selection;
    else if (Object.keys(next.agents).length > 1) delete next.agents.skills;
    else delete next.agents;
    changed = true;
  }
  for (const key of VOICE) {
    const was = before[key];
    if (was === false || next.features?.[key]?.enabled !== false) continue;
    if (was !== null) next.features[key].enabled = was;
    else if (Object.keys(next.features[key]).length > 1) delete next.features[key].enabled;
    else if (Object.keys(next.features).length > 1) delete next.features[key];
    else delete next.features;
    changed = true;
  }
  if (changed) writeConfig(before.path, next);
  return changed;
}
