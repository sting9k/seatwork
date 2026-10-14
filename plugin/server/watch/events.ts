import { isAbsolute, normalize, resolve } from "node:path";

/** A seat's turn as harness-neutral events, one per assistant message and tool call, in order. */

export type RunStatus = "running" | "ok" | "failed" | "canceled";

/** What every event carries: `seq` orders the history; `at` is epoch ms, a finished call's end or a running one's start. */
interface EventBase {
  seq: number;
  source: number;
  at?: number;
  prior?: number;
  turn?: string;
}

export interface SayEvent extends EventBase {
  kind: "say";
  text: string;
}

/** A shell call; `output` is read by code only and never leaves this machine. */
export interface ShellEvent extends EventBase {
  kind: "shell";
  command: string;
  cwd?: string;
  status: RunStatus;
  exitCode: number | null;
  output: string;
  background?: "pending" | "settled";
}

/** A file (absolute path) written through the harness's own edit tool; shell writes come from the shell analysis. */
export interface EditEvent extends EventBase {
  kind: "edit";
  path: string;
  status: RunStatus;
}

/** A read or a search: activity that changes nothing; `path` is the file a read opened. */
export interface LookEvent extends EventBase {
  kind: "look";
  path?: string;
  status: RunStatus;
}

/** Any other tool: MCP calls (the room's mail among them), skills, sub-agents. */
export interface ToolEvent extends EventBase {
  kind: "tool";
  name: string;
  input: Record<string, unknown>;
  status: RunStatus;
}

export type TurnEvent = SayEvent | ShellEvent | EditEvent | LookEvent | ToolEvent;

/** One entry of Paseo's projected timeline, or one item of a turn_ended timeline. */
export interface TimelineInput {
  item: unknown;
  timestamp?: string;
  turnId?: string;
}

/** Where the turn being judged starts: at its first event when Paseo names the turn, else after the last prompt. */
export function turnStartOf(
  entries: readonly TimelineInput[],
  events: readonly TurnEvent[],
  turnId: string | null,
): number {
  const named = turnId ? events.find((event) => event.turn === turnId) : undefined;
  if (named) return named.seq;
  let lastPrompt = -1;
  entries.forEach((entry, index) => {
    if (record(entry.item).type === "user_message") lastPrompt = index;
  });
  const after = events.find((event) => event.source > lastPrompt);
  return after ? after.seq : events.length + 1;
}

/** Every prompt the seat received, oldest first: its brief is among them. */
export function prompts(entries: readonly TimelineInput[]): string[] {
  return entries
    .map((entry) => record(entry.item))
    .filter((item) => item.type === "user_message")
    .map((item) => text(item.text));
}

export interface Letter {
  id: string;
  from: string;
  subject: string;
  body: string;
}

const ENVELOPE = /^<mail id="([^"]+)" from="([^"]*)" subject="([^"]*)"[^>]*>$/;

/** The mails in a prompt the room delivered, one block or several; none for any other prompt. */
export function letters(prompt: string): Letter[] {
  const found: Letter[] = [];
  let open: (Letter & { lines: string[] }) | null = null;
  for (const line of prompt.split("\n")) {
    // inside a block every line is the sender's text, a quoted block's opening included
    if (open) {
      if (line === "</mail>") {
        found.push({ id: open.id, from: open.from, subject: open.subject, body: open.lines.join("\n") });
        open = null;
      } else open.lines.push(line);
      continue;
    }
    const header = ENVELOPE.exec(line);
    if (header) open = { id: header[1], from: header[2], subject: header[3], body: "", lines: [] };
  }
  // a prompt that ends inside a block: the rest of it is that mail
  if (open) found.push({ id: open.id, from: open.from, subject: open.subject, body: open.lines.join("\n") });
  return found;
}

