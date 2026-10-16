"use strict";
/** One eval run in a process of its own: a throwaway room home, the plugin running on a stand-in Paseo, the seat under test on its agent CLI or a script, then the room and the project after its turn, graded. */
const { spawn, execFileSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const { dirname, join, resolve } = require("node:path");

const [caseName, runText, outDir, workDir] = process.argv.slice(2);
const run = JSON.parse(runText);
const PLUGIN = resolve(__dirname, "..", "plugin");
const short = (text) => createHash("sha1").update(text).digest("hex").slice(0, 6);
const HOME = join(workDir, "home");
const PROJECT = join(workDir, `work-${short(outDir)}`);
const GIT_ENV = {
  GIT_AUTHOR_NAME: "dev",
  GIT_AUTHOR_EMAIL: "dev@example.test",
  GIT_COMMITTER_NAME: "dev",
  GIT_COMMITTER_EMAIL: "dev@example.test",
};
const ROLES = ["hq", "supervisor", "lead", "peer"];
const HARNESSES = ["claude", "codex", "pi", "opencode"];

// the room's homes are the run's own before any module of the plugin reads them; the agent CLIs keep the user's login
for (const dir of [HOME, join(workDir, "paseo"), PROJECT, outDir]) fs.mkdirSync(dir, { recursive: true });
const paseoCli = join(workDir, "paseo-cli");
fs.writeFileSync(paseoCli, '#!/bin/sh\ncase "$1 $2" in "agent update"|"agent archive") exit 0 ;; esac\nexit 1\n', {
  mode: 0o755,
});
Object.assign(process.env, {
  SEATWORK_ROOM_HOME: HOME,
  PASEO_HOME: join(workDir, "paseo"),
  SEATWORK_PASEO_BIN: paseoCli,
});
require(join(PLUGIN, "test", "register.cjs"));
const { grade } = require("./graders.cjs");
const c = require("./cases.cjs").find((one) => one.name === caseName);
if (!c) throw new Error(`no case ${caseName}`);
const RAW_POLICY = JSON.parse(fs.readFileSync(join(PLUGIN, "paseo", "policy.json"), "utf8"));
const MODELS = JSON.parse(fs.readFileSync(join(PLUGIN, "room", "models.json"), "utf8"));

const write = (path, text) => {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
};
const git = (...argv) =>
  execFileSync("git", argv, { cwd: PROJECT, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();
const settle = (ms) => new Promise((done) => setTimeout(done, ms));

/** The room's files, its policy (as the case changes it), every seat the room may start, and a setup of this version. */
function installRoom() {
  fs.cpSync(join(PLUGIN, "room"), join(HOME, "room"), { recursive: true });
  const policy = structuredClone(RAW_POLICY);
  policy.mail.port = 0;
  c.policy?.(policy);
  write(join(HOME, "policy.json"), JSON.stringify(policy, null, 2));
  const providers = ROLES.flatMap((role) => HARNESSES.map((harness) => `${harness}-${role}`));
  write(join(HOME, "seats.json"), JSON.stringify({ providers, source: PLUGIN }));
  const version = JSON.parse(fs.readFileSync(join(PLUGIN, "package.json"), "utf8")).version;
  write(join(HOME, "setup.json"), JSON.stringify({ version }));
}

/** The case's project: its files committed as the base, the room's marker with its law, what lies uncommitted on top, and the registry naming it. */
function makeProject() {
  const marker = {
    ...(c.project?.law ? { law: c.project.law } : {}),
    ...(c.project?.mission ? { mission: c.project.mission } : {}),
  };
  for (const [path, text] of Object.entries({ ...c.files, ".seatwork/room.json": JSON.stringify(marker) }))
    write(join(PROJECT, path), text);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  for (const [path, text] of Object.entries(c.uncommitted ?? {})) write(join(PROJECT, path), text);
  write(join(HOME, "projects.json"), JSON.stringify({ projects: [{ name: c.project?.name ?? "app", cwd: PROJECT }] }));
  return git("rev-parse", "HEAD");
}

/** One tool call to the room's MCP server, its text and whether it is a refusal. */
async function mcp(url, tool, args) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const { result, error } = await response.json();
  if (error) return { text: JSON.stringify(error), error: true };
  return { text: result.content.map((part) => part.text).join("\n"), error: !!result.isError };
}

/** Paseo as the room sees it here: agents in memory, what each was sent, and the hooks fired as Paseo fires them. */
function standInPaseo() {
  const agents = new Map();
  const sent = new Map();
  const workspaces = [];
  const handle = (id) => ({
    id,
    refresh: async () => null,
    current: () => (agents.has(id) ? { id, ...agents.get(id) } : null),
    send: async (text, options) =>
      void sent.set(id, [...(sent.get(id) ?? []), { text, interrupt: options?.activeTurnBehavior === "interrupt" }]),
    archive: async () => {
      const at = new Date().toISOString();
      if (agents.has(id)) agents.get(id).archivedAt = at;
      return { archivedAt: at };
    },
    timeline: { refetch: async () => ({ entries: [] }) },
  });
  const paseo = {
    agents: {
      ref: handle,
      list: async () => ({
        entries: [...agents].filter(([, one]) => !one.archivedAt).map(([id, one]) => ({ agent: { id, ...one } })),
        pageInfo: { hasMore: false },
      }),
      create: async (options) => {
        const id = options.agentId ?? randomUUID();
        agents.set(id, {
          provider: options.config?.provider,
          cwd: options.cwd,
          title: options.title,
          status: "idle",
          updatedAt: new Date().toISOString(),
        });
        return handle(id);
      },
    },
    projects: {
      list: async () => ({ projects: [{ projectDisplayName: c.project?.name ?? "app", projectRootPath: PROJECT }] }),
    },
    workspaces: {
      list: async () => ({ entries: [...workspaces] }),
      open: async ({ cwd }) =>
        void workspaces.push({ id: randomUUID(), workspaceDirectory: cwd, projectRootPath: cwd }),
      archive: async (id) =>
        void workspaces.splice(
          workspaces.findIndex((one) => one.id === id),
          1,
        ),
    },
  };
  return { agents, sent, context: { paseo } };
}

/** What the room holds after the turn: its mail with who each went to, its issues, what Paseo was asked to send each agent, and the agents the seat created. */
function roomNow(stand, created, seats) {
  const rows = (file, sql) => {
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const mailOf = (file) =>
    rows(
      file,
      `SELECT m.id, m.sender AS "from", m.sender_role AS fromRole, m.subject, m.body, m.needs, m.reply_to AS replyTo,
              (SELECT json_group_array(d.seat) FROM deliveries d WHERE d.message_id = m.id) AS "to"
       FROM messages m ORDER BY m.id`,
    ).map((one) => ({ ...one, to: JSON.parse(one.to) }));
  return {
    seats,
    mail: [...mailOf(join(PROJECT, ".seatwork", ".mail", "mail.db")), ...mailOf(join(HOME, "mail", "mail.db"))],
    issues: rows(join(PROJECT, ".seatwork", ".work", "work.db"), "SELECT * FROM issues ORDER BY created_at, id"),
    sent: Object.fromEntries([...stand.sent].map(([id, texts]) => [id, texts])),
    created,
  };
}

/** The project after the turn: its commits since `base`, what is not committed, and the files changed. */
function projectNow(base) {
  const lines = (text) => text.split("\n").filter(Boolean);
  return {
    base,
    head: git("rev-parse", "HEAD"),
    commits: lines(git("log", "--format=%H %s", `${base}..HEAD`)),
    status: lines(git("status", "--porcelain", "--untracked-files=all")).filter((line) => !line.includes(".seatwork/")),
    changed: [
      ...new Set([
        ...lines(git("diff", "--name-only", base)),
        ...lines(git("ls-files", "--others", "--exclude-standard")),
      ]),
    ].filter((path) => !path.startsWith(".seatwork/")),
  };
}

/** Runs a harness's process in the project, its events kept line by line, cut at the run's time or once `enough` has what a dry run came for. */
function harnessProcess(command, argv, env, enough = () => false) {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd: PROJECT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const events = [];
    let buffer = "";
    const out = fs.createWriteStream(join(outDir, "events.jsonl"));
    const err = fs.createWriteStream(join(outDir, "stderr.txt"));
    child.stdout.on("data", (chunk) => {
      out.write(chunk);
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      for (const line of parts)
        try {
          events.push(JSON.parse(line));
          // a dry run has what it came for once the CLI shows its start or its first call to the dead port
          if (enough(events[events.length - 1])) process.kill(-child.pid, "SIGKILL");
        } catch {
          // a line that is no JSON is the CLI's own talk
        }
    });
    child.stderr.pipe(err);
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone already
      }
    }, run.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end();
      err.end();
      done({ events, code });
    });
  });
}

