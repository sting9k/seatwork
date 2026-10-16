import { createHash } from "node:crypto";
import type { Guard, SeatRef } from "./guard";

/** The thin hooks each agent CLI runs before a tool call, and the answer each reads; a hook finds the guard by GATE_ENV. */

export type Cli = "claude" | "codex" | "pi" | "opencode";

export const GATE_ENV = {
  url: "SEATWORK_GATE_URL",
  seat: "SEATWORK_GATE_SEAT",
  seconds: "SEATWORK_GATE_SECONDS",
} as const;

const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell", "bash", "shell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit"]);
const READ_TOOLS: Record<string, boolean> = {
  read: false,
  grep: true,
  find: false,
  ls: false,
  glob: false,
  list: false,
};
const QUESTION_TOOLS = new Set(["request_user_input", "request_user_input_async"]);
const ASK_BY_MAIL =
  "Ask in your final message, or by mail with seatwork_mail: a question asked here keeps you in your turn, and nobody in the room sees it.";

interface Call {
  shell: string | null;
  writes: string[];
  read: { path: string; whole: boolean } | null;
  texts: Map<string, string>;
  cwd: string | null;
  refused: string | null;
}

const MOST_FILES = 200;
const MOST_PATCH_CHARS = 2 * 1024 * 1024;
const MOST_PATH_CHARS = 4096;

/** The tool call inside a hook's payload: the shell line it runs, or the files it writes. */
function callOf(body: Record<string, unknown>): Call {
  const input = (body.tool_input ?? body.input ?? {}) as Record<string, unknown>;
  const tool = String(body.tool_name ?? body.tool ?? "");
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const call: Call = { shell: null, writes: [], read: null, texts: new Map(), cwd, refused: null };
  const patch = tool === "apply_patch" ? input.command : tool === "patch" ? input.patchText : null;
  if (SHELL_TOOLS.has(tool) && typeof input.command === "string") call.shell = input.command;
  else if (typeof patch === "string") patchOf(patch, call);
  else if (QUESTION_TOOLS.has(tool)) call.refused = ASK_BY_MAIL;
  else if (Object.hasOwn(READ_TOOLS, tool)) {
    const path = input.path ?? input.file_path ?? input.filePath ?? ".";
    if (typeof path === "string") call.read = { path, whole: READ_TOOLS[tool] };
  } else if (WRITE_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof path === "string") {
      call.writes = [path];
      call.texts.set(path, addedBy(input));
    }
  }
  // the guard reads the first files of a large call; the call runs whole
  call.writes = call.writes.filter((path) => path.length <= MOST_PATH_CHARS).slice(0, MOST_FILES);
  return call;
}

/** The text an editing call adds: a file's content, the new string of an edit, of each of several, or of a notebook cell. */
function addedBy(input: Record<string, unknown>): string {
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
  return [input, ...edits]
    .flatMap((part) => [part.content, part.new_string, part.newString, part.newText, part.new_source])
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** The files a patch writes, and the lines it adds to each; a patch past the guard's limits is not read for lines. */
function patchOf(patch: string, call: Call): void {
  call.writes = patchTargets(patch);
  if (call.writes.length > MOST_FILES || patch.length > MOST_PATCH_CHARS) return;
  const added = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/.exec(line);
    if (header) {
      file = (header[1] ?? header[2]).trim();
      if (!added.has(file)) added.set(file, []);
    } else if (line.startsWith("*** ")) file = null;
    else if (file && line.startsWith("+")) added.get(file)!.push(line.slice(1));
  }
  for (const [path, lines] of added) call.texts.set(path, lines.join("\n"));
}

/** The files an apply_patch body adds, updates, deletes or moves to; the reading stops one file past what the guard checks. */
function patchTargets(patch: string): string[] {
  if (patch.length > MOST_PATCH_CHARS) return [];
  const out = new Set<string>();
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    out.add((m[1] ?? m[2]).trim());
    if (out.size > MOST_FILES) break;
  }
  return [...out];
}

/** Reads one hook payload and answers in the shape that CLI reads: a refusal of a question meant for the room's mail, or the note that rides on the call; `wrote` is the shell line that runs and writes the seat's tree. */
export async function answerHook(
  guard: Guard,
  cli: Cli,
  body: Record<string, unknown>,
  seat: SeatRef | null,
  note?: string,
): Promise<{ type: string; text: string; noted: boolean; wrote: string | null }> {
  const call = callOf(body);
  if (call.refused) return { ...render(cli, { refused: call.refused }), noted: false, wrote: null };
  let wrote: string | null = null;
  if (call.shell !== null && (await guard.check(seat, cli, call.shell, call.cwd))) wrote = call.shell;
  if (call.read) {
    const { path, whole } = call.read;
    await guard.checkRead(seat, cli, absolute(path, call.cwd), call.cwd, whole);
  }
  for (const path of call.writes)
    await guard.checkWrite(seat, cli, absolute(path, call.cwd), call.cwd, call.texts.get(path));
  return { ...render(cli, { note }), noted: Boolean(note), wrote };
}

const absolute = (path: string, cwd: string | null) => (path.startsWith("/") || !cwd ? path : `${cwd}/${path}`);

/** An answer in the shape its CLI reads: hook JSON for Claude and Codex, a block flag for Pi and OpenCode. */
export function render(cli: Cli, answer: { refused?: string; note?: string }): { type: string; text: string } {
  if (cli === "pi" || cli === "opencode")
    return {
      type: "application/json",
      text: JSON.stringify(
        answer.refused ? { block: true, reason: answer.refused } : { block: false, note: answer.note ?? null },
      ),
    };
  if (!answer.refused && !answer.note) return { type: "text/plain", text: "" };
  const output = answer.refused
    ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: answer.refused }
    : { hookEventName: "PreToolUse", additionalContext: answer.note };
  return { type: "application/json", text: JSON.stringify({ hookSpecificOutput: output }) };
}

