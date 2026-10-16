import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { McpHttpServer } from "../server/mcp-http";
import { claudePlugin, codexHooks, GATE_ENV, openCodePlugin, piExtension, SKILLS_ENV } from "../server/safety/hooks";

const DIR = join(ROOM_HOME, "hooks-test");
mkdirSync(DIR, { recursive: true });

/** A room server whose guard answers as `answer` says; it returns the address the hooks call. */
async function room(
  answer: (body: string, cli: string, seat: string) => Promise<{ type: string; text: string }>,
  port = 0,
): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server = new McpHttpServer("tok", "test", "0");
  server.route("gate", (body, request) => answer(body, request.query.get("cli") ?? "", request.header("x-seat") ?? ""));
  const bound = await server.listen(port);
  return { url: server.routeUrl(bound, "gate"), port: bound, close: () => server.close() };
}

/** The hook each CLI runs, as its config declares it; Codex hands its command line to a shell. */
function hookOf(cli: "claude" | "codex"): [string, string[]] {
  if (cli === "claude") {
    const hook = JSON.parse(claudePlugin()["hooks/hooks.json"]).hooks.PreToolUse[0].hooks[0];
    return [hook.command, hook.args];
  }
  return ["/bin/sh", ["-c", JSON.parse(codexHooks()).hooks.PreToolUse[0].hooks[0].command]];
}

