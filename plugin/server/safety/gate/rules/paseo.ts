import { literal } from "../shell";
import type { Scene } from "../types";

/** The Paseo CLI: any command it names reaches other agents or the daemon, so only a call that names none runs. */

/** The command a `paseo` line names, or what stands in its place; null when it names none (`--help`, `--version`, `help`). */
export function paseoCommand(scene: Pick<Scene, "call">): string | null {
  // an option's value reads as a command too: a call that hides `send` behind `--home help` is stopped
  const named = scene.call.args.map(literal).filter((text) => text === null || !text.startsWith("-"));
  if (named.length === 0 || (named.length === 1 && named[0] === "help")) return null;
  return (named[0] ?? "a word known only at run time").slice(0, 40);
}