const ASK_SECONDS = 4;
const RETRY_SECONDS = 3;

/** The script Claude and Codex run inline: it hands the payload to the room and prints the answer; with no answer the call runs. */
function gateScript(): string {
  return `# The room's hook: tells the room of this tool call and prints its answer.
url="\${${GATE_ENV.url}:-}"
[ -n "$url" ] || exit 0
answer=$(curl --silent --fail --max-time "\${${GATE_ENV.seconds}:-${ASK_SECONDS}}" --retry 3 --retry-connrefused --retry-delay 1 --retry-max-time ${RETRY_SECONDS} --header "Content-Type: application/json" --header "X-Seat: \${${GATE_ENV.seat}:-}" --data-binary @- "$url?cli=$1" 2>/dev/null) && printf '%s' "$answer"
exit 0
`;
}

export const SKILLS_ENV = "ROOM_SKILLS_DIR";

/** Prints the name and description of each skill in the seat's folder: after a compaction Claude Code has dropped its own list. */
function skillsScript(): string {
  return `dir="\${${SKILLS_ENV}:-}"
[ -d "$dir" ] || exit 0
echo "After the compaction, your skills, each loaded by the Skill tool when its moment comes:"
for file in "$dir"/*/SKILL.md; do
  [ -f "$file" ] || continue
  name=$(sed -n 's/^name:[[:space:]]*//p' "$file" | head -n 1)
  about=$(sed -n 's/^description:[[:space:]]*//p' "$file" | head -n 1 | sed 's/^"//; s/"$//')
  echo "- $name: $about"
done
`;
}

/** A Claude plugin folder, loaded with --plugin-dir: its manifest, its PreToolUse hook, and its skills told again after a compaction. */
export function claudePlugin(): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": `${JSON.stringify({ name: "room-guard", description: "The room's hook: every shell command and file write is told to the room first." }, null, 2)}\n`,
    "hooks/hooks.json": `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash|Monitor|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
              hooks: [
                {
                  type: "command",
                  command: "/bin/sh",
                  args: ["-c", gateScript(), "room-guard", "claude"],
                  timeout: 10,
                },
              ],
            },
          ],
          SessionStart: [
            {
              matcher: "compact",
              hooks: [{ type: "command", command: "/bin/sh", args: ["-c", skillsScript()], timeout: 10 }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  };
}

const CODEX_MATCHER = "^(Bash|apply_patch|request_user_input|request_user_input_async)$";
const CODEX_TIMEOUT = 10;

/** Codex runs a hook's command line through the user's shell, so the script goes in quoted. */
const codexCommand = () => `/bin/sh -c '${gateScript().replace(/'/g, "'\\''")}' room-guard codex`;

/** Codex's hooks.json for a seat's home. */
export function codexHooks(): string {
  return `${JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: CODEX_MATCHER,
            hooks: [{ type: "command", command: codexCommand(), timeout: CODEX_TIMEOUT }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/** The trust Codex keeps for a hook it runs without review: its key and definition hash. */
export function codexTrust(hooksFile: string): { key: string; hash: string } {
  const identity = {
    event_name: "pre_tool_use",
    hooks: [{ async: false, command: codexCommand(), timeout: CODEX_TIMEOUT, type: "command" }],
    matcher: CODEX_MATCHER,
  };
  const hash = createHash("sha256").update(canonical(identity)).digest("hex");
  return { key: `${hooksFile}:pre_tool_use:0:0`, hash: `sha256:${hash}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The call Pi's extension and OpenCode's plugin make: the room's answer, or null when none comes. */
function askRoom(cli: Cli): string {
  return `async function ask(body: unknown): Promise<any> {
  const url = process.env.${GATE_ENV.url};
  if (!url) return null;
  for (const until = Date.now() + ${RETRY_SECONDS * 1000}; ; ) {
    try {
      const res = await fetch(url + "?cli=${cli}", {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat": process.env.${GATE_ENV.seat} ?? "" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(${ASK_SECONDS * 1000}),
      });
      return res.ok ? await res.json().catch(() => null) : null;
    } catch (error: any) {
      if (error?.name === "TimeoutError" || Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}`;
}

/** Pi's extension: every bash, write, edit and read call is told to the room first. */
export function piExtension(): string {
  return `// The room's hook: every bash, write, edit and read call is told to the room first.
${askRoom("pi")}

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!["bash", "write", "edit", "read", "grep", "find", "ls"].includes(event.toolName)) return;
    const answer = await ask({ tool: event.toolName, input: event.input, cwd: ctx.cwd });
    if (answer?.block) return { block: true, reason: answer.reason };
  });
}
`;
}

/** OpenCode's V2 plugin: every shell, write, edit, patch and read call is told to the room first; a refused one is replaced by a shell call that prints why and fails. */
export function openCodePlugin(): string {
  return `// The room's hook: every shell, write, edit, patch and read call is told to the room first.
${askRoom("opencode")}

const quote = (s: string) => "'" + s.replace(/'/g, "'\\\\''") + "'";
export default {
  id: "room-guard",
  setup(ctx: any) {
    ctx.tool.hook("execute.before", async (e: any) => {
      if (!["shell", "write", "edit", "patch", "read", "grep", "glob", "list"].includes(e.tool)) return;
      const answer = await ask({ tool: e.tool, input: e.input, cwd: ctx.location?.directory ?? null });
      if (!answer?.block) return;
      e.tool = "shell";
      e.input = { command: "printf '%s\\\\n' " + quote(answer.reason) + " >&2; exit 1" };
    });
  },
};
`;
}
