import { createHash } from "node:crypto";
import { withoutMail } from "../coordination/envelope";
import type { TurnEvent } from "../host";
import { redact } from "../redact";

/** A turn of a seat as the record's entries: what was typed, said, run, changed and read, secrets hidden, size held. */

export type EntryKind = "owner" | "prompt" | "say" | "shell" | "change" | "read" | "tool" | "mail";

export interface Entry {
  ordinal: number;
  kind: EntryKind;
  text: string;
  exitCode: number | null;
}

export const RECORD_LIMITS = { entries: 200, head: 50, passedOutput: 300 } as const;

const SECRET_DUMP =
  /^\s*(?:env|set|export\s+-p)\s*(?:$|[|;&>])|^\s*printenv\b|\bkubectl\s+get\s+secrets?\b|\b(?:cat|less|more|head|tail|bat|grep|rg|sed|awk)\s+[^|;&\n]*(?:\.env\b|\.npmrc|\.netrc|\.pgpass|credentials|id_rsa|id_ed25519|\.pem\b|\.key\b)/i;

/** Whether a command prints variables or files where secrets live, so its output is not kept. */
export function dumpsSecrets(command: string): boolean {
  return SECRET_DUMP.test(command);
}

/** The text of one event as the record keeps it, before secrets are hidden; a seat's reasoning is not kept. */
function textOf(event: TurnEvent): string {
  switch (event.kind) {
    case "prompt":
      return withoutMail(event.text);
    case "say":
      return event.text;
    case "think":
    case "compaction":
      return "";
    case "shell": {
      if (!event.output) return `$ ${event.command}`;
      if (dumpsSecrets(event.command)) return `$ ${event.command}\n(output not kept: the command prints secrets)`;
      // a command that passed says so at its end; a failure keeps all the output the timeline kept
      const output = event.exitCode === 0 ? event.output.slice(-RECORD_LIMITS.passedOutput) : event.output;
      return `$ ${event.command}\n${output}`;
    }
    case "change":
      return event.status === "failed" ? `${event.path} (the change failed)` : event.path;
    case "read":
      return event.path;
    case "tool":
      return event.label ? `${event.name} ${event.label}` : event.name;
  }
}

/** A turn's entries, numbered by place so a turn always gives the same numbers; `briefed`: its first prompt is a start brief. */
export function entriesOf(events: readonly TurnEvent[], briefed: boolean): Entry[] {
  const entries: Entry[] = [];
  let firstPrompt = true;
  events.forEach((event, ordinal) => {
    if (event.kind === "think" || event.kind === "compaction") return;
    const text = textOf(event).normalize("NFC").trim();
    const kind: EntryKind = event.kind === "prompt" ? (firstPrompt && briefed ? "prompt" : "owner") : event.kind;
    if (event.kind === "prompt") firstPrompt = false;
    if (!text) return;
    entries.push({
      ordinal,
      kind,
      text: redact(text),
      exitCode: event.kind === "shell" ? event.exitCode : null,
    });
  });
  if (entries.length <= RECORD_LIMITS.entries) return entries;
  // a person's words are never cut: what a decision rests on must stay findable
  const tail = entries.length - (RECORD_LIMITS.entries - RECORD_LIMITS.head);
  return entries.filter((entry, at) => at < RECORD_LIMITS.head || at >= tail || entry.kind === "owner");
}

/** A turn's lasting name: the host's turn id, or a digest of its start and content when the host gave none. */
export function turnRef(agent: string, turnId: string | null, events: readonly TurnEvent[], startedAt = ""): string {
  if (turnId) return `${agent}:${turnId}`;
  const digest = createHash("sha256").update(`${startedAt}\u0000`);
  for (const event of events) digest.update(`${event.kind}\u0000${textOf(event)}\u0000`);
  return `${agent}:h${digest.digest("hex").slice(0, 16)}`;
}

export type SourceKind = "turn" | "mail";

/** Where one entry lives: `turn:<agent>:<turn>#<n>` or `mail:<id>#0`. */
export function addressOf(kind: SourceKind, ref: string, ordinal: number): string {
  return `${kind}:${ref}#${ordinal}`;
}

/** An address read back into its source and place; null when it is not one. */
export function parseAddress(address: string): { kind: SourceKind; ref: string; ordinal: number } | null {
  const match = /^(turn|mail):(.+)#(\d+)$/.exec(address.trim());
  return match ? { kind: match[1] as SourceKind, ref: match[2], ordinal: Number(match[3]) } : null;
}
