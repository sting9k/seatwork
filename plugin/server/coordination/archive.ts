import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { keptOutOfGit } from "../sqlite";
import { threadEntry } from "./envelope";
import type { Delivery, Message } from "./store";

/** A project's mail as files, one per mail and one per thread: for a reader, and for a rebuild. */

export interface Archived {
  message: Message;
  deliveries: Pick<Delivery, "seat" | "kind" | "priority" | "quiet">[];
}

/** How deliveries settled and which asks were answered, from the journal beside the files. */
export interface Settled {
  states: Map<string, Delivery["state"]>;
  answers: Map<number, { at: string; by: number | null }>;
}

const OPENING = "---json\n";
const CLOSING = "\n---\n";
/** A name as a file name: each odd character, `_` too, written as `_` and its code; a long one cut, with a digest so two never share. */
function safe(name: string): string {
  const written = name.replace(/[^A-Za-z0-9.-]/g, (char) => `_${char.codePointAt(0)!.toString(16)}`) || "none";
  return written.length <= 120
    ? written
    : `${written.slice(0, 100)}-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}
const JOURNAL = "states.jsonl";

/** Notes in the journal that a delivery settled, or that an ask was answered. */
export function noteSettled(
  dir: string,
  line: { id: number; seat?: string; state?: string; answeredBy?: number | null; at: string },
): void {
  appendFileSync(join(keptOutOfGit(dir), JOURNAL), `${JSON.stringify(line)}\n`);
}

export function readSettled(dir: string): Settled {
  const settled: Settled = { states: new Map(), answers: new Map() };
  const file = join(dir, JOURNAL);
  if (!existsSync(file)) return settled;
  for (const text of readFileSync(file, "utf8").split("\n")) {
    try {
      const line = JSON.parse(text) as {
        id: number;
        seat?: string;
        state?: Delivery["state"];
        answeredBy?: number | null;
        at: string;
      };
      if (line.seat && line.state) settled.states.set(`${line.id}|${line.seat}`, line.state);
      if ("answeredBy" in line) settled.answers.set(line.id, { at: line.at, by: line.answeredBy ?? null });
    } catch {
      // a torn last line
    }
  }
  return settled;
}

/** Drops the journal lines of mail that is gone. */
export function forgetSettled(dir: string, ids: ReadonlySet<number>): void {
  const file = join(dir, JOURNAL);
  if (ids.size === 0 || !existsSync(file)) return;
  const kept = readFileSync(file, "utf8")
    .split("\n")
    .filter((text) => {
      try {
        return text.trim() !== "" && !ids.has((JSON.parse(text) as { id: number }).id);
      } catch {
        return false;
      }
    });
  writeFileSync(`${file}.tmp`, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  renameSync(`${file}.tmp`, file);
}

function messageFile(dir: string, message: Pick<Message, "id" | "at" | "signal">): string {
  return join(dir, message.at.slice(0, 7), `${message.id}-${safe(message.signal.toLowerCase())}.md`);
}

/** Writes a mail's file; returns its path. */
export function writeMessage(dir: string, entry: Archived): string {
  const { message } = entry;
  const file = messageFile(keptOutOfGit(dir), message);
  mkdirSync(dirname(file), { recursive: true });
  const { body, ...head } = { ...message, file };
  const header = JSON.stringify({ ...head, to: entry.deliveries });
  writeFileSync(file, `${OPENING}${header}${CLOSING}# ${message.subject}\n\n${body.trim()}\n`);
  return file;
}

/** Adds a mail to its thread's file. */
export function appendThread(dir: string, message: Message, from: string, to: string): string {
  const file = join(keptOutOfGit(dir), "threads", `${safe(message.thread)}.md`);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) writeFileSync(file, `# Thread ${message.thread}\n\n`);
  appendFileSync(file, `${threadEntry(message, from, to)}\n`);
  return file;
}

export function threadFile(dir: string, thread: string): string | null {
  const file = join(dir, "threads", `${safe(thread)}.md`);
  return existsSync(file) ? file : null;
}

/** How many mail files a folder holds: what its store should hold as messages. */
export function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .reduce((sum, month) => sum + readdirSync(join(dir, month)).filter((name) => name.endsWith(".md")).length, 0);
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

/** Removes mail files that are no longer in the store, and the files of threads left empty. */
export function dropFiles(
  dir: string,
  mails: readonly Pick<Message, "id" | "at" | "signal">[],
  threads: readonly string[] = [],
): void {
  for (const mail of mails) rmSync(messageFile(dir, mail), { force: true });
  for (const thread of threads) rmSync(join(dir, "threads", `${safe(thread)}.md`), { force: true });
}
