import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowed, layModels, tiersOf, type Models } from "../../orchestration/models";
import { PASEO_HOME } from "../../paths";
import { claudeDisallowed } from "../../policy";
import { secretsOf } from "../../safety/gate/rules/secrets";
import { HARNESSES, parseSeat, type Harness } from "../../orchestration/seats";
import { ROLES, traits } from "../../../shared/workflow";
import { keptChanges, layOver } from "./policy-changes";

/** This machine's own choices, kept in ROOM_HOME/setup.json and never in the repo; the room's own seat is in `models` like any seat. */
export interface Setup {
  seats?: string[];
  models?: Record<string, unknown>;
  chime?: boolean;
  mailPort?: number;
  version?: string;
}

/** One model of a harness, as Paseo's catalog lists it. */
export interface CatalogModel {
  label: string;
  description?: string;
  thinking: string[];
  defaultThinking?: string;
}

/** A harness's live model catalog by model id, or null when it cannot be read. */
export type Catalog = (harness: Harness) => Promise<Record<string, CatalogModel> | null>;

/** The Paseo tools a provider gives its agents: all of them but `disabledTools`, or none when not `enabled`. */
type PaseoTools = { enabled: boolean; disabledTools: string[] };

/** A seat's provider as Paseo's config holds it. */
interface ProviderEntry {
  extends: string;
  label: string;
  description: string;
  paseoTools: PaseoTools;
  env: Record<string, string>;
  options?: { extraArgs?: Record<string, string | null>; permission?: Record<string, unknown> };
  disallowedTools?: string[];
  models?: Record<string, unknown>[];
}

/** An agent profile as Paseo's config holds it. */
interface Profile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  [key: string]: unknown;
}

/** A profile as paseo/profiles.json writes it: a role; the model table says the rest. */
interface ProfileSpec {
  id: string;
  name: string;
  role: string;
  [key: string]: unknown;
}

/** Everything setting the room up writes, worked out before anything is written; `ownTools` is the Paseo tools of the owner's own agents, by agent CLI. */
export interface RoomPlan {
  seats: Record<string, string[]>;
  providers: Record<string, ProviderEntry>;
  ownTools: Record<string, PaseoTools>;
  profiles: Profile[];
  models: Models;
  policy: Record<string, any>;
  shipped: Record<string, any>;
  warnings: string[];
}

const LABEL: Record<Harness, string> = { claude: "Claude", codex: "Codex", pi: "Pi", opencode: "OpenCode" };
const ISOLATION: Record<Harness, string> = {
  claude: "on the user's Claude sign-in with personal settings switched off",
  codex: "on an isolated Codex runtime (CODEX_HOME per role)",
  pi: "on an isolated Pi runtime (PI_CODING_AGENT_DIR per role)",
  opencode: "on an isolated OpenCode runtime (OPENCODE_CONFIG_DIR per role)",
};

/** A JSON file the plugin ships; a missing one is an error. */
function readJson(file: string): any {
  if (!existsSync(file)) throw new Error(`seatwork: ${file} is missing from the plugin`);
  return JSON.parse(readFileSync(file, "utf8"));
}

/** setup.json, checked: it may have been edited by hand. */
export function checkSetup(setup: unknown, where: string): Setup {
  if (typeof setup !== "object" || setup === null || Array.isArray(setup))
    throw new Error(`${where} must hold an object`);
  const { seats = [], models, chime, mailPort } = setup as Record<string, unknown>;
  if (!Array.isArray(seats) || !seats.every((seat) => parseSeat(String(seat)))) {
    throw new Error(
      `${where}: "seats" must list <harness>-<role> ids; harnesses are ${HARNESSES.join(", ")}, roles are ${ROLES.join(", ")}`,
    );
  }
  if (models !== undefined && (typeof models !== "object" || models === null || Array.isArray(models)))
    throw new Error(`${where}: "models" must be an object shaped like room/models.json`);
  if (chime !== undefined && typeof chime !== "boolean") throw new Error(`${where}: "chime" must be true or false`);
  if (
    mailPort !== undefined &&
    !(Number.isInteger(mailPort) && (mailPort as number) >= 0 && (mailPort as number) <= 65535)
  )
    throw new Error(`${where}: "mailPort" must be a port number`);
  return setup as Setup;
}

/** The room's model table as the plugin ships it. */
export function roomModels(pluginDir: string): Models {
  return readJson(join(pluginDir, "room", "models.json")) as Models;
}

