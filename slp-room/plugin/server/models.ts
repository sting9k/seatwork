import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOM_DIR } from "./paths";
import type { RoomParams } from "./policy";

/**
 * room/models.json: every model id the room uses, in one editable file. Role
 * prompts never name a model; they carry {{placeholders}} that render() fills
 * from this file at seat creation, so a model change needs no prompt edit.
 */

export interface SeatModel {
  provider: string;
  thinking: string;
  alternatives?: string[];
}

export interface PeerTier {
  providers: string[];
  thinking: string;
  use: string;
  never: string;
}

export interface LensModels {
  /** One lens, the second brain. */
  oracle: string;
  /** The one lens for a hard question, when the table keeps a stronger model for it. */
  hard?: string;
  /** Two lenses that must differ: the first two of `pair`. More come from `pool`; a pool entry that repeats a pair model is a second lens on that model. */
  pair: string[];
  pool: string[];
  thinking: string;
}

export interface Models {
  seats: { hq: SeatModel; supervisor: SeatModel; lead: SeatModel };
  peer: { tiers: Record<string, PeerTier>; reviewThinking: string };
  lens: LensModels;
  modes: Record<string, string>;
}

export const MODELS_FILE = join(ROOM_DIR, "models.json");

export function loadModels(): Models {
  if (!existsSync(MODELS_FILE)) throw new Error(`slp-seat: ${MODELS_FILE} not found; run install.sh`);
  return JSON.parse(readFileSync(MODELS_FILE, "utf8")) as Models;
}

function peerTable(m: Models): string {
  const rows = Object.entries(m.peer.tiers).map(([tier, t]) => `| ${tier} | ${t.providers.map((p) => `\`${p}\``).join(" · ")} | ${t.thinking} | ${t.use} | ${t.never} |`);
  return ["| Tier | `provider` for `create_agent` | thinking | Use for | Never for |", "|---|---|---|---|---|", ...rows].join("\n");
}

function lensTable(m: Models): string {
  // the table decides whether a model may sit twice in one run: only by listing it in the pool as well as in the pair
  const repeats = m.lens.pool.some((p) => m.lens.pair.includes(p));
  return [
    `- one lens (oracle): \`${m.lens.oracle}\`${m.lens.hard ? `; a hard question: \`${m.lens.hard}\`` : ""}`,
    `- two lenses: \`${m.lens.pair.join("` and `")}\` — two different models, always`,
    `- more lenses: add from \`${m.lens.pool.join("`, `")}\`; ${repeats ? "a model that sits twice gets two different angles" : "never the same model twice in one run"}`,
    `- thinking \`${m.lens.thinking}\` on every lens`,
  ].join("\n");
}

/** The placeholder map for role prompts. */
export function promptVars(m: Models, params: RoomParams): Record<string, string> {
  const modes = Object.entries(m.modes).map(([h, mode]) => `${h} \`${mode}\``).join(", ");
  return {
    peer_table: peerTable(m),
    review_thinking: m.peer.reviewThinking,
    // read-only research never runs on the cheap tier
    research_providers: Object.entries(m.peer.tiers).filter(([tier]) => tier !== "cheap").flatMap(([, t]) => t.providers).map((p) => `\`${p}\``).join(", ") || "none",
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

/* ---------- per-project models: the `models` object of <project>/.slp/room.json ---------- */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key, anything else replaces; `null` removes a key (a Peer tier, say). */
function merge(base: unknown, over: unknown): unknown {
  if (!isObject(base) || !isObject(over)) return over;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else out[key] = merge(base[key], value);
  }
  return out;
}

/** Every `<harness>-<role>/<model>` a role may run on, as the table names them. */
function allowed(m: Models): Record<string, string[]> {
  const seat = (s: SeatModel | undefined) => (s ? [s.provider, ...(s.alternatives ?? [])] : []);
  return {
    hq: seat(m.seats?.hq),
    supervisor: seat(m.seats?.supervisor),
    lead: seat(m.seats?.lead),
    peer: Object.values(m.peer?.tiers ?? {}).flatMap((t) => t.providers ?? []),
    lens: [m.lens?.oracle, m.lens?.hard, ...(m.lens?.pair ?? []), ...(m.lens?.pool ?? [])].filter((p): p is string => typeof p === "string"),
  };
}

/**
 * The room's table with a project's own `models` laid over it. Throws, naming
 * the entry, when the result names a seat that is not enabled, puts a provider
 * in another role's slot, or leaves a role without a model: the file is edited
 * by hand, so the error has to say what to fix.
 */
export function projectModels(override: unknown, enabledProviders: string[], where: string): Models {
  const base = loadModels();
  if (override === undefined) return base;
  if (!isObject(override)) throw new Error(`${where}: "models" must be an object shaped like ${MODELS_FILE}`);
  const merged = merge(base, override) as Models;
  for (const [role, entries] of Object.entries(allowed(merged))) {
    if (entries.length === 0) throw new Error(`${where}: "models" leaves the ${role} role without a model`);
    for (const entry of entries) {
      const provider = String(entry).split("/")[0];
      if (!String(entry).includes("/")) throw new Error(`${where}: "${entry}" must be <harness>-<role>/<model>`);
      if (!provider.endsWith(`-${role}`)) throw new Error(`${where}: "${entry}" is listed for ${role} but is not a ${role} seat`);
      if (!enabledProviders.includes(provider)) throw new Error(`${where}: "${entry}" names ${provider}, which the room has not enabled (enabled: ${enabledProviders.join(", ")})`);
    }
  }
  if (merged.lens.pair.length < 2 || new Set(merged.lens.pair).size < 2) throw new Error(`${where}: lens.pair must be two different models`);
  return merged;
}

/** Whether a seat about to be created runs on a model its project's table lists for its role. */
export function modelAllowed(m: Models, role: string, provider: string, model: string | undefined): { ok: boolean; listed: string[] } {
  const listed = allowed(m)[role] ?? [];
  const ok = listed.some((entry) => {
    const slash = entry.indexOf("/"); // the model id may hold slashes of its own
    const id = entry.slice(slash + 1);
    return entry.slice(0, slash) === provider && (!model || model === id || model.startsWith(`${id}-`));
  });
  return { ok, listed };
}
