import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { merge } from "../../shared/model-choices";
import { allowed, layModels, type Models } from "../models";
import { HARNESSES, parseSeat, ROLES, type Harness, type Role } from "../seats";

/** This machine's own choices, kept in ROOM_HOME/setup.json and never in the repo. */
export interface Setup {
  hq?: "default" | { provider: string; thinking?: string };
  seats?: string[];
  watcher?: "off" | "shadow" | "on";
  models?: Record<string, unknown>;
  chime?: boolean;
  mailPort?: number;
  version?: string;
}

export const WATCHER_MODES = ["off", "shadow", "on"] as const;

/** One model of a harness, as Paseo's catalog lists it. */
export interface CatalogModel {
  label: string;
  description?: string;
  thinking: string[];
  defaultThinking?: string;
}

/** A harness's live model catalog by model id, or null when it cannot be read. */
export type Catalog = (harness: Harness) => Promise<Record<string, CatalogModel> | null>;

export interface ProviderEntry {
  extends: string;
  label: string;
  description: string;
  paseoTools: { enabled: boolean; disabledTools: string[] };
  env: Record<string, string>;
  options?: { extraArgs: Record<string, string | null> };
  disallowedTools?: string[];
  models?: Record<string, unknown>[];
}

export interface Profile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  [key: string]: unknown;
}

/** Everything setting the room up writes, worked out before anything is written. */
export interface RoomPlan {
  seats: Record<string, string[]>;
  providers: Record<string, ProviderEntry>;
  profiles: Profile[];
  models: Models;
  policy: Record<string, any>;
  warnings: string[];
}

const LABEL: Record<Harness, string> = { claude: "Claude", codex: "Codex", pi: "Pi", opencode: "OpenCode" };
const ROLE_LABEL: Record<Role, string> = { hq: "HQ Supervisor", supervisor: "Supervisor", lead: "Lead", peer: "Peer", lens: "Lens" };
/** How each harness is kept apart from the user's own setup (shown in the provider description). */
const ISOLATION: Record<Harness, string> = {
  claude: "on the user's Claude sign-in with personal settings switched off",
  codex: "on an isolated Codex runtime (CODEX_HOME per role)",
  pi: "on an isolated Pi runtime (PI_CODING_AGENT_DIR per role)",
  opencode: "on an isolated OpenCode runtime (OPENCODE_CONFIG_DIR per role)",
};

function readJson(file: string): any {
  if (!existsSync(file)) throw new Error(`seatwork: ${file} is missing from the plugin`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** setup.json, checked: it may have been edited by hand. */
export function checkSetup(setup: unknown, where: string): Setup {
  if (typeof setup !== "object" || setup === null || Array.isArray(setup)) throw new Error(`${where} must hold an object`);
  const { hq = "default", seats = [], watcher = "off", models, chime, mailPort } = setup as Record<string, unknown>;
  if (hq !== "default") {
    const provider = typeof hq === "object" && hq !== null ? String((hq as { provider?: unknown }).provider ?? "") : "";
    const slash = provider.indexOf("/");
    if (slash <= 0 || parseSeat(provider.slice(0, slash))?.role !== "hq" || !provider.slice(slash + 1)) {
      throw new Error(`${where}: "hq" must be "default" or {"provider": "<harness>-hq/<model>", "thinking": "<id>"}`);
    }
  }
  if (!Array.isArray(seats) || !seats.every((seat) => parseSeat(String(seat)))) {
    throw new Error(`${where}: "seats" must list <harness>-<role> ids; harnesses are ${HARNESSES.join(", ")}, roles are ${ROLES.join(", ")}`);
  }
  if (!(WATCHER_MODES as readonly unknown[]).includes(watcher)) throw new Error(`${where}: "watcher" must be one of ${WATCHER_MODES.join(", ")}`);
  if (models !== undefined && (typeof models !== "object" || models === null || Array.isArray(models))) throw new Error(`${where}: "models" must be an object shaped like room/models.json`);
  if (chime !== undefined && typeof chime !== "boolean") throw new Error(`${where}: "chime" must be true or false`);
  if (mailPort !== undefined && !(Number.isInteger(mailPort) && (mailPort as number) >= 0 && (mailPort as number) <= 65535)) throw new Error(`${where}: "mailPort" must be a port number`);
  return setup as Setup;
}

/** The room's model table as the plugin ships it. */
export function roomModels(pluginDir: string): Models {
  return readJson(join(pluginDir, "room", "models.json")) as Models;
}

/** The table this machine runs on: the room's, HQ on its chosen seat, then the machine's own differences. */
function machineModels(base: Models, setup: Setup): Models {
  let models = base;
  if (typeof setup.hq === "object") {
    // a model without thinking options carries none: "default" tells the prompts to leave it out
    models = merge(models, { seats: { hq: { thinking: "default", ...setup.hq } } }) as Models;
  }
  return setup.models === undefined ? layModels(models, {}, "the model table") : layModels(models, setup.models, "this machine's model choices");
}

const splitModel = (entry: string): [provider: string, model: string] => {
  const slash = entry.indexOf("/"); // the model id may hold slashes of its own
  return [entry.slice(0, slash), entry.slice(slash + 1)];
};

/** provider id -> the model ids the table assigns to it. */
function modelsByProvider(models: Models): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const entry of Object.values(allowed(models)).flat()) {
    const [provider, model] = splitModel(entry);
    if (!used.has(provider)) used.set(provider, new Set());
    used.get(provider)!.add(model);
  }
  return used;
}