/** The table this machine runs on: the room's, with the machine's own differences, its own seat among them. */
function machineModels(base: Models, setup: Setup): Models {
  return setup.models === undefined
    ? layModels(base, {}, "the model table")
    : layModels(base, setup.models, "this machine's model choices");
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
function profileSeat(models: Models, role: string): { entry: string; thinking: string } | null {
  const seat = models.seats[role];
  if (traits(role).models === "one") return seat ? { entry: seat.provider, thinking: seat.thinking } : null;
  const tiers = tiersOf(models, role)?.tiers ?? {};
  const tier = tiers.default ?? Object.values(tiers)[0];
  return tier ? { entry: tier.providers[0], thinking: tier.thinking } : null;
}

/** paseo/seats.json: the seats every install has, and whether a seat lists only the models the table gives it. */
type Seats = { seats?: Record<string, string[]>; restrictModels?: boolean };
/** paseo/policy.json's Paseo tools: every tool Paseo has, and the ones each role may use. */
type Tools = { all: string[]; allow: Record<string, string[]> };

/** The seats the room has: those paseo/seats.json lists, those the model table names, those this machine added. */
function enabledSeats(
  listed: Seats,
  models: Models,
  setup: Setup,
): { seats: Record<string, string[]>; enabled: string[]; used: Map<string, Set<string>> } {
  const seats: Record<string, string[]> = {};
  const enabled: string[] = [];
  const enable = (harness: string, role: string, where: string) => {
    if (!ROLES.includes(role)) throw new Error(`${where}: unknown role ${role}; roles are ${ROLES.join(", ")}`);
    if (!(HARNESSES as readonly string[]).includes(harness))
      throw new Error(`${where}: unknown harness ${harness}; harnesses are ${HARNESSES.join(", ")}`);
    if (enabled.includes(`${harness}-${role}`)) return;
    enabled.push(`${harness}-${role}`);
    (seats[role] ??= []).push(harness);
  };
  for (const [role, harnesses] of Object.entries(listed.seats ?? {}))
    for (const harness of harnesses ?? []) enable(harness, role, "paseo/seats.json");
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
  return { seats, enabled, used };
}

/** The models a seat lists in Paseo: those the table assigns it, as its harness's catalog describes them. */
function modelRows(cat: Record<string, CatalogModel>, assigned: Set<string>, id: string, warnings: string[]) {
  const rows: Record<string, unknown>[] = [];
  for (const model of [...assigned].sort()) {
    const found = cat[model];
    if (!found) {
      warnings.push(
        `the model table assigns ${model} to ${id} but the ${parseSeat(id)!.harness} catalog has no such model`,
      );
      continue;
    }
    rows.push({
      id: model,
      label: found.label || model,
      ...(found.description ? { description: found.description } : {}),
      ...(found.thinking.length
        ? {
            thinkingOptions: found.thinking.map((t) => ({
              id: t,
              label: t,
              ...(t === found.defaultThinking ? { isDefault: true } : {}),
            })),
          }
        : {}),
    });
  }
  if (rows.length) rows[0].isDefault = true;
  return rows;
}

/** What every provider of a plan is worked out from. */
interface ProviderContext {
  roomHome: string;
  policy: Record<string, any>;
  tools: Tools;
  restrictModels: boolean;
  used: Map<string, Set<string>>;
  catalogOf: Catalog;
  warnings: string[];
}

/** A seat's provider in Paseo's config: its launch environment, its Paseo tools, its denied tools, its models. */
async function providerFor(id: string, context: ProviderContext): Promise<ProviderEntry> {
  const { roomHome, policy, tools, restrictModels, used, catalogOf, warnings } = context;
  const { harness, role } = parseSeat(id)!;
  const allow = tools.allow[role] ?? [];
  const launch = policy[harness].launch as { env: Record<string, string>; extraArgs?: Record<string, string | null> };
  const runtime = join(roomHome, "runtimes", harness, role);
  const entry: ProviderEntry = {
    extends: harness,
    label: `${LABEL[harness]} ${traits(role).profile}`,
    description: `${traits(role).profile} seat ${ISOLATION[harness]}; Paseo tools: ${allow.join(", ") || "none"}`,
    paseoTools: { enabled: true, disabledTools: tools.all.filter((tool) => !allow.includes(tool)) },
    // the seat's isolation is part of its provider: it holds for a session the plugin did not open
    env: Object.fromEntries(
      Object.entries(launch.env).map(([name, value]) => [name, value.replaceAll("{runtime}", runtime)]),
    ),
  };
  if (launch.extraArgs && Object.keys(launch.extraArgs).length) entry.options = { extraArgs: launch.extraArgs };
  if (harness === "claude") {
    const deniedSkills = ((policy.claude.deniedSkills ?? []) as string[]).map((name) => `Skill(skill:${name})`);
    // Claude's own Read, Grep and Glob meet the secrets here; its shell meets them at the guard
    const secrets = secretsOf(PASEO_HOME, roomHome).map((s) => `Read(/${s}${s.endsWith("/") ? "**" : ""})`);
    entry.disallowedTools = [...claudeDisallowed(policy, role), ...deniedSkills, ...secrets];
  }
  // OpenCode 2 reads permissions from the session, so the policy's travel with the provider too
  if (harness === "opencode" && policy.opencode.runtime.config.permission)
    entry.options = { ...entry.options, permission: policy.opencode.runtime.config.permission };
  const assigned = used.get(id);
  if (restrictModels && assigned?.size) {
    const cat = await catalogOf(harness);
    if (!cat) warnings.push(`cannot read the ${harness} model catalog from the daemon; ${id} keeps the full list`);
    else {
      const rows = modelRows(cat, assigned, id, warnings);
      if (rows.length) entry.models = rows;
    }
  }
  return entry;
}

/** The agent profiles the screen offers, each on the seat and model the table gives its role. */
async function profilesFor(
  shown: ProfileSpec[],
  models: Models,
  providers: Record<string, ProviderEntry>,
  catalogOf: Catalog,
): Promise<Profile[]> {
  const profiles: Profile[] = [];
  for (const { role, ...rest } of shown) {
    const seat = profileSeat(models, role);
    if (!seat)
      throw new Error(
        `paseo/profiles.json: profile ${rest.id} is for role ${role}, which the model table gives no seat`,
      );
    const [provider, model] = splitModel(seat.entry);
    if (!(provider in providers))
      throw new Error(
        `paseo/profiles.json: profile ${rest.id} uses provider ${provider}, which is not a seat the room sets up`,
      );
    const harness = parseSeat(provider)!.harness;
    const known = (await catalogOf(harness))?.[model];
    // a harness without session modes, or a model without that thinking option, takes no such setting
    const mode = models.modes[harness];
    const thinking =
      seat.thinking && seat.thinking !== "default" && (!known || known.thinking.includes(seat.thinking))
        ? seat.thinking
        : undefined;
    profiles.push({
      ...rest,
      provider,
      model,
      ...(mode ? { modeId: mode } : {}),
      ...(thinking ? { thinkingOptionId: thinking } : {}),
    });
  }
  return profiles;
}

/** Works out the seats, providers, profiles, model table and policy for this machine; writes nothing. */
export async function planRoom(input: {
  pluginDir: string;
  roomHome: string;
  setup: Setup;
  catalog: Catalog;
}): Promise<RoomPlan> {
  const { pluginDir, roomHome, setup, catalog } = input;
  const seatsFile = readJson(join(pluginDir, "paseo", "seats.json")) as Seats;
  const policy = readJson(join(pluginDir, "paseo", "policy.json")) as Record<string, any>;
  const shown = readJson(join(pluginDir, "paseo", "profiles.json")) as ProfileSpec[];
  const models = machineModels(roomModels(pluginDir), setup);
  const warnings: string[] = [];
  if (setup.chime !== undefined) policy.owner.chime = setup.chime;
  if (setup.mailPort !== undefined) policy.mail.port = setup.mailPort;
  // changes made to the room's policy since the last setup stay, except the screen's keys
  const shipped = structuredClone(policy);
  const bySetup = [setup.chime !== undefined && "owner.chime", setup.mailPort !== undefined && "mail.port"];
  const changes = keptChanges(roomHome).filter((change) => !bySetup.includes(change.path.join(".")));
  warnings.push(...layOver(policy, changes));
  const { seats, enabled, used } = enabledSeats(seatsFile, models, setup);

  const tools = policy.paseoTools as Tools;
  for (const [role, names] of Object.entries(tools.allow)) {
    const unknown = names.filter((name) => !tools.all.includes(name)).sort();
    if (unknown.length)
      throw new Error(`paseo/policy.json: role ${role} allows unknown Paseo tools: ${unknown.join(", ")}`);
  }

  const catalogs = new Map<Harness, Record<string, CatalogModel> | null>();
  const catalogOf = async (harness: Harness) => {
    if (!catalogs.has(harness)) catalogs.set(harness, await catalog(harness));
    return catalogs.get(harness) ?? null;
  };

  const context: ProviderContext = {
    roomHome,
    policy,
    tools,
    restrictModels: seatsFile.restrictModels ?? true,
    used,
    catalogOf,
    warnings,
  };
  const providers: Record<string, ProviderEntry> = {};
  for (const id of enabled) providers[id] = await providerFor(id, context);
  const profiles = await profilesFor(shown, models, providers, catalogOf);

  return { seats, providers, profiles, models, policy, shipped, warnings, ownTools: ownAgentTools(policy) };
}

/** The Paseo tools of an agent of the owner's own CLIs, by CLI, when the policy keeps them to those the room's roles use; empty when it leaves them as the owner has them. */
export function ownAgentTools(policy: Record<string, any>): Record<string, PaseoTools> {
  if (policy.daemon?.ownAgentTools !== "roles") return {};
  const tools = policy.paseoTools as Tools;
  const used = new Set(Object.values(tools.allow).flat());
  const paseoTools = { enabled: true, disabledTools: tools.all.filter((tool) => !used.has(tool)) };
  return Object.fromEntries(HARNESSES.map((harness) => [harness, paseoTools]));
}
