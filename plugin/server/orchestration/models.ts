import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR } from "../paths";
import type { RoomParams } from "../policy";
import { merge } from "../../shared/model-choices";
import { rolesWhere, tableNote, traits, VARS } from "../../shared/workflow";
import { clip, type Asker } from "./forks";

/** room/models.json: every model id the room uses; role prompts carry {{placeholders}} filled from it. */

interface SeatModel {
  provider: string;
  thinking: string;
  alternatives?: string[];
}

/** One of a role's models: what its Owner picks it for, and never for. */
interface Tier {
  providers: string[];
  thinking: string;
  use: string;
  never: string;
}

/** A role of several models: its tiers, beside the table's own words about them. */
interface TierGroup {
  tiers: Record<string, Tier>;
  [word: string]: unknown;
}

/** The table: `seats` holds the roles of one model each; a role of several models has its own entry of tiers. */
export type Models = { seats: Record<string, SeatModel>; modes: Record<string, string | null> } & Record<
  string,
  unknown
>;

const MODELS_FILE = join(ROOM_DIR, "models.json");

/** The room's table, read from room/models.json. */
export function loadModels(): Models {
  if (!existsSync(MODELS_FILE)) throw new Error(`seatwork: ${MODELS_FILE} not found; set the room up again`);
  return JSON.parse(readFileSync(MODELS_FILE, "utf8")) as Models;
}

/** A role's entry when it is one of several models. */
export const tiersOf = (m: Models, role: string): TierGroup | undefined => {
  const group = m[role] as TierGroup | undefined;
  return group && typeof group === "object" && group.tiers ? group : undefined;
};

/** A role's models as its Owner reads them: one row a tier, in the table's order. */
function tierTable(tiers: Record<string, Tier>): string {
  const rows = Object.entries(tiers).map(
    ([tier, t]) =>
      `| ${tier} | ${t.providers.map((p) => `\`${p}\``).join(" · ")} | ${t.thinking} | ${t.use ?? "—"} | ${t.never ?? "—"} |`,
  );
  return [
    "| Tier | `provider` for `create_agent` | thinking | Use for | Never for |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

const listed = (entries: readonly string[] | undefined) => (entries ?? []).map((p) => `\`${p}\``).join(", ") || "none";
const snake = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** A param as prompts quote it: `readBudgetTokens` is {{read_budget}}, shown as ~80k. */
function paramVar(name: string, value: string | number): [string, string] {
  const unit = /(Minutes|Tokens)$/.exec(name)?.[1];
  const key = snake(unit ? name.slice(0, -unit.length) : name);
  if (typeof value !== "number") return [key, value];
  return [key, unit === "Tokens" ? `~${Math.round(value / 1000)}k` : value.toLocaleString("en-US")];
}

/** The placeholder map for role prompts. */
export function promptVars(m: Models, params: RoomParams): Record<string, string> {
  const vars: Record<string, string> = {};
  const withMode = Object.entries(m.modes)
    .filter(([, mode]) => mode)
    .map(([h, mode]) => `${h} \`${mode}\``);
  const without = Object.entries(m.modes)
    .filter(([, mode]) => !mode)
    .map(([h]) => h);
  vars.modes = [withMode.join(", "), without.length ? `${without.join(", ")}: none, omit \`modeId\`` : ""]
    .filter(Boolean)
    .join("; ");
  for (const role of rolesWhere((role) => role.models === "one")) {
    const seat = m.seats[role];
    if (!seat) continue;
    vars[`${role}_provider`] = seat.provider;
    vars[`${role}_thinking`] = seat.thinking;
    vars[`${role}_alternatives`] = listed(seat.alternatives);
  }
  for (const role of rolesWhere((role) => role.models === "tiers")) {
    const group = tiersOf(m, role);
    if (!group) continue;
    const models = new Set(Object.values(group.tiers).flatMap((tier) => tier.providers)).size;
    vars[`${role}_table`] = [tierTable(group.tiers), tableNote(role, models)].filter(Boolean).join("\n\n");
    // the table's own words about a role: reviewThinking is {{review_thinking}}
    for (const [word, value] of Object.entries(group)) if (typeof value === "string") vars[snake(word)] = value;
  }
  for (const [name, from] of Object.entries(VARS)) {
    const tiers = Object.entries(tiersOf(m, from.role)?.tiers ?? {});
    vars[name] = listed(tiers.filter(([tier]) => !from.except.includes(tier)).flatMap(([, t]) => t.providers));
  }
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) {
      const [key, shown] = paramVar(name, value);
      vars[key] = shown;
    }
  return vars;
}

/** Replaces {{name}} with vars[name]; an unknown name is left as it is and reported. */
export function render(text: string, vars: Record<string, string>, onMissing?: (name: string) => void): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => {
    if (name in vars) return vars[name];
    onMissing?.(name);
    return whole;
  });
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every `<harness>-<role>/<model>` a role may run on, as the table names them. */
export function allowed(m: Models): Record<string, string[]> {
  return Object.fromEntries(
    rolesWhere(() => true).map((role) => {
      const seat = m.seats?.[role];
      return [
        role,
        traits(role).models === "one"
          ? seat
            ? [seat.provider, ...(seat.alternatives ?? [])]
            : []
          : Object.values(tiersOf(m, role)?.tiers ?? {}).flatMap((t) => t.providers ?? []),
      ];
    }),
  );
}

const providerOf = (entry: string): string => String(entry).split("/")[0];

/** The room's table with `override` laid over it, checked for everything but whether its seats exist. */
function laidOver(override: unknown, where: string): Models {
  return layModels(loadModels(), override, where);
}