/** Runs a CLI's hook as that CLI would: the payload on stdin, the seat's env set. */
function runHook(
  cli: "claude" | "codex",
  payload: object,
  env: Record<string, string>,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const [command, args] = hookOf(cli);
    const child = spawn(command, args, { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const reasonOf = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason as string;

const DENY = {
  type: "application/json",
  text: JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" },
  }),
};

test("each CLI's hook carries the payload and the seat to the room, and prints exactly what the room answers", async () => {
  let seen = { body: "", cli: "", seat: "" };
  const live = await room(async (body, cli, seat) => {
    seen = { body, cli, seat };
    return body.includes("reset") ? DENY : { type: "text/plain", text: "" };
  });
  try {
    const env = { [GATE_ENV.url]: live.url, [GATE_ENV.seat]: "agent-1" };
    for (const cli of ["claude", "codex"] as const) {
      const allowed = await runHook(cli, { tool_name: "Bash", tool_input: { command: "ls 'a b'" } }, env);
      assert.deepEqual([allowed.status, allowed.stdout], [0, ""]);
      assert.deepEqual([seen.cli, seen.seat, JSON.parse(seen.body).tool_input.command], [cli, "agent-1", "ls 'a b'"]);
      const denied = await runHook(cli, { tool_name: "Bash", tool_input: { command: "git reset --hard" } }, env);
      assert.deepEqual([denied.status, denied.stdout], [0, DENY.text]);
    }
  } finally {
    await live.close();
  }
});

test("a call the room does not answer is blocked, each case with its reason", async () => {
  const unwired = await runHook("claude", { tool_name: "Bash" }, {});
  assert.match(reasonOf(unwired.stdout), /no way to reach/);
  const live = await room(async () => ({ type: "text/plain", text: "" }));
  const stalled = await room(
    () => new Promise((resolve) => setTimeout(() => resolve({ type: "text/plain", text: "" }), 3000)),
  );
  try {
    const failed = await runHook("codex", { tool_name: "Bash" }, { [GATE_ENV.url]: live.url.replace(/tok$/, "old") });
    assert.match(reasonOf(failed.stdout), /failed to check/);
    const slow = await runHook(
      "claude",
      { tool_name: "Bash" },
      { [GATE_ENV.url]: stalled.url, [GATE_ENV.seconds]: "1" },
    );
    assert.match(reasonOf(slow.stdout), /took too long/);
  } finally {
    await Promise.all([live.close(), stalled.close()]);
  }
});

test("a room that is down for a moment gets the whole call when it is back; one that stays down blocks it", async () => {
  const gone = await room(async () => ({ type: "text/plain", text: "" }));
  const restarting = await room(async () => ({ type: "text/plain", text: "" }));
  await Promise.all([gone.close(), restarting.close()]);
  const write = { tool_name: "Write", tool_input: { file_path: "/x/a.ts", content: "x".repeat(200_000) } };
  let seen = "";
  const back = new Promise<Awaited<ReturnType<typeof room>>>((resolve) =>
    setTimeout(() => resolve(room(async (body) => ((seen = body), DENY), restarting.port)), 1200),
  );
  const [down, retried] = await Promise.all([
    runHook("claude", write, { [GATE_ENV.url]: gone.url }),
    runHook("codex", write, { [GATE_ENV.url]: restarting.url }),
  ]);
  await (await back).close();
  assert.match(reasonOf(down.stdout), /not answering/);
  assert.equal(retried.stdout, DENY.text);
  assert.equal(JSON.parse(seen).tool_input.content.length, 200_000);
});

/** Loads a generated hook module (Pi's extension, OpenCode's plugin) from a file, as its CLI would. */
function load(name: string, text: string): any {
  const file = join(DIR, name);
  writeFileSync(file, text);
  return require(file);
}

test("Pi's extension asks the room about bash, write, edit and read calls, and blocks with the room's reason", async () => {
  const live = await room(async (body) => ({
    type: "application/json",
    text: JSON.stringify(
      JSON.parse(body).input.command === "rm -rf ~" ? { block: true, reason: "no" } : { block: false },
    ),
  }));
  const handlers: Record<string, (event: object, ctx: object) => Promise<unknown>> = {};
  load("pi-guard.ts", piExtension()).default({ on: (event: string, handler: never) => (handlers[event] = handler) });
  process.env[GATE_ENV.url] = live.url;
  try {
    const call = (toolName: string, command: string) =>
      handlers.tool_call({ toolName, input: { command } }, { cwd: "/x" });
    assert.deepEqual(await call("bash", "rm -rf ~"), { block: true, reason: "no" });
    assert.equal(await call("bash", "ls"), undefined);
    assert.deepEqual(await call("read", "rm -rf ~"), { block: true, reason: "no" }, "reading tools are asked about");
    assert.equal(await call("todo", "rm -rf ~"), undefined, "other tools are not");
    await live.close();
    const reason = async () => ((await call("bash", "ls")) as { reason: string }).reason;
    assert.match(await reason(), /not answering/);
    delete process.env[GATE_ENV.url];
    assert.match(await reason(), /no way to reach/);
  } finally {
    delete process.env[GATE_ENV.url];
    await live.close();
  }
});

test("OpenCode's plugin turns a blocked call into one that prints the room's reason and fails", async () => {
  const live = await room(async () => ({
    type: "application/json",
    text: JSON.stringify({ block: true, reason: "it's blocked" }),
  }));
  let hook: ((event: { tool: string; input: Record<string, unknown> }) => Promise<void>) | null = null;
  load("opencode-guard.ts", openCodePlugin()).default.setup({
    tool: { hook: (_: string, fn: typeof hook) => (hook = fn) },
    location: { directory: "/x" },
  });
  process.env[GATE_ENV.url] = live.url;
  try {
    const event = { tool: "write", input: { path: "/Users/u/.zshrc" } as Record<string, unknown> };
    await hook!(event);
    assert.equal(event.tool, "shell");
    const run = spawnSync("/bin/sh", ["-c", String(event.input.command)], { encoding: "utf8" });
    assert.deepEqual([run.status, run.stderr.trim()], [1, "it's blocked"]);
  } finally {
    delete process.env[GATE_ENV.url];
    await live.close();
  }
});

test("the room's server reads a letter split between two chunks whole, and a client gone mid-body leaves no failure behind", async () => {
  const live = await room(async (body) => ({ type: "text/plain", text: body }));
  const { port, pathname } = new URL(live.url);
  /** A POST written in the parts given, then ended or dropped. */
  const post = (parts: Buffer[], drop: boolean) =>
    new Promise<string>((resolve) => {
      const sent = request({ host: "127.0.0.1", port, path: pathname, method: "POST" }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve(text));
      });
      sent.on("error", () => resolve(""));
      for (const part of parts) sent.write(part);
      if (drop) setTimeout(() => (sent.destroy(), resolve("")), 20);
      else sent.end();
    });
  const word = Buffer.from("café", "utf8");
  assert.equal(await post([word.subarray(0, 4), word.subarray(4)], false), "café");
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  await post([Buffer.from("half of a pay")], true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  process.off("unhandledRejection", note);
  assert.deepEqual(unhandled, []);
  await live.close();
});

test("after a compaction a Claude seat is told its skills again, each with its description, from its own folder", () => {
  const [entry] = JSON.parse(claudePlugin()["hooks/hooks.json"]).hooks.SessionStart;
  assert.equal(entry.matcher, "compact");
  const dir = join(ROOM_HOME, "compact-skills");
  for (const [name, about] of [
    ["lenses", '"Ask read-only Peers on different families."'],
    ["seat-law", "How to judge a breach of the law."],
  ]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${about}\n---\nBody.\n`);
  }
  const run = (env: Record<string, string>) =>
    spawnSync(entry.hooks[0].command, entry.hooks[0].args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  const told = run({ [SKILLS_ENV]: dir });
  assert.equal(told.status, 0);
  assert.equal(
    told.stdout,
    "After the compaction, your skills, each loaded by the Skill tool when its moment comes:\n- lenses: Ask read-only Peers on different families.\n- seat-law: How to judge a breach of the law.\n",
  );
  assert.deepEqual([run({}).status, run({}).stdout], [0, ""], "a session the room did not start is told nothing");
});
