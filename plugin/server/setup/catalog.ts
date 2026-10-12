import { paseoCli } from "../cli";
import type { PaseoApi } from "../paseo";
import type { Harness } from "../seats";
import type { Catalog, CatalogModel } from "./plan";

/** The catalogs as the `paseo` CLI lists them; null when the daemon does not answer. */
export const cliCatalog: Catalog = async (harness) => {
  try {
    const rows = JSON.parse(await paseoCli(["provider", "models", harness, "--json"])) as {
      id: string;
      model?: string;
      description?: string;
      thinkingOptionIds?: string[];
      defaultThinkingOptionId?: string | null;
    }[];
    return Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          label: row.model ?? row.id,
          description: row.description,
          thinking: row.thinkingOptionIds ?? [],
          defaultThinking: row.defaultThinkingOptionId ?? undefined,
        },
      ]),
    );
  } catch {
    return null;
  }
};

export interface HarnessState {
  id: Harness;
  label: string;
  available: boolean;
  why: string;
  models: Record<string, CatalogModel>;
}

/** Every harness as the running daemon sees it. Discovery is lazy: a snapshot taken at once would say "loading". */
export async function harnessStates(paseo: PaseoApi, harnesses: readonly Harness[]): Promise<HarnessState[]> {
  const snapshot = await paseo.providers.waitForReady({ timeoutMs: 30_000 });
  return harnesses.map((id) => {
    const entry = snapshot.entries.find((e) => e.provider === id);
    const models = Object.fromEntries(
      (entry?.models ?? []).map((m) => [
        m.id,
        {
          label: m.label,
          description: m.description,
          thinking: (m.thinkingOptions ?? []).map((o) => o.id),
          defaultThinking: m.defaultThinkingOptionId,
        },
      ]),
    );
    return {
      id,
      label: entry?.label ?? id,
      available: entry?.status === "ready" && entry.enabled !== false,
      why: entry ? (entry.error ?? entry.status) : "this Paseo does not know it",
      models,
    };
  });
}

/** A catalog read from harness states already fetched. */
export function catalogFrom(states: HarnessState[]): Catalog {
  return async (harness) => {
    const state = states.find((s) => s.id === harness);
    return state?.available && Object.keys(state.models).length ? state.models : null;
  };
}