/** `base` with `override` laid over it: objects merge, other values replace, null removes a key. */
export function layModels(base: Models, override: unknown, where: string): Models {
  if (!isObject(override)) throw new Error(`${where}: "models" must be an object shaped like ${MODELS_FILE}`);
  const merged = merge(base, override) as Models;
  for (const [role, entries] of Object.entries(allowed(merged))) {
    if (entries.length === 0) throw new Error(`${where}: "models" leaves the ${role} role without a model`);
    for (const entry of entries) {
      if (!String(entry).includes("/")) throw new Error(`${where}: "${entry}" must be <harness>-<role>/<model>`);
      if (!providerOf(entry).endsWith(`-${role}`))
        throw new Error(`${where}: "${entry}" is listed for ${role} but is not a ${role} seat`);
    }
  }
  return merged;
}

/** The room's table under a project's `models`; throws, naming the entry, when unusable. */
export function projectModels(override: unknown, enabledProviders: string[], where: string): Models {
  if (override === undefined) return loadModels();
  const merged = laidOver(override, where);
  for (const entry of Object.values(allowed(merged)).flat()) {
    const provider = providerOf(entry);
    if (!enabledProviders.includes(provider))
      throw new Error(
        `${where}: "${entry}" names ${provider}, which the room has not enabled (enabled: ${enabledProviders.join(", ")})`,
      );
  }
  return merged;
}

/** The seats a project's `models` names that the room does not have yet. */
export function missingSeats(override: unknown, enabledProviders: string[], where: string): string[] {
  if (override === undefined) return [];
  const named = Object.values(allowed(laidOver(override, where)))
    .flat()
    .map(providerOf);
  return [...new Set(named)].filter((provider) => !enabledProviders.includes(provider));
}

const split = (entry: string): [provider: string, model: string] => {
  // the model id may hold slashes of its own
  const slash = entry.indexOf("/");
  return [entry.slice(0, slash), entry.slice(slash + 1)];
};

/** Whether a seat about to be created runs on a model the table lists for its role. */
export function modelAllowed(
  m: Models,
  role: string,
  provider: string,
  model: string | undefined,
): { ok: boolean; listed: string[] } {
  const listed = allowed(m)[role] ?? [];
  const ok = listed.some((entry) => {
    const [seat, id] = split(entry);
    return seat === provider && (!model || model === id || model.startsWith(`${id}-`));
  });
  return { ok, listed };
}

/** What the table in force makes of a seat about to be created. */
export type SeatFit = { ok: true; model?: string; thinking?: string } | { ok: false; listed: string[] };

/** Holds a new seat to the table in force, whatever model its creator's prompt names. */
export function fitSeat(m: Models, role: string, provider: string, model: string | undefined): SeatFit {
  const listed = allowed(m)[role] ?? [];
  const mine = listed.filter((entry) => split(entry)[0] === provider);
  if (mine.length === 0) return { ok: false, listed };
  if (model && modelAllowed(m, role, provider, model).ok) return { ok: true };
  const seat = traits(role).models === "one" ? m.seats[role] : null;
  if (seat) {
    const [first, id] = split(seat.provider);
    return first === provider
      ? { ok: true, model: id, thinking: seat.thinking }
      : { ok: true, model: split(mine[0])[1] };
  }
  // a role of several models asked for by seat alone starts on that seat's first model in the table
  return model ? { ok: false, listed } : { ok: true, model: split(mine[0])[1] };
}

/** A tier's model on one provider, with what the tier is for. */
interface TierModel {
  tier: string;
  model: string;
  use: string | null;
}

/** The tiers of a role that list a model on this provider, in the table's order. */
export function tiersOn(m: Models, role: string, provider: string): TierModel[] {
  return Object.entries(tiersOf(m, role)?.tiers ?? {}).flatMap(([tier, one]) => {
    const entry = (one.providers ?? []).find((listed) => providerOf(listed) === provider);
    return entry ? [{ tier, model: split(entry)[1], use: typeof one.use === "string" ? one.use : null }] : [];
  });
}

/** The model of the next tier up on the same provider, as the table orders its tiers; undefined where there is none. */
export function stepUp(m: Models, role: string, provider: string, model: string): string | undefined {
  const tiers = tiersOn(m, role, provider);
  const at = tiers.findIndex((one) => model === one.model || model.startsWith(`${one.model}-`));
  return at < 0 ? undefined : tiers[at + 1]?.model;
}

/** What a seat about to start is for, as its creator gave it. */
export interface SeatTask {
  title?: string | null;
  spec?: string;
  brief?: string;
}

/** The model of the tier the decision model is sure fits the work, for a seat whose creator named none; undefined keeps the table's first. */
export async function pickModel(
  forks: Asker,
  m: Models,
  role: string,
  provider: string,
  task: SeatTask,
): Promise<string | undefined> {
  const tiers = tiersOn(m, role, provider);
  const [title, brief] = [task.title?.trim(), task.brief?.trim()];
  if (traits(role).models !== "tiers" || tiers.length < 2 || (!title && !brief) || !forks.open("tier"))
    return undefined;
  const state = {
    ...(title ? { title: clip(title, 300) } : {}),
    ...(task.spec ? { spec: task.spec } : {}),
    ...(brief ? { brief: clip(brief, 1500) } : {}),
  };
  const label = await forks.take("tier", state, Object.fromEntries(tiers.map(({ tier, use }) => [tier, use])));
  return tiers.find(({ tier }) => tier === label)?.model;
}