/** A Claude seat as Paseo starts one: the room's prompt after the claude_code preset, its launch flags and folders, the room's tools over HTTP and Paseo's beside them. */
async function runClaude(seat, prompt, paseoServer) {
  const config = seat.made.config;
  const extra = config.providerOptions?.extraArgs ?? {};
  const dirs = config.providerOptions?.additionalDirectories ?? [];
  write(
    join(outDir, "mcp.json"),
    JSON.stringify({ mcpServers: { seatwork: config.mcpServers.seatwork, paseo: paseoServer } }, null, 2),
  );
  const { claudeDisallowed } = require(join(PLUGIN, "server", "policy.ts"));
  const denied = [
    ...claudeDisallowed(RAW_POLICY, c.role),
    ...RAW_POLICY.claude.deniedSkills.map((skill) => `Skill(skill:${skill})`),
  ];
  const argv = [
    "-p",
    prompt,
    "--model",
    config.model ?? run.model,
    "--effort",
    run.effort ?? config.thinkingOptionId ?? "high",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    c.writes ? MODELS.modes.claude : "dontAsk",
    "--allowedTools",
    [
      "Read",
      "Grep",
      "Glob",
      "Skill",
      "mcp__seatwork",
      "mcp__paseo",
      ...READ_SHELL.map((name) => `Bash(${name}:*)`),
    ].join(","),
    "--disallowedTools",
    [...denied, ...(c.deny ?? [])].join(","),
    "--append-system-prompt",
    config.systemPrompt,
    ...Object.entries(extra).flatMap(([flag, value]) => (value === null ? [`--${flag}`] : [`--${flag}`, value])),
    ...dirs.flatMap((dir) => ["--add-dir", dir]),
    "--mcp-config",
    join(outDir, "mcp.json"),
    "--no-session-persistence",
    "--max-budget-usd",
    String(run.budget),
  ];
  const { events, code } = await harnessProcess(
    "claude",
    argv,
    { ...process.env, ...seat.env, ...DRY, ...claudeLogin() },
    (event) => !!run.dry && event.type === "system" && event.subtype === "init",
  );
  const calls = [];
  let result = null;
  const init = events.find((event) => event.type === "system" && event.subtype === "init") ?? null;
  for (const event of events) {
    if (event.type === "assistant")
      for (const block of event.message?.content ?? [])
        if (block.type === "tool_use") calls.push({ name: block.name, input: block.input });
    if (event.type === "result") result = event;
  }
  return {
    finished: !!result && !result.is_error,
    exit: code,
    cost: result?.total_cost_usd ?? null,
    calls,
    final: String(result?.result ?? ""),
    init: init && {
      tools: init.tools,
      mcp: init.mcp_servers,
      skills: init.skills,
      mode: init.permissionMode,
      model: init.model,
    },
  };
}

