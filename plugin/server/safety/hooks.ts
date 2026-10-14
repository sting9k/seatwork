import { createHash } from "node:crypto";
import type { Guard, SeatRef, Verdict } from "./guard";

/** The thin hooks each agent CLI runs before a tool call, and the answer each reads. */

export type Cli = "claude" | "codex" | "pi" | "opencode";

/** The env names of a seat's session: where the guard listens and which seat asks. */
export const GATE_ENV = {
  url: "SEATWORK_GATE_URL",
  seat: "SEATWORK_GATE_SEAT",
  seconds: "SEATWORK_GATE_SECONDS",
} as const;

const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell", "bash", "shell"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit"]);

interface Call {
  shell: string | null;
  writes: string[];
  cwd: string | null;
}

/** The tool call inside a hook's payload: the shell line it runs, or the files it writes. */
function callOf(body: Record<string, unknown>): Call {
  const input = (body.tool_input ?? body.input ?? {}) as Record<string, unknown>;
  const tool = String(body.tool_name ?? body.tool ?? "");
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const call: Call = { shell: null, writes: [], cwd };
  if (SHELL_TOOLS.has(tool) && typeof input.command === "string") call.shell = input.command;
  else if (tool === "apply_patch" && typeof input.command === "string") call.writes = patchTargets(input.command);
  else if (tool === "patch" && typeof input.patchText === "string") call.writes = patchTargets(input.patchText);
  else if (WRITE_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof path === "string") call.writes = [path];
  }
  return call;
}

/** The files an apply_patch body adds, updates, deletes or moves to. */
function patchTargets(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm))
    out.push((m[1] ?? m[2]).trim());
  return out;
}

/** Checks one hook payload and answers in the shape that CLI reads. */
export async function answerHook(
  guard: Guard,
  cli: Cli,
  body: Record<string, unknown>,
  seat: SeatRef | null,
  note?: string,
): Promise<{ type: string; text: string; noted: boolean }> {
  const call = callOf(body);
  let verdict: Verdict | null = null;
  if (call.shell !== null) verdict = await guard.check(seat, cli, call.shell, call.cwd);
  for (const path of call.writes) {
    if (verdict && !verdict.allow) break;
    const abs = path.startsWith("/") || !call.cwd ? path : `${call.cwd}/${path}`;
    const found = await guard.checkWrite(seat, cli, abs, call.cwd);
    if (!found.allow || !verdict) verdict = found;
  }
  if (!note || (verdict && !verdict.allow)) return { ...render(cli, verdict), noted: false };
  const message = [verdict?.message, note].filter(Boolean).join("\n\n");
  verdict = verdict ? { ...verdict, message } : { allow: true, message, finding: null, code: null, grantor: null };
  return { ...render(cli, verdict), noted: true };
}

export function render(cli: Cli, verdict: Verdict | null): { type: string; text: string } {
  if (cli === "pi" || cli === "opencode")
    return {
      type: "application/json",
      text: JSON.stringify(
        verdict && !verdict.allow
          ? { block: true, reason: verdict.message }
          : { block: false, note: verdict?.message ?? null },
      ),
    };
  if (!verdict || (verdict.allow && !verdict.message)) return { type: "text/plain", text: "" };
  const output = verdict.allow
    ? { hookEventName: "PreToolUse", additionalContext: verdict.message }
    : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.message };
  return { type: "application/json", text: JSON.stringify({ hookSpecificOutput: output }) };
}

/** Why a call does not run when the guard gives no answer: an undone check is never an allow. */
const UNCHECKED = {
  unwired: "This session has no way to reach the room's guard, so this call does not run. Tell your Owner.",
  down: "The room's guard is not answering, so this call does not run. Try again in a minute; if it keeps failing, tell your Owner.",
  slow: "The room's guard took too long to check this call, so it does not run. Try again; if it keeps happening, tell your Owner.",
  failed: "The room's guard failed to check this call, so it does not run. Tell your Owner.",
} as const;

