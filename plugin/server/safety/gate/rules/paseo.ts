import { baseName } from "../normalize";
import { literal, type Word } from "../shell";
import type { Scene } from "../types";

/** The Paseo CLI: any command it names reaches other agents or the daemon, so only a call that names none runs. */

const CLI_PACKAGE = /(^|\/)@getpaseo\/cli\//;

/** The command a `paseo` line names, or what stands in its place; null when it names none (`--help`, `--version`, `help`). */
export function paseoCommand(words: Word[]): string | null {
  // an option's value reads as a command too: a call that hides `send` behind `--home help` is stopped
  const named = words.map(literal).filter((text) => text === null || !text.startsWith("-"));
  if (named.length === 0 || (named.length === 1 && named[0] === "help")) return null;
  return (named[0] ?? "a word known only at run time").slice(0, 40);
}

/** Whether a path is the CLI by name: a file called `paseo`, or any file of its package, wherever it is installed. */
export const namesPaseo = (path: string): boolean => CLI_PACKAGE.test(path) || baseName(path) === "paseo";

/** Whether a program or script starts the CLI: it names it, or it is a link that leads to a file that does. */
export function startsPaseo(text: string | null, path: string | null, real: (path: string) => string | null): boolean {
  if ((text !== null && namesPaseo(text)) || (path !== null && namesPaseo(path))) return true;
  if (path === null || !path.includes("/")) return false;
  const target = real(path);
  return target !== null && target !== path && namesPaseo(target);
}

/** The words after the CLI when a command is it by name, or a package manager running its bin; null for any other command. */
export function cliWords(scene: Pick<Scene, "call">): Word[] | null {
  const { name, args } = scene.call;
  if (name === "paseo") return args;
  if (name !== "yarn" && name !== "pnpm") return null;
  const at = args.findIndex((w) => !(literal(w) ?? "-").startsWith("-"));
  return at >= 0 && literal(args[at]) === "paseo" ? args.slice(at + 1) : null;
}
