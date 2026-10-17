import type { PaseoApi } from "../api";
import type { Harness } from "../../orchestration/seats";
import type { Catalog, CatalogModel } from "./plan";

/** An agent CLI as the running daemon sees it: ready or not, and the models it lists. */
interface HarnessState {
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
