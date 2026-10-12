/** One of a role's models in the table: what the Lead picks it for. */
export interface TableTier {
  providers: string[];
  thinking: string;
  use?: string;
  never?: string;
}

/** The model table as the setup screen reads it: room/models.json, or that with choices laid over it. */
export interface Table {
  seats: Record<string, { provider: string; thinking: string }>;
  peer: { tiers: Record<string, TableTier> };
  lens: { tiers: Record<string, TableTier> };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Objects merge key by key, anything else replaces; `null` removes a key (a Peer tier, say). */
export function merge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else out[key] = merge(base[key], value);
  }
  return out;
}

/** The roles with one seat and one model each, and the roles that are one seat with several models. */
export const SEAT_ROLES = ["hq", "supervisor", "lead"] as const;
export const TIER_ROLES = ["peer", "lens"] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];
export type TierRole = (typeof TIER_ROLES)[number];

/** A model as the screen chooses it: the agent CLI, the model, the thinking level ("" where the model has none). */
export interface ModelChoice {
  harness: string;
  model: string;
  thinking: string;
}

/** One of a role's models as the screen lists it. */
export interface TierChoice extends ModelChoice {
  /** Its name in the table: cheap, default, high… */
  label: string;
  use: string;
  /** Further models the table lists under the same label; the screen shows and writes the first. */
  more: number;
}

/** A tier's name: lower-case letters, digits and dashes, as it appears in the table the Lead reads. */
export const isTierLabel = (text: string): boolean => /^[a-z][a-z0-9-]*$/.test(text);

function parse(entry: string, thinking: string): ModelChoice {
  const slash = entry.indexOf("/"); // the model id may hold slashes of its own
  const provider = slash < 0 ? entry : entry.slice(0, slash);
  return { harness: provider.slice(0, provider.indexOf("-")), model: slash < 0 ? "" : entry.slice(slash + 1), thinking: thinking === "default" ? "" : thinking };
}

const entryOf = (role: string, choice: ModelChoice) => `${choice.harness}-${role}/${choice.model}`;
/** A model without thinking options carries none: "default" tells the prompts to leave it out. */
const thinkingOf = (choice: ModelChoice) => choice.thinking || "default";

/** What HQ, the Supervisor or the Lead runs on. */
export function seatChoice(table: Table, role: SeatRole): ModelChoice {
  return parse(table.seats[role].provider, table.seats[role].thinking);
}

/** The choices with that role's model set: differences from the room's table, in the table's shape. */
export function chooseSeat(choices: Json, role: SeatRole, choice: ModelChoice): Json {
  return merge(choices, { seats: { [role]: { provider: entryOf(role, choice), thinking: thinkingOf(choice) } } }) as Json;
}

/** The models a Peer or a Lens may run on, in the table's order: the order is the ladder the Lead climbs. */
export function tierChoices(table: Table, role: TierRole): TierChoice[] {
  return Object.entries(table[role].tiers).map(([label, tier]) => ({ label, use: tier.use ?? "", more: Math.max(0, tier.providers.length - 1), ...parse(tier.providers[0] ?? "", tier.thinking) }));
}

/** The choices with one of a role's models set; a label the table does not have yet is added after the others. */
export function chooseTier(choices: Json, role: TierRole, label: string, choice: ModelChoice, use?: string): Json {
  const tier = { providers: [entryOf(role, choice)], thinking: thinkingOf(choice), ...(use === undefined ? {} : { use, never: "—" }) };
  return merge(choices, { [role]: { tiers: { [label]: tier } } }) as Json;
}

/**
 * The choices with one of a role's models taken out. A model of the room's own table is removed
 * by a `null` in its place; one the choices added is simply dropped from them.
 */
export function dropTier(choices: Json, room: Table, role: TierRole, label: string): Json {
  const group = isObject(choices[role]) ? (choices[role] as Json) : {};
  const tiers: Json = { ...(isObject(group.tiers) ? group.tiers : {}) };
  if (label in room[role].tiers) tiers[label] = null;
  else delete tiers[label];
  return { ...choices, [role]: { ...group, tiers } };
}

/** Whether two sets of choices are the same, whatever order their keys were written in. */
export function sameChoices(a: unknown, b: unknown): boolean {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(ordered) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
