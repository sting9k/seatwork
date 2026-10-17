import { baseName } from "../normalize";
import { literal, type Word } from "../shell";
import type { Place, Scene } from "../types";

/** The Paseo CLI: any command it names reaches other agents or the daemon; a call that names none only prints. */

const CLI_PACKAGE = /(^|\/)@getpaseo\/cli\//;
const LIBRARY = /@getpaseo\/[\w.-]+/;
const LOOPBACK = String.raw`127(?:\.\d{1,3}){1,3}|localhost|::1|0\.0\.0\.0|0`;
let pattern: { key: string; re: RegExp | null } | null = null;

/** The command a `paseo` line names, or what stands in its place; null when it names none (`--help`, `--version`, `help`). */
export function paseoCommand(words: Word[]): string | null {
  // an option's value reads as a command too: a call that hides `send` behind `--home help` is caught
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

/** What names the daemon at a listen address: its port after a host of this machine, or its socket's path; null for none. */
function daemonPattern(listen: string | null | undefined, home: string): RegExp | null {
  if (!listen) return null;
  const key = `${listen}\0${home}`;
  if (pattern?.key === key) return pattern.re;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const socket = listen.startsWith("unix://") ? listen.slice(7) : /^[/~]/.test(listen) ? listen : null;
  let re: RegExp | null = null;
  if (socket) re = new RegExp(escape(socket.replace(/^~(?=\/|$)/, home)));
  else {
    const at = listen.lastIndexOf(":");
    const port = /^\d+$/.test(listen.trim()) ? listen.trim() : listen.slice(at + 1);
    const host = at < 0 ? "" : listen.slice(0, at).replace(/^\[(.*)\]$/, "$1");
    const named = host && !new RegExp(`^(?:${LOOPBACK}|::)$`).test(host) ? `${LOOPBACK}|${escape(host)}` : LOOPBACK;
    // a host only known at run time may be this machine
    const hosts = `${named}|\\$\\{?[A-Za-z_]\\w*\\}?`;
    if (/^\d+$/.test(port)) re = new RegExp(`(?<![\\w.:-])\\[?(?:${hosts})\\]?(?::|/|[\\s'",]+)${port}(?!\\d)`);
  }
  pattern = { key, re };
  return re;
}

/** How a text reaches the daemon, a program's by its client library too; null when it does not. */
export function reachesDaemon(text: string, place: Pick<Place, "daemon" | "home">, program = false): string | null {
  if (program) {
    const library = LIBRARY.exec(text);
    if (library) return `loads ${library[0]}`;
  }
  return daemonPattern(place.daemon, place.home)?.test(text) ? "names the daemon's address" : null;
}
