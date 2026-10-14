import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { storeFolder } from "../sqlite";
import { threadEntry } from "./envelope";
import type { Delivery, Message } from "./store";

/** A project's mail as files, one per mail and one per thread: for a reader, and for a rebuild. */

export interface Archived {
  message: Message;
  deliveries: Pick<Delivery, "seat" | "kind" | "priority">[];
}

const OPENING = "---json\n";
const CLOSING = "\n---\n";
const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "none";

export function messageFile(dir: string, message: Pick<Message, "id" | "at" | "signal">): string {
  return join(dir, message.at.slice(0, 7), `${message.id}-${safe(message.signal.toLowerCase())}.md`);
}

/** Writes a mail's file; returns its path. */
export function writeMessage(dir: string, entry: Archived): string {
  const { message } = entry;
  const file = messageFile(storeFolder(dir), message);
  mkdirSync(dirname(file), { recursive: true });
  const { body, ...head } = { ...message, file };
  const header = JSON.stringify({ ...head, to: entry.deliveries });
  writeFileSync(file, `${OPENING}${header}${CLOSING}# ${message.subject}\n\n${body.trim()}\n`);
  return file;
}

/** Adds a mail to its thread's file. */
export function appendThread(dir: string, message: Message, from: string, to: string): string {
  const file = join(storeFolder(dir), "threads", `${safe(message.thread)}.md`);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, `# Thread ${message.thread}\n\n`);
  appendFileSync(file, `${threadEntry(message, from, to)}\n`);
  return file;
}

export function threadFile(dir: string, thread: string): string | null {
  const file = join(dir, "threads", `${safe(thread)}.md`);
  return existsSync(file) ? file : null;
}

/** Every mail the folder holds, by id; a file that does not read as one is left out. */
export function readArchive(dir: string): Archived[] {
  if (!existsSync(dir)) return [];
  const found: Archived[] = [];
  for (const month of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    for (const name of readdirSync(join(dir, month))) {
      const text = readFileSync(join(dir, month, name), "utf8");
      const end = text.indexOf(CLOSING);
      if (!text.startsWith(OPENING) || end < 0) continue;
      try {
        const { to, ...head } = JSON.parse(text.slice(OPENING.length, end)) as Omit<Message, "body"> & {
          to: Archived["deliveries"];
        };
        const body = text
          .slice(end + CLOSING.length)
          .replace(/^# [^\n]*\n\n?/, "")
          .trimEnd();
        found.push({ message: { ...head, body }, deliveries: to });
      } catch {
        // not a mail this code wrote
      }
    }
  }
  return found.sort((a, b) => a.message.id - b.message.id);
}

/** Removes mail files that are no longer in the store. */
export function dropFiles(files: readonly string[]): void {
  for (const file of files) rmSync(file, { force: true });
}