/** How a Claude seat logs in without the user's own Claude folder: a folder of the run's, and the token Paseo gives its seats (a fake key on a dry run, whose calls go nowhere). */
function claudeLogin() {
  const own = { CLAUDE_CONFIG_DIR: join(workDir, "claude") };
  if (run.dry) return { ...own, ANTHROPIC_API_KEY: "dry-run" };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return own;
  const config = JSON.parse(fs.readFileSync(join(process.env.HOME, ".paseo", "config.json"), "utf8"));
  const token = config.agents?.providers?.claude?.env?.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token)
    throw new Error("no Claude login for the seat: set CLAUDE_CODE_OAUTH_TOKEN, or Paseo's claude provider env");
  return { ...own, CLAUDE_CODE_OAUTH_TOKEN: token };
}

// a dry run starts the CLI whole and sends its first model call to a port nothing answers: no model is paid
const DRY = run.dry ? { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" } : {};
const READ_SHELL = [
  "git",
  "ls",
  "cat",
  "node",
  "npm",
  "wc",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "sed",
  "pwd",
  "echo",
];

/** A Codex seat as Paseo starts one: `codex exec` on the room's runtime home for the role, the room's prompt as developer instructions. */
async function runCodex(seat, prompt, paseoServer) {
  const config = seat.made.config;
  const toml = (value) => JSON.stringify(value);
  const argv = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    PROJECT,
    "-m",
    config.model ?? run.model,
    "-s",
    c.writes ? "workspace-write" : "read-only",
    "-c",
    `model_reasoning_effort=${toml(run.effort ?? config.thinkingOptionId ?? "high")}`,
    "-c",
    `developer_instructions=${toml(config.systemPrompt)}`,
    "-c",
    `mcp_servers.seatwork.url=${toml(config.mcpServers.seatwork.url)}`,
    "-c",
    `mcp_servers.paseo.command=${toml(paseoServer.command)}`,
    "-c",
    `mcp_servers.paseo.args=[${paseoServer.args.map(toml).join(",")}]`,
    "-c",
    `mcp_servers.paseo.env={${Object.entries(paseoServer.env)
      .map(([key, value]) => `${key}=${toml(value)}`)
      .join(",")}}`,
    "-c",
    'mcp_servers.seatwork.default_tools_approval_mode="approve"',
    "-c",
    'mcp_servers.paseo.default_tools_approval_mode="approve"',
    // a dry run talks to a provider of its own on a port nothing answers, never the user's
    ...(run.dry
      ? [
          "-c",
          'model_provider="dry"',
          "-c",
          'model_providers.dry={name="dry",base_url="http://127.0.0.1:9/v1",wire_api="responses"}',
        ]
      : []),
    prompt,
  ];
  write(join(outDir, "codex-argv.json"), JSON.stringify(argv, null, 2));
  const { events, code } = await harnessProcess(
    "codex",
    argv,
    { ...process.env, ...seat.env, ...DRY },
    (event) => !!run.dry && event.type === "error",
  );
  const calls = [];
  let final = "";
  let usage = null;
  let failed = false;
  for (const event of events) {
    if (event.type === "turn.completed") usage = event.usage ?? null;
    if (event.type === "turn.failed") failed = true;
    if (event.type !== "item.completed") continue;
    const item = event.item ?? {};
    if (item.type === "mcp_tool_call")
      calls.push({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} });
    else if (item.type === "command_execution") calls.push({ name: "Bash", input: { command: item.command } });
    else if (item.type === "file_change")
      calls.push({ name: "Edit", input: { file_path: (item.changes ?? []).map((one) => one.path).join(" ") } });
    else if (item.type === "agent_message") final = String(item.text ?? "");
  }
  return { finished: !!usage && !failed, exit: code, cost: null, calls, final };
}