/** The seat a profile opens, taken from the table so a machine's own choice shows in the profile it uses. */
function profileSeat(models: Models, role: Role): { entry: string; thinking: string } | null {
  if (role === "hq" || role === "supervisor" || role === "lead") return { entry: models.seats[role].provider, thinking: models.seats[role].thinking };
  if (role === "peer") {
    const tier = models.peer.tiers.default ?? Object.values(models.peer.tiers)[0];
    return tier ? { entry: tier.providers[0], thinking: tier.thinking } : null;
  }
  return null;
}

/** Works out the seats, providers, profiles, model table and policy for this machine; writes nothing. */
export async function planRoom(input: { pluginDir: string; roomHome: string; setup: Setup; catalog: Catalog }): Promise<RoomPlan> {
  const { pluginDir, roomHome, setup, catalog } = input;
  const seatsFile = readJson(join(pluginDir, "paseo", "seats.json")) as { seats?: Record<string, string[]>; restrictModels?: boolean };
  const policy = readJson(join(pluginDir, "paseo", "policy.json")) as Record<string, any>;
  const profiles = readJson(join(pluginDir, "paseo", "profiles.json")) as Profile[];
  const models = machineModels(roomModels(pluginDir), setup);
  const warnings: string[] = [];

  const seats: Record<string, string[]> = {};
  const enabled: string[] = [];
  const enable = (harness: string, role: string, where: string) => {
    if (!(ROLES as readonly string[]).includes(role)) throw new Error(`${where}: unknown role ${role}; roles are ${ROLES.join(", ")}`);
    if (!(HARNESSES as readonly string[]).includes(harness)) throw new Error(`${where}: unknown harness ${harness}; harnesses are ${HARNESSES.join(", ")}`);
    if (enabled.includes(`${harness}-${role}`)) return;
    enabled.push(`${harness}-${role}`);
    (seats[role] ??= []).push(harness);
  };
  for (const [role, harnesses] of Object.entries(seatsFile.seats ?? {})) for (const harness of harnesses ?? []) enable(harness, role, "paseo/seats.json");
  // a seat the table names is a seat the room has
  const used = modelsByProvider(models);
  for (const provider of used.keys()) {
    const seat = parseSeat(provider);
    if (!seat) throw new Error(`the model table names "${provider}", which is not a seat (<harness>-<role>)`);
    enable(seat.harness, seat.role, "the model table");
  }
  for (const provider of setup.seats ?? []) {
    const seat = parseSeat(provider);
    if (seat) enable(seat.harness, seat.role, "setup.json");
  }
  if (enabled.length === 0) throw new Error("paseo/seats.json: no seats enabled");

  const tools = policy.paseoTools as { all: string[]; allow: Record<string, string[]> };
  for (const [role, names] of Object.entries(tools.allow)) {
    const unknown = names.filter((name) => !tools.all.includes(name)).sort();
    if (unknown.length) throw new Error(`paseo/policy.json: role ${role} allows unknown Paseo tools: ${unknown.join(", ")}`);
  }

  const catalogs = new Map<Harness, Record<string, CatalogModel> | null>();
  const catalogOf = async (harness: Harness) => {
    if (!catalogs.has(harness)) catalogs.set(harness, await catalog(harness));
    return catalogs.get(harness) ?? null;
  };

  const providers: Record<string, ProviderEntry> = {};
  for (const id of enabled) {
    const { harness, role } = parseSeat(id)!;
    const allow = tools.allow[role] ?? [];
    const launch = policy[harness].launch as { env: Record<string, string>; extraArgs?: Record<string, string | null> };
    const runtime = join(roomHome, "runtimes", harness, role);
    const entry: ProviderEntry = {
      extends: harness,
      label: `${LABEL[harness]} ${ROLE_LABEL[role]}`,
      description: `${ROLE_LABEL[role]} seat ${ISOLATION[harness]}; Paseo tools: ${allow.join(", ") || "none"}`,
      paseoTools: { enabled: true, disabledTools: tools.all.filter((tool) => !allow.includes(tool)) },
      // the seat's isolation is part of its provider: it holds for a session the plugin did not open
      env: Object.fromEntries(Object.entries(launch.env).map(([name, value]) => [name, value.replaceAll("{runtime}", runtime)])),
    };
    if (launch.extraArgs && Object.keys(launch.extraArgs).length) entry.options = { extraArgs: launch.extraArgs };
    if (harness === "claude") {
      const deniedSkills = ((policy.claude.deniedSkills ?? []) as string[]).map((name) => `Skill(skill:${name})`);
      entry.disallowedTools = [...(policy.claude.disallowedTools[role] as string[]), ...deniedSkills];
    }
    const assigned = used.get(id);
    if ((seatsFile.restrictModels ?? true) && assigned?.size) {
      const cat = await catalogOf(harness);
      if (!cat) warnings.push(`cannot read the ${harness} model catalog from the daemon; ${id} keeps the full list`);
      else {
        const rows: Record<string, unknown>[] = [];
        for (const model of [...assigned].sort()) {
          const found = cat[model];
          if (!found) {
            warnings.push(`the model table assigns ${model} to ${id} but the ${harness} catalog has no such model`);
            continue;
          }
          rows.push({
            id: model,
            label: found.label || model,
            ...(found.description ? { description: found.description } : {}),
            ...(found.thinking.length ? { thinkingOptions: found.thinking.map((t) => ({ id: t, label: t, ...(t === found.defaultThinking ? { isDefault: true } : {}) })) } : {}),
          });
        }
        if (rows.length) {
          rows[0].isDefault = true;
          entry.models = rows;
        }
      }
    }
    providers[id] = entry;
  }

  for (const profile of profiles) {
    const role = parseSeat(profile.provider)?.role;
    const seat = role ? profileSeat(models, role) : null;
    if (seat) {
      const [provider, model] = splitModel(seat.entry);
      const harness = parseSeat(provider)!.harness;
      Object.assign(profile, { provider, model });
      const known = (await catalogOf(harness))?.[model];
      // a harness without session modes, or a model without that thinking option, takes no such setting
      const thinking = seat.thinking && seat.thinking !== "default" && (!known || known.thinking.includes(seat.thinking)) ? seat.thinking : undefined;
      for (const [key, value] of [["modeId", models.modes[harness]], ["thinkingOptionId", thinking]] as const) {
        delete profile[key];
        if (value) profile[key] = value;
      }
    }
    if (!(profile.provider in providers)) throw new Error(`paseo/profiles.json: profile ${profile.id} uses provider ${profile.provider}, which is not a seat the room sets up`);
  }

  policy.watcher.mode = setup.watcher ?? "off";
  if (setup.chime !== undefined) policy.owner.chime = setup.chime;
  if (setup.mailPort !== undefined) policy.mail.port = setup.mailPort;
  return { seats, providers, profiles, models, policy, warnings };
}
