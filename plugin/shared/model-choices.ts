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
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** A model as the screen chooses it: agent CLI, model, thinking level ("" where the model has none). */
export interface ModelChoice {
  harness: string;
  model: string;
  thinking: string;
}

/** One of a role's models as the screen lists it; `more` counts further models under the same label. */
export interface TierChoice extends ModelChoice {
  label: string;
  use: string;
  more: number;
}

/** A tier's name: lower-case letters, digits and dashes, as it appears in the table the Lead reads. */
export const isTierLabel = (text: string): boolean => /^[a-z][a-z0-9-]*$/.test(text);

function parse(entry: string, thinking: string): ModelChoice {
  const slash = entry.indexOf("/"); // the model id may hold slashes of its own
  const provider = slash < 0 ? entry : entry.slice(0, slash);
  return {
    harness: provider.slice(0, provider.indexOf("-")),
    model: slash < 0 ? "" : entry.slice(slash + 1),
    thinking: thinking === "default" ? "" : thinking,
  };
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
  return merge(choices, {
    seats: { [role]: { provider: entryOf(role, choice), thinking: thinkingOf(choice) } },
  }) as Json;
}

/** The models a Peer or a Lens may run on, in the table's order: the ladder the Lead climbs. */
export function tierChoices(table: Table, role: TierRole): TierChoice[] {
  return Object.entries(table[role].tiers).map(([label, tier]) => ({
    label,
    use: tier.use ?? "",
    more: Math.max(0, tier.providers.length - 1),
    ...parse(tier.providers[0] ?? "", tier.thinking),
  }));
}

/** The choices with one of a role's models set; a new label is added after the others. */
export function chooseTier(choices: Json, role: TierRole, label: string, choice: ModelChoice, use?: string): Json {
  const tier = {
    providers: [entryOf(role, choice)],
    thinking: thinkingOf(choice),
    ...(use === undefined ? {} : { use, never: "—" }),
  };
  return merge(choices, { [role]: { tiers: { [label]: tier } } }) as Json;
}

/** The choices with one model taken out: `null` in place of a room's own, a plain drop for an added one. */
export function dropTier(choices: Json, room: Table, role: TierRole, label: string): Json {
  const group = isObject(choices[role]) ? (choices[role] as Json) : {};
  const tiers: Json = { ...(isObject(group.tiers) ? group.tiers : {}) };
  if (label in room[role].tiers) tiers[label] = null;
  else delete tiers[label];
  return { ...choices, [role]: { ...group, tiers } };
}

/** What applying would do to one of a role's models: nothing, change it, add it, or take it out. */
export type TierChange = "same" | "changed" | "added" | "removed";

/** A Peer's or a Lens's models in `next`, each marked by how it differs from `now`, then those it dropped. */
export function tierDiff(now: Table | null, next: Table, role: TierRole): (TierChoice & { change: TierChange })[] {
  const before = new Map((now ? tierChoices(now, role) : []).map((tier) => [tier.label, tier]));
  const same = (a: TierChoice, b: TierChoice) =>
    a.harness === b.harness && a.model === b.model && a.thinking === b.thinking && a.use === b.use;
  const after = tierChoices(next, role).map((tier) => {
    const was = before.get(tier.label);
    before.delete(tier.label);
    return { ...tier, change: (!now ? "same" : !was ? "added" : same(was, tier) ? "same" : "changed") as TierChange };
  });
  return [...after, ...[...before.values()].map((tier) => ({ ...tier, change: "removed" as TierChange }))];
}

/** Whether HQ, the Supervisor or the Lead would run on something else after applying. */
export function seatChanged(now: Table | null, next: Table, role: SeatRole): boolean {
  if (!now) return false;
  const [a, b] = [seatChoice(now, role), seatChoice(next, role)];
  return a.harness !== b.harness || a.model !== b.model || a.thinking !== b.thinking;
}

/** The roles a set of choices changes, in the screen's order. */
export function changedRoles(choices: Json): (SeatRole | TierRole)[] {
  const seats = isObject(choices.seats) ? choices.seats : {};
  return [
    ...SEAT_ROLES.filter((role) => role in seats),
    ...TIER_ROLES.filter((role) => isObject(choices[role]) && Object.keys(choices[role] as Json).length > 0),
  ];
}

/** The choices with nothing left for that role: it follows the table underneath again. */
export function clearRole(choices: Json, role: SeatRole | TierRole): Json {
  const next: Json = { ...choices };
  if (role === "peer" || role === "lens") {
    delete next[role];
    return next;
  }
  const seats: Json = { ...(isObject(next.seats) ? next.seats : {}) };
  delete seats[role];
  if (Object.keys(seats).length) next.seats = seats;
  else delete next.seats;
  return next;
}

/** Whether two sets of choices are the same, whatever order their keys were written in. */
export function sameChoices(a: unknown, b: unknown): boolean {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : isObject(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, ordered(value[key])]),
          )
        : value;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}