/** A scripted seat, its right turn or its wrong one, run against the real room: a case is proved, its graders seen red, with no model. */
async function runScript(seat, ctx, paseo) {
  const script = (run.harness === "wrong" ? c.wrong : c.script)?.(ctx);
  if (!script) throw new Error(`${c.name} has no ${run.harness} turn`);
  const calls = [];
  const state = { kept: {} };
  for (const step of script.steps) {
    if (step.shell) {
      const command = typeof step.shell === "function" ? step.shell(state) : step.shell;
      calls.push({ name: "Bash", input: { command } });
      try {
        execFileSync("/bin/sh", ["-c", command], { cwd: PROJECT, env: { ...process.env, ...GIT_ENV }, stdio: "pipe" });
      } catch (error) {
        if (!step.mayFail) throw new Error(`script step failed: ${command}: ${error.stderr ?? error.message}`);
      }
    } else if (step.edit) {
      calls.push({ name: "Edit", input: { file_path: join(PROJECT, step.edit) } });
      write(join(PROJECT, step.edit), step.text);
    } else if (step.paseo) {
      calls.push({ name: `mcp__paseo__${step.paseo}`, input: step.args });
      await paseo(step.paseo, step.args);
    } else {
      const args = typeof step.args === "function" ? step.args(state) : step.args;
      calls.push({ name: `mcp__seatwork__${step.tool}`, input: args });
      const done = await mcp(seat.url, step.tool, args);
      fs.appendFileSync(join(outDir, "script.jsonl"), `${JSON.stringify({ tool: step.tool, args, ...done })}\n`);
      if (done.error && !step.mayFail) throw new Error(`script step refused: ${step.tool}: ${done.text}`);
      if (step.keep) state.kept[step.keep] = done.text;
    }
  }
  return { finished: true, exit: 0, cost: 0, calls, final: script.final };
}

/** A timeline item for each call, as Paseo records a turn: shell runs, file changes, other tools by name. */
function itemOf(call) {
  if (call.name === "Bash")
    return {
      type: "tool_call",
      status: "completed",
      detail: { type: "shell", command: String(call.input?.command ?? "") },
    };
  if (/^(Edit|Write|MultiEdit)$/.test(call.name))
    return {
      type: "tool_call",
      status: "completed",
      detail: { type: "edit", filePath: String(call.input?.file_path ?? "") },
    };
  if (call.name === "Read")
    return {
      type: "tool_call",
      status: "completed",
      detail: { type: "read", filePath: String(call.input?.file_path ?? "") },
    };
  return {
    type: "tool_call",
    status: "completed",
    name: call.name,
    detail: { type: "plain_text", label: call.name === "Skill" ? String(call.input?.skill ?? "") : "" },
  };
}

