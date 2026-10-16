import table from "../../../../shared/safety/rewriters.json";
import { languageOf } from "../embedded";
import { literal } from "../shell";
import type { Scene } from "../types";

/** The formatters, fixers and patch of shared/safety/rewriters.json, which rewrite files of the folder they run in. */

/** One program of the table: the subcommands it needs, and the options that make it write or keep it read-only. */
interface Rewriter {
  program: string;
  sub?: string[];
  writes?: string[];
  keeps?: string[];
}

const BY_NAME = new Map<string, Rewriter[]>();
for (const entry of table.programs as Rewriter[])
  BY_NAME.set(entry.program, [...(BY_NAME.get(entry.program) ?? []), entry]);
const BIN_RUNNERS = new Set(["yarn", "pnpm"]);

/** Whether a command rewrites files where it runs: a program of the table in a writing mode, also as `yarn <bin>`, `pnpm <bin>` or `python -m <module>`. */
export function rewritesTree(scene: Scene): boolean {
  let name = scene.call.name ?? "";
  let texts = scene.call.args.map(literal);
  if (languageOf(name) === "python" && texts[0] === "-m" && texts[1]) {
    name = texts[1];
    texts = texts.slice(2);
  } else if (BIN_RUNNERS.has(name) && texts[0] && BY_NAME.has(texts[0])) {
    name = texts[0];
    texts = texts.slice(1);
  }
  const entries = BY_NAME.get(name);
  if (!entries) return false;
  const sub = texts.find((t) => t !== null && !t.startsWith("-") && !t.startsWith("+")) ?? null;
  const entry = entries.find((e) => !e.sub || (sub !== null && e.sub.includes(sub)));
  if (!entry) return false;
  const given = (options: string[] | undefined) =>
    options?.some((option) => texts.some((t, i) => t === option || `${t} ${texts[i + 1]}` === option)) ?? false;
  if (given(entry.keeps)) return false;
  return entry.writes ? given(entry.writes) : true;
}
