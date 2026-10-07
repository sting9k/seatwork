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
  /** Two lenses that must differ; the first two of `pair`, then `pool`, never the same model twice. */
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
  return [
    `- one lens (oracle): \`${m.lens.oracle}\``,
    `- two lenses: \`${m.lens.pair.join("` and `")}\` — two different models, always`,
    `- more lenses: add from \`${m.lens.pool.join("`, `")}\`; never the same model twice in one run`,
    `- thinking \`${m.lens.thinking}\` on every lens`,
  ].join("\n");
}

/** The placeholder map for role prompts. */
export function promptVars(m: Models, params: RoomParams): Record<string, string> {
  const modes = Object.entries(m.modes).map(([h, mode]) => `${h} \`${mode}\``).join(", ");
  return {
    peer_table: peerTable(m),
    review_thinking: m.peer.reviewThinking,
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