const STATUS: Record<string, RunStatus> = {
  running: "running",
  completed: "ok",
  failed: "failed",
  canceled: "canceled",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function content(value: unknown): string {
  if (Array.isArray(value)) return value.map((block) => text(record(block).text)).join("\n");
  return text(value);
}

/** The harness turned the call down before anything ran (a blocked command, a denied permission). */
const REFUSED =
  /^\s*<tool_use_error>|^\s*(?:Blocked:|Permission (?:to use \w+ has been )?denied|The user doesn't want to proceed)/i;
const BACKGROUND = /^\s*Command running in background with ID:/;

/** How Claude's background commands ended, by the call that started them. */
function settledCalls(entries: readonly TimelineInput[]): Map<string, { status: RunStatus; exitCode: number | null }> {
  const settled = new Map<string, { status: RunStatus; exitCode: number | null }>();
  for (const entry of entries) {
    const item = record(entry.item);
    const meta = record(item.metadata);
    const call = text(meta.toolUseId);
    const status = STATUS[text(meta.status)];
    if (meta.synthetic !== true || !call || !status || status === "running") continue;
    const code = /exit code (\d+)/i.exec(text(record(item.detail).text));
    settled.set(call, { status, exitCode: code ? Number(code[1]) : status === "ok" ? 0 : null });
  }
  return settled;
}

/** Codex opens every message after the first with a rule; the watcher reads the words. */
function cleanSay(raw: string): string {
  return raw.replace(/^\s*(?:-{3,}\s*)+/, "").trim();
}

/** Drops what the watcher has no use for: prompts, reasoning, todo lists, synthetic notices. */
export function toEvents(entries: readonly TimelineInput[], cwd: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  const settled = settledCalls(entries);
  let prior: number | undefined;
  entries.forEach((entry, source) => {
    const item = record(entry.item);
    const seq = events.length + 1;
    const stamp = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    const base = {
      seq,
      source,
      ...(Number.isFinite(stamp) ? { at: stamp } : {}),
      ...(prior === undefined ? {} : { prior }),
      ...(entry.turnId ? { turn: entry.turnId } : {}),
    };
    if (Number.isFinite(stamp)) prior = stamp;
    if (item.type === "assistant_message") {
      const said = cleanSay(text(item.text));
      if (said) events.push({ ...base, kind: "say", text: said });
      return;
    }
    if (item.type !== "tool_call" || record(item.metadata).synthetic === true) return;
    const status = STATUS[text(item.status)] ?? "running";
    const detail = record(item.detail);
    switch (detail.type) {
      case "shell": {
        // Claude reports a failure beside the call: "Exit code N" and what the command printed
        const failure = content(record(item.error).content);
        const code = /^\s*Exit code (\d+)\n?/.exec(failure);
        const printed = text(detail.output) || (code ? failure.slice(code[0].length) : failure);
        const ranIn = text(detail.cwd);
        const shell: ShellEvent = {
          ...base,
          kind: "shell",
          command: text(detail.command),
          ...(ranIn ? { cwd: ranIn } : {}),
          status: REFUSED.test(failure) ? "canceled" : status,
          exitCode: typeof detail.exitCode === "number" ? detail.exitCode : code ? Number(code[1]) : null,
          output: printed,
        };
        if (BACKGROUND.test(printed)) {
          const end = settled.get(text(item.callId));
          Object.assign(
            shell,
            end ? { ...end, background: "settled", output: "" } : { background: "pending", output: "" },
          );
        }
        events.push(shell);
        break;
      }
      case "edit":
      case "write": {
        const path = text(detail.filePath);
        if (path) events.push({ ...base, kind: "edit", path: absolute(path, cwd), status });
        break;
      }
      case "read":
      case "search":
      case "fetch": {
        const opened = text(detail.filePath);
        events.push({ ...base, kind: "look", ...(opened ? { path: absolute(opened, cwd) } : {}), status });
        break;
      }
      default: {
        // Paseo keeps a skill call as text under the skill's name, without the call's input
        const skill = /^skill$/i.test(text(item.name)) ? text(detail.label) : "";
        const input = skill ? { skill } : record(detail.input);
        events.push({ ...base, kind: "tool", name: text(item.name), input, status });
      }
    }
  });
  return events;
}

/** Claude gives absolute paths; Codex gives them relative to the seat's cwd. */
export function absolute(path: string, cwd: string): string {
  return normalize(isAbsolute(path) ? path : resolve(cwd, path));
}