const ASK_SECONDS = 4;
const RETRY_SECONDS = 3;

/** The script Claude and Codex run inline: it carries the payload to the room and prints the answer. */
export function gateScript(): string {
  const deny = (why: string) => `deny "${why}"`;
  return `# The room's guard: hands this tool call to the room and prints its answer. The room decides.
deny() { printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$1"; exit 0; }
url="\${${GATE_ENV.url}:-}"
[ -n "$url" ] || ${deny(UNCHECKED.unwired)}
answer=$(curl --silent --fail --max-time "\${${GATE_ENV.seconds}:-${ASK_SECONDS}}" --retry 3 --retry-connrefused --retry-delay 1 --retry-max-time ${RETRY_SECONDS} --header "Content-Type: application/json" --header "X-Seat: \${${GATE_ENV.seat}:-}" --data-binary @- "$url?cli=$1" 2>/dev/null)
case $? in
  0) printf '%s' "$answer" ;;
  6|7) ${deny(UNCHECKED.down)} ;;
  28) ${deny(UNCHECKED.slow)} ;;
  *) ${deny(UNCHECKED.failed)} ;;
esac
`;
}

/** A Claude plugin folder, loaded with --plugin-dir: its manifest and its PreToolUse hook. */
export function claudePlugin(): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": `${JSON.stringify({ name: "room-guard", description: "The room's command guard: every shell command and file write is checked first." }, null, 2)}\n`,
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
        },
      },
      null,
      2,
    )}\n`,
  };
}

const CODEX_MATCHER = "^(Bash|apply_patch)$";
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

/** The call Pi's extension and OpenCode's plugin make: the room's answer, or a block when none comes. */
function askRoom(cli: Cli): string {
  const block = (why: string) => `{ block: true, reason: ${JSON.stringify(why)} }`;
  return `async function ask(body: unknown): Promise<any> {
  const url = process.env.${GATE_ENV.url};
  if (!url) return ${block(UNCHECKED.unwired)};
  let res: Response;
  for (const until = Date.now() + ${RETRY_SECONDS * 1000}; ; ) {
    try {
      res = await fetch(url + "?cli=${cli}", {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat": process.env.${GATE_ENV.seat} ?? "" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(${ASK_SECONDS * 1000}),
      });
      break;
    } catch (error: any) {
      if (error?.name === "TimeoutError") return ${block(UNCHECKED.slow)};
      if (Date.now() >= until) return ${block(UNCHECKED.down)};
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!res.ok) return ${block(UNCHECKED.failed)};
  try {
    return await res.json();
  } catch {
    return ${block(UNCHECKED.failed)};
  }
}`;
}

/** Pi's extension: every bash, write and edit call goes to the room first. */
export function piExtension(): string {
  return `// The room's guard: every bash, write and edit call goes to the room first. The room decides.
${askRoom("pi")}

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!["bash", "write", "edit"].includes(event.toolName)) return;
    const answer = await ask({ tool: event.toolName, input: event.input, cwd: ctx.cwd });
    if (answer?.block) return { block: true, reason: answer.reason };
  });
}
`;
}

/** OpenCode's V2 plugin: a blocked shell call is replaced by one that prints why and fails. */
export function openCodePlugin(): string {
  return `// The room's guard: every shell, write, edit and patch call goes to the room first. The room decides.
${askRoom("opencode")}

const quote = (s: string) => "'" + s.replace(/'/g, "'\\\\''") + "'";
export default {
  id: "room-guard",
  setup(ctx: any) {
    ctx.tool.hook("execute.before", async (e: any) => {
      if (!["shell", "write", "edit", "patch"].includes(e.tool)) return;
      const answer = await ask({ tool: e.tool, input: e.input, cwd: ctx.location?.directory ?? null });
      if (!answer?.block) return;
      e.tool = "shell";
      e.input = { command: "printf '%s\\\\n' " + quote(answer.reason) + " >&2; exit 1" };
    });
  },
};
`;
}