async function main() {
  const scripted = run.harness === "script" || run.harness === "wrong";
  if (!scripted && !run.spend && !run.dry)
    throw new Error("a run on a real agent CLI costs money: the runner passes --spend");
  installRoom();
  const base = makeProject();
  const stand = standInPaseo();
  const { fakeServer } = require(join(PLUGIN, "test", "support", "server.ts"));
  const contribute = require(join(PLUGIN, "index.server.ts")).default;
  const side = fakeServer();
  const stop = contribute(side.server);
  const created = [];
  const seats = {};

  /** A seat of the room, opened by the hooks Paseo fires, with its tools over the room's MCP server. */
  async function seat(provider, title, parent, options = {}) {
    const id = randomUUID();
    const cwd = options.cwd ?? PROJECT;
    const config = {
      provider,
      cwd,
      title,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinking ? { thinkingOptionId: options.thinking } : {}),
    };
    const made = await side.call("before agent.create", { request: { config, env: {} } }, stand.context);
    const opened = await side.call("before agent.session_open", {
      request: { env: made.env, reason: "create", agentId: id, provider, cwd, purpose: "interactive" },
    });
    stand.agents.set(id, {
      provider,
      cwd,
      title,
      parentAgentId: parent,
      status: options.status ?? "idle",
      updatedAt: new Date().toISOString(),
    });
    const agent = { id, parentAgentId: parent, provider, cwd, title, workspaceId: null };
    await side.call("on agent.created", { agent }, stand.context);
    const url = made.config.mcpServers.seatwork.url;
    return { id, agent, made, env: opened.env ?? {}, url, call: (tool, args) => mcp(url, tool, args) };
  }

  /** Paseo's tools as the seat under test calls them: a new agent goes through the room's hooks under the seat. */
  async function paseoTool(tool, args) {
    if (tool === "create_agent") {
      const [provider, model] = String(args.provider ?? "").split("/");
      const child = await seat(provider, String(args.title ?? ""), seats.seat, {
        model,
        thinking: args.settings?.thinkingOptionId,
      });
      created.push({
        id: child.id,
        title: args.title,
        provider: args.provider,
        settings: args.settings ?? null,
        notifyOnFinish: args.notifyOnFinish ?? null,
        initialPrompt: String(args.initialPrompt ?? ""),
      });
      return `created agent ${child.id} (${args.title})`;
    }
    if (tool === "list_agents")
      return (
        [...stand.agents]
          .filter(([, one]) => one.parentAgentId === seats.seat && !one.archivedAt)
          .map(([id, one]) => `${id} ${one.title} ${one.status}`)
          .join("\n") || "no agents"
      );
    if (tool === "get_agent_status" || tool === "get_agent_activity")
      return JSON.stringify(stand.agents.get(args.agentId) ?? { error: "no such agent" });
    if (tool === "send_agent_prompt") {
      stand.sent.set(args.agentId, [
        ...(stand.sent.get(args.agentId) ?? []),
        { text: String(args.prompt ?? ""), interrupt: false },
      ]);
      return "sent";
    }
    if (tool === "archive_agent" || tool === "cancel_agent") {
      const one = stand.agents.get(args.agentId);
      if (one && tool === "archive_agent") {
        one.archivedAt = new Date().toISOString();
        await side.call(
          "on agent.archived",
          { agent: { id: args.agentId, ...one }, archivedAt: one.archivedAt },
          stand.context,
        );
      }
      return `${tool === "archive_agent" ? "archived" : "canceled"} ${args.agentId}`;
    }
    if (tool === "list_models") return JSON.stringify(MODELS.peer.tiers);
    if (tool === "list_providers")
      return ROLES.flatMap((role) => HARNESSES.map((harness) => `${harness}-${role}`)).join("\n");
    return "done";
  }

  const control = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      const { tool, args } = JSON.parse(body);
      const out = await paseoTool(tool, args).then(
        (text) => ({ text }),
        (error) => ({ text: String(error?.message ?? error), error: true }),
      );
      fs.appendFileSync(join(outDir, "paseo.jsonl"), `${JSON.stringify({ tool, args, ...out })}\n`);
      response.end(JSON.stringify(out));
    });
  });
  await new Promise((done) => control.listen(0, "127.0.0.1", done));
  const controlUrl = `http://127.0.0.1:${control.address().port}/`;
  try {
    const opened = {};
    const ctx = { project: PROJECT, base, seats, handle: (name) => opened[name] };
    // the seats around the seat under test, then the seat itself, then what reaches it before its turn
    const api = {
      mcp,
      seat: async (name, provider, title, parent = null, options) => {
        opened[name] = await seat(provider, title, parent ? (opened[parent]?.id ?? null) : null, options);
        seats[name] = opened[name].id;
        return opened[name];
      },
      // a fixture seat's turn ends as Paseo tells the room: its prompt, its calls, its last words
      turnEnds: async (name, final, calls = []) => {
        const timeline = [
          { type: "user_message", text: "the brief" },
          ...calls.map(itemOf),
          { type: "assistant_message", text: final },
        ];
        await side.call(
          "on agent.turn_ended",
          { agent: opened[name].agent, turnId: null, outcome: { kind: "completed" }, timeline },
          stand.context,
        );
        await settle(300);
      },
    };
    await c.arrange?.(api, ctx);
    const harness = scripted ? "claude" : run.harness;
    const { ROOM_PROJECT } = require(join(PLUGIN, "shared", "workflow.ts"));
    const home = c.role === "hq" ? join(HOME, ROOM_PROJECT) : PROJECT;
    const under = await seat(`${harness}-${c.role}`, c.title, c.owner ? (opened[c.owner]?.id ?? null) : null, {
      model: run.model,
      thinking: run.thinking,
      cwd: home,
    });
    opened.seat = under;
    seats.seat = under.id;
    await c.before?.(api, ctx);
    await settle(200);
    ctx.delivered = () => (stand.sent.get(under.id) ?? []).map((one) => one.text).join("\n\n");
    const prompt = typeof c.prompt === "function" ? c.prompt(ctx) : c.prompt;
    if (!String(prompt ?? "").trim()) {
      const mail = roomNow(stand, created, seats).mail.map(
        (one) => `#${one.id} ${one.from} -> ${one.to.join(",")}: ${one.subject}`,
      );
      throw new Error(`the case handed the seat no prompt: nothing reached it\n${mail.join("\n")}`);
    }
    write(join(outDir, "system-prompt.md"), under.made.config.systemPrompt);
    write(join(outDir, "prompt.md"), prompt);
    const paseoServer = {
      command: process.execPath,
      args: [join(__dirname, "paseo-stub.mjs")],
      env: { EVAL_CONTROL_URL: controlUrl, EVAL_PASEO_TOOLS: (RAW_POLICY.paseoTools?.allow?.[c.role] ?? []).join(",") },
    };
    const started = Date.now();
    // what the seat changed is read from the head it starts its turn on
    const turnBase = git("rev-parse", "HEAD");
    const done = scripted
      ? await runScript(under, ctx, paseoTool)
      : run.harness === "codex"
        ? await runCodex(under, prompt, paseoServer)
        : await runClaude(under, prompt, paseoServer);
    const timeline = [
      { type: "user_message", text: prompt },
      ...done.calls.map(itemOf),
      { type: "assistant_message", text: done.final },
    ];
    await side.call(
      "on agent.turn_ended",
      {
        agent: under.agent,
        turnId: null,
        outcome: done.finished
          ? { kind: "completed" }
          : { kind: "failed", error: { message: "the run did not finish" } },
        timeline,
      },
      stand.context,
    );
    await settle(500);
    const outcome = {
      case: c.name,
      run,
      finished: done.finished,
      exit: done.exit,
      cost: done.cost,
      seconds: Math.round((Date.now() - started) / 1000),
      final: done.final,
      calls: done.calls,
      ...(done.init ? { init: done.init } : {}),
      room: roomNow(stand, created, seats),
      project: projectNow(turnBase),
    };
    outcome.grades = grade(c.grades, outcome);
    outcome.passed = outcome.finished && outcome.grades.every((one) => one.ok);
    write(join(outDir, "final.md"), done.final);
    write(join(outDir, "outcome.json"), JSON.stringify(outcome, null, 2));
  } finally {
    control.close();
    await stop();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    write(join(outDir, "error.txt"), String(error?.stack ?? error));
    process.exit(1);
  },
);
