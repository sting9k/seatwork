import { posix } from "node:path";
import table from "../../../../shared/safety/protected.json";
import { within } from "../paths";

/** The keys the daemon and the room hold, which no seat reads: with them a program is the daemon's owner or spends the room's keys. */

const NAMED = table.secrets.named;
const FOLDER_READERS = new Set(["rg", "ag", "ack", "tar", "zip", "rsync", "scp", "ditto", "cpio", "7z"]);
const COPIES = new Set(["cp", "rsync", "scp", "ditto"]);
let spelled: { key: string; re: RegExp } | null = null;

/** A machine's secrets: the daemon's files in its home and the room's key folders, each folder ending in "/". */
export function secretsOf(paseoHome: string, roomHome: string): string[] {
  return [
    ...table.secrets.paseoHome.map((name) => posix.join(paseoHome, name)),
    ...table.secrets.roomHome.map((name) => `${posix.join(roomHome, name)}/`),
  ];
}

/** The secret an absolute path is or lies in, or, for a command that reads whole folders, one its folder holds; null for none. */
export function secretAt(path: string, secrets: readonly string[], folders: boolean): string | null {
  const norm = posix.normalize(path);
  const found = secrets.find((s) => (s.endsWith("/") ? `${norm}/`.startsWith(s) : norm === s));
  if (found) return found;
  return folders ? (secrets.find((s) => within(s, norm)) ?? null) : null;
}

/** Which arguments of a command it reads whole when they are folders: a search's, an archive's it makes, a recursing copy's sources but not where it copies to. */
export function readsFolders(name: string | null, args: readonly (string | null)[]): (at: number) => boolean {
  const recursive = args.some((a) => a !== null && (/^-[A-Za-z]*[rRa]/.test(a) || /^--(recursive|archive)$/.test(a)));
  const reads =
    (name !== null && FOLDER_READERS.has(name) && !(name === "tar" && /^-?[A-Za-z]*x/.test(args[0] ?? ""))) ||
    (recursive && name !== null && ["grep", "egrep", "fgrep", "zgrep", "cp"].includes(name));
  if (!reads) return () => false;
  const last = args.findLastIndex((a) => a !== null && !a.startsWith("-"));
  return COPIES.has(name!) ? (at) => at !== last : () => true;
}

/** How a text names a secret: its path in full, under `~` or `$HOME`, or a name only the daemon uses; null for none. */
export function namesSecret(text: string, secrets: readonly string[], home: string): string | null {
  const key = `${home}\0${secrets.join("\0")}`;
  if (spelled?.key !== key) {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ways = secrets.flatMap((s) => {
      const path = s.replace(/\/$/, "");
      if (!within(path, home) || path === home) return [escape(path)];
      const rest = escape(posix.relative(home, path));
      return [escape(path), `(?:~|\\$HOME|\\$\\{HOME\\})/${rest}`];
    });
    const names = NAMED.map((name) => `(?<![\\w.-])${escape(name)}(?![\\w-])`);
    spelled = { key, re: new RegExp([...ways.map((way) => `${way}(?![\\w.-])`), ...names].join("|")) };
  }
  return spelled.re.exec(text)?.[0] ?? null;
}
