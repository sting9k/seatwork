import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR } from "./paths";
import type { RoomParams } from "./policy";
import { merge } from "../shared/model-choices";

/** room/models.json: every model id the room uses; role prompts carry {{placeholders}} filled from it. */

export interface SeatModel {
  provider: string;
  thinking: string;
  alternatives?: string[];
}

/** One of a role's models: what the Lead picks it for, and never for. */
export interface Tier {
  providers: string[];
  thinking: string;
  use: string;
  never: string;
}

export interface Models {
  seats: { hq: SeatModel; supervisor: SeatModel; lead: SeatModel };
  peer: { tiers: Record<string, Tier>; reviewThinking: string };
  lens: { tiers: Record<string, Tier> };
  modes: Record<string, string | null>;
}

export const MODELS_FILE = join(ROOM_DIR, "models.json");

export function loadModels(): Models {
  if (!existsSync(MODELS_FILE)) throw new Error(`seatwork: ${MODELS_FILE} not found; set the room up again`);
  return JSON.parse(readFileSync(MODELS_FILE, "utf8")) as Models;
}

/** A role's models as the Lead reads them: one row a tier, in the table's order. */
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

function lensTable(m: Models): string {
  const models = new Set(Object.values(m.lens.tiers).flatMap((tier) => tier.providers)).size;
  const several =
    models > 1
      ? "Two lenses are two different models, always. More lenses: another model for each while the table has one; after that a model sits twice only on two different angles."
      : "The table has one lens model: open one lens.";
  return `${tierTable(m.lens.tiers)}\n\n${several}`;
}

/** The placeholder map for role prompts. */
export function promptVars(m: Models, params: RoomParams): Record<string, string> {
  const withMode = Object.entries(m.modes)
    .filter(([, mode]) => mode)
    .map(([h, mode]) => `${h} \`${mode}\``);
  const without = Object.entries(m.modes)
    .filter(([, mode]) => !mode)
    .map(([h]) => h);
  const modes = [withMode.join(", "), without.length ? `${without.join(", ")}: none, omit \`modeId\`` : ""]
    .filter(Boolean)
    .join("; ");
  return {
    peer_table: tierTable(m.peer.tiers),
    review_thinking: m.peer.reviewThinking,
    // read-only research never runs on the cheap tier
    research_providers:
      Object.entries(m.peer.tiers)
        .filter(([tier]) => tier !== "cheap")
        .flatMap(([, t]) => t.providers)
        .map((p) => `\`${p}\``)
        .join(", ") || "none",
    lens_table: lensTable(m),
    modes,
    lead_provider: m.seats.lead.provider,
    lead_thinking: m.seats.lead.thinking,
    lead_alternatives: (m.seats.lead.alternatives ?? []).map((p) => `\`${p}\``).join(", ") || "none",
    supervisor_provider: m.seats.supervisor.provider,
    supervisor_thinking: m.seats.supervisor.thinking,
    supervisor_alternatives: (m.seats.supervisor.alternatives ?? []).map((p) => `\`${p}\``).join(", ") || "none",
    heartbeat_cron: params.heartbeatCron,
    peer_stall: String(params.peerStallMinutes),
    review_stall: String(params.reviewStallMinutes),
    lead_stall: String(params.leadStallMinutes),
    read_budget: `~${Math.round(params.readBudgetTokens / 1000)}k`,
    cheap_read_budget: `~${Math.round(params.cheapReadBudgetTokens / 1000)}k`,
  };
}

/** Replace {{name}} with vars[name]; an unknown name is left as-is and reported. */
export function render(text: string, vars: Record<string, string>, onMissing?: (name: string) => void): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => {
    if (name in vars) return vars[name];
    onMissing?.(name);
    return whole;
  });
}

/* ---------- per-project models: the `models` object of <project>/.seatwork/room.json ---------- */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every `<harness>-<role>/<model>` a role may run on, as the table names them. */
export function allowed(m: Models): Record<string, string[]> {
  const seat = (s: SeatModel | undefined) => (s ? [s.provider, ...(s.alternatives ?? [])] : []);
  return {
    hq: seat(m.seats?.hq),
    supervisor: seat(m.seats?.supervisor),
    lead: seat(m.seats?.lead),
    peer: Object.values(m.peer?.tiers ?? {}).flatMap((t) => t.providers ?? []),
    lens: Object.values(m.lens?.tiers ?? {}).flatMap((t) => t.providers ?? []),
  };
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
  // a table from before the lenses were listed like Peers would read as unchanged
  const old = ["oracle", "hard", "pair", "pool"].find((key) => key in merged.lens);
  if (old)
    throw new Error(
      `${where}: lens.${old} is not a place in the table: lenses are listed under lens.tiers, as Peers are under peer.tiers`,
    );
  return merged;
}

/** The room's table with a project's `models` laid over it; throws, naming the entry, when it cannot be used. */
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
  const slash = entry.indexOf("/"); // the model id may hold slashes of its own
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

/** Holds a new seat to the table in force, not to its creator's prompt, which may be older than the table. */
export function fitSeat(m: Models, role: string, provider: string, model: string | undefined): SeatFit {
  const listed = allowed(m)[role] ?? [];
  const mine = listed.filter((entry) => split(entry)[0] === provider);
  if (mine.length === 0) return { ok: false, listed };
  if (model && modelAllowed(m, role, provider, model).ok) return { ok: true };
  const seat = role === "hq" || role === "supervisor" || role === "lead" ? m.seats[role] : null;
  if (seat) {
    const [first, id] = split(seat.provider);
    return first === provider
      ? { ok: true, model: id, thinking: seat.thinking }
      : { ok: true, model: split(mine[0])[1] };
  }
  // a Peer or a Lens asked for by seat alone starts on that seat's first model in the table
  return model ? { ok: false, listed } : { ok: true, model: split(mine[0])[1] };
}
