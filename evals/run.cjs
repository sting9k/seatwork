#!/usr/bin/env node
/**
 * Evals for the room's prompts: each case opens one real seat session as the plugin opens it, then grades the transcript.
 *   node evals/run.cjs --label baseline [--only <regex on case name>] [--harness claude|codex] [--jobs 3] [--budget 4] [--timeout 20] [--list]
 *   node evals/run.cjs --regrade baseline          # grade saved transcripts again with the current graders
 *   node evals/run.cjs --label old --room-from <dir> # take the room files from another copy (an earlier run's)
 */
"use strict";
const { spawn, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

const EVALS = __dirname;
const ROOM = resolve(EVALS, "..");
const args = parseArgs(process.argv.slice(2));
const label = args.regrade ?? args.label ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const OUT = join(EVALS, "results", label);
// What a seat can see (its directory, its skills, the room home) is named after
// nothing: "evals" or a case's name in a path tells it that it is graded, and on what.
const short = (text) => createHash("sha1").update(text).digest("hex").slice(0, 6);
const WORK = join(realpathSync(tmpdir()), `sw-${short(OUT)}`);
const HOME = join(WORK, "home");
const cases = require("./cases.cjs").filter((c) => !args.only || new RegExp(args.only).test(c.name));

// A run shows a seat the room tools its role is not refused; a real seat is listed all.
const ROOM_TOOLS = require("../plugin/shared/tools.json").tools;
const seatworkTools = (role) =>
  Object.entries(ROOM_TOOLS)
    .filter(
      ([, tool]) =>
        tool.callers === "any" ||
        (tool.callers === "spawners" ? plugin.rawPolicy.room.spawn[role]?.length > 0 : tool.callers.includes(role)),
    )
    .map(([name]) => name);
// what a Claude seat may run without asking; cases add Edit/Write when the brief is writable
const BASE_ALLOW = [
  "Read",
  "Grep",
  "Glob",
  "Skill",
  "mcp__seatwork",
  "mcp__paseo",
  ...[
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
    "mkdir",
    "chmod",
    "shasum",
    "echo",
  ].map((c) => `Bash(${c}:*)`),
];
const TIMEOUT_MS = Number(args.timeout ?? 20) * 60_000;

let plugin = null; // loaded only for real runs

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

/** A throwaway room home with this checkout's room files (or --room-from's), then the plugin's own code. */
function setup() {
  for (const stale of [OUT, WORK]) rmSync(stale, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  cpSync(args["room-from"] ? resolve(args["room-from"]) : join(ROOM, "plugin", "room"), join(HOME, "room"), {
    recursive: true,
  });
  cpSync(join(ROOM, "plugin", "paseo", "policy.json"), join(HOME, "policy.json"));
  writeFileSync(
    join(HOME, "seats.json"),
    JSON.stringify({
      providers: Object.entries(require("../plugin/paseo/seats.json").seats).flatMap(([role, harnesses]) =>
        harnesses.map((harness) => `${harness}-${role}`),
      ),
    }),
  );
  process.env.SEATWORK_ROOM_HOME = HOME;
  require("../plugin/test/register.cjs");
  const { rolePrompt, specFromTitle } = require("../plugin/server/orchestration/seats");
  const { projectBlock } = require("../plugin/server/orchestration/registry");
  const { loadPolicy, claudeDisallowed } = require("../plugin/server/policy");
  const { loadModels } = require("../plugin/server/orchestration/models");
  const { ensureRuntime } = require("../plugin/server/orchestration/runtimes");
  plugin = {
    rolePrompt,
    specFromTitle,
    projectBlock,
    ensureRuntime,
    claudeDisallowed,
    policy: loadPolicy(),
    models: loadModels(),
    rawPolicy: JSON.parse(readFileSync(join(ROOM, "plugin", "paseo", "policy.json"), "utf8")),
  };
}

/** `codex-peer/gpt-6.1-sol` → { harness: "codex", model: "gpt-6.1-sol" }. */
function seat(provider, effort) {
  const [id, model] = provider.split("/");
  return { harness: id.split("-")[0], model, effort };
}

/** The runs a case gets: what models.json gives its role, filtered by --harness. */
function runsFor(c) {
  const { models } = plugin;
  let runs;
  if (c.runs) runs = c.runs;
  else if (c.role === "peer")
    runs = (args.tiers ? String(args.tiers).split(",") : ["default", "cheap", "cross-family"])
      .map((tier) => models.peer.tiers[tier])
      .filter(Boolean)
      .map((tier) => seat(tier.providers[0], tier.thinking));
  // two lenses, two models: the tiers a pair is made of, or every tier of a table that names them otherwise
  else if (c.role === "lens")
    runs = (
      ["high", "extra"].every((tier) => models.lens.tiers[tier]) ? ["high", "extra"] : Object.keys(models.lens.tiers)
    ).map((tier) => seat(models.lens.tiers[tier].providers[0], models.lens.tiers[tier].thinking));
  else runs = [seat(models.seats[c.role].provider, models.seats[c.role].thinking)];
  // --codex-model <model>: also run every role on Codex with that model
  if (args["codex-model"] && !runs.some((run) => run.harness === "codex"))
    runs.push({
      harness: "codex",
      model: args["codex-model"],
      effort: runs[0]?.effort ?? "high",
      note: "not a room seat",
    });
  // --effort <level>: every run at that thinking level, whatever models.json gives the seat
  if (args.effort) runs = runs.map((run) => ({ ...run, effort: String(args.effort) }));
  // a case may name the one harness it means anything on (`harness: "claude"`)
  return runs.filter(
    (run) =>
      ["claude", "codex"].includes(run.harness) &&
      (!args.harness || run.harness === args.harness) &&
      (!c.harness || run.harness === c.harness),
  );
}

const skillDirs = new Map();
/** A directory whose .claude/skills holds the role's skills, as the plugin links them for a Claude seat. */
function skillsDirFor(role) {
  if (skillDirs.has(role)) return skillDirs.get(role);
  const dir = join(WORK, "skills", role);
  const target = join(dir, ".claude", "skills");
  mkdirSync(target, { recursive: true });
  const source = join(HOME, "room", "skills", role); // the copy taken at start, so edits during a run change nothing
  if (existsSync(source)) for (const name of readdirSync(source)) symlinkSync(join(source, name), join(target, name));
  skillDirs.set(role, dir);
  return dir;
}

function git(cwd, ...argv) {
  execFileSync("git", ["-c", "user.email=dev@example.com", "-c", "user.name=dev", ...argv], { cwd, stdio: "ignore" });
}

const live = new Set();
function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group is already gone
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const pid of live) killGroup(pid);
    process.exit(1);
  });

/** Runs a harness CLI that prints one JSON event per line; returns the events and the exit code. */
function harnessProcess(command, argv, cwd, dir, extraEnv) {
  return new Promise((done) => {
    const env = { ...process.env, ...extraEnv };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    // its own process group: a scan the seat left running dies with the run instead of outliving it
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    live.add(child.pid);
    const events = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += "\n[eval] timeout: killed\n";
      killGroup(child.pid);
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          stderr += `[eval] not json: ${line.slice(0, 200)}\n`;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `[eval] ${error.message}\n`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      killGroup(child.pid); // whatever the seat started in the background
      live.delete(child.pid);
      writeFileSync(join(dir, "stderr.txt"), stderr);
      writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
      done({ events, code });
    });
  });
}

/** A shell command without its here-document bodies: text written into a file did not run. */
const withoutHeredocs = (command) => command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, "<<$2");

function matchesWhere(tool, g) {
  if (g.input && !new RegExp(g.input, "s").test(JSON.stringify(tool.input ?? {}))) return false;
  for (const [key, pattern] of Object.entries(g.where ?? {})) {
    // `opens`: the signal a mail opens with, in its subject or as the first words of its body
    const values = key === "opens" ? [tool.input?.subject, tool.input?.body] : [tool.input?.[key]];
    const texts = values
      .filter((value) => value !== undefined)
      .map((value) =>
        typeof value === "string" ? (key === "command" ? withoutHeredocs(value) : value) : JSON.stringify(value),
      );
    if (!texts.some((text) => new RegExp(pattern, "s").test(text))) return false;
  }
  return true;
}

/** One grader against one run: signal, first_line, last_line, text, not_text, tool, no_tool, any_of. */
function grade(g, ctx) {
  const { text, lines, tools } = ctx;
  if (g.any_of) return g.any_of.some((inner) => grade(inner, ctx));
  if (g.signal) {
    const re = new RegExp(`^${g.signal}\\b`);
    const mailed = tools.some(
      (t) =>
        /seatwork_mail$/.test(t.name) &&
        (re.test(String(t.input?.subject ?? "").trim()) || re.test(String(t.input?.body ?? "").trim())),
    );
    return re.test(lines[0] ?? "") || mailed;
  }
  if (g.first_line) return new RegExp(g.first_line).test(lines[0] ?? "");
  if (g.last_line) return new RegExp(g.last_line).test(lines[lines.length - 1] ?? "");
  if (g.text) return new RegExp(g.text, "m").test(text);
  if (g.not_text) return !new RegExp(g.not_text, "m").test(text);
  if (g.tool) {
    const hits = tools.filter((t) => new RegExp(g.tool).test(t.name) && matchesWhere(t, g));
    // distinct: "<input field>": no two of the matching calls carry the same value there
    if (g.distinct && new Set(hits.map((t) => JSON.stringify(t.input?.[g.distinct]))).size !== hits.length)
      return false;
    return hits.length >= (g.min ?? 1) && hits.length <= (g.max ?? Infinity);
  }
  if (g.no_tool) return !tools.some((t) => new RegExp(g.no_tool).test(t.name) && matchesWhere(t, g));
  throw new Error(`unknown grader shape: ${JSON.stringify(g)}`);
}

function safeGrade(g, ctx) {
  try {
    return grade(g, ctx);
  } catch (error) {
    console.error(`grader ${g.id}: ${error.message}`);
    return false;
  }
}

/** Lines of the final message with markdown dressing (bold, headings, quotes) stripped. */
const plainLines = (text) =>
  text
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^[#>*_` ]+/, "")
        .replace(/[*_`]+$/, "")
        .trim(),
    )
    .filter((l) => l && !/^-{3,}$/.test(l));

function graded(c, outcome) {
  const text = String(outcome.text ?? "");
  const ctx = { text, lines: plainLines(text), tools: outcome.tools ?? [] };
  const graders = c.graders.map((g) => ({ id: g.id, pass: safeGrade(g, ctx) }));
  const finished = outcome.finished ?? outcome.subtype === "success";
  return {
    ...outcome,
    finished,
    pass: graders.every((g) => g.pass) && finished,
    failed: graders.filter((g) => !g.pass).map((g) => g.id),
  };
}

const runDir = (c, run) => join(OUT, "runs", `${c.name}@${run.model}`.replace(/[^a-z0-9@.-]/gi, "_"));

/** The working directory, stub servers and prompts a run starts with, whichever harness runs it. */
function prepare(c, run) {
  const dir = runDir(c, run);
  mkdirSync(dir, { recursive: true });
  const cwd = join(WORK, `work-${short(dir)}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  // {{cwd}} is the run's project directory; {{minutes_ago:N}} an ISO time N minutes before the run starts
  const startedAt = Date.now();
  const fill = (s) =>
    String(s)
      .replace(/\{\{cwd\}\}/g, cwd)
      .replace(/\{\{minutes_ago:(\d+)\}\}/g, (_, m) => new Date(startedAt - Number(m) * 60_000).toISOString());

  if (c.fixture) cpSync(join(EVALS, "fixtures", c.fixture), cwd, { recursive: true });
  if (c.fixture && c.git !== false) {
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "base");
  }
  if (c.after) cpSync(join(EVALS, "fixtures", c.after), cwd, { recursive: true }); // an uncommitted candidate
  for (const [rel, text] of Object.entries(c.files ?? {})) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), fill(text));
  }
  for (const [rel, text] of Object.entries(c.roomFiles ?? {})) writeFileSync(join(HOME, rel), fill(text));

  const statePath = join(dir, "state.json");
  writeFileSync(statePath, fill(JSON.stringify({ cwd, ...(c.state ?? {}) })));
  const servers = {};
  for (const server of ["seatwork", "paseo"]) {
    const tools = (server === "seatwork" ? seatworkTools(c.role) : plugin.rawPolicy.paseoTools.allow[c.role]).filter(
      (t) => !(c.hide ?? []).includes(t),
    );
    if (tools.length === 0) continue;
    servers[server] = {
      command: process.execPath,
      args: [join(EVALS, "stub-mcp.mjs")],
      env: {
        SEATWORK_EVAL_SERVER: server,
        SEATWORK_EVAL_TOOLS: tools.join(","),
        SEATWORK_EVAL_STATE: statePath,
        SEATWORK_EVAL_LOG: join(dir, "calls.jsonl"),
      },
    };
  }

  const spec = c.spec ?? plugin.specFromTitle(c.title);
  const parts = [
    plugin.rolePrompt(c.role, { harness: run.harness, spec, params: plugin.policy.room.params, models: plugin.models }),
  ];
  if (c.project) parts.push(plugin.projectBlock(c.project.name, cwd, c.project.mission ?? null, c.project.law ?? null));
  const system = parts.join("\n\n");
  const prompt = fill(c.prompt);
  writeFileSync(join(dir, "system-prompt.md"), system);
  writeFileSync(join(dir, "prompt.md"), prompt);
  return { dir, cwd, servers, system, prompt, writable: (c.allow ?? []).some((t) => /^(Edit|Write)$/.test(t)) };
}

/** A Claude seat: `claude -p` with the prompt appended to the claude_code preset, as Paseo does. */
async function runClaude(c, run, p) {
  writeFileSync(join(p.dir, "mcp.json"), JSON.stringify({ mcpServers: p.servers }, null, 2));
  const disallowed = [
    ...plugin.claudeDisallowed(plugin.rawPolicy, c.role),
    ...plugin.rawPolicy.claude.deniedSkills.map((s) => `Skill(skill:${s})`),
  ];
  // the flags and the env a real Claude seat starts with (policy `claude.launch`)
  const launch = plugin.rawPolicy.claude.launch;
  const launchFlags = Object.entries(launch.extraArgs).flatMap(([flag, value]) =>
    value === null ? [`--${flag}`] : [`--${flag}`, value],
  );
  const argv = [
    "-p",
    p.prompt,
    "--model",
    run.model,
    "--effort",
    run.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    // a case that may edit runs in the real seat's mode: the room's procedures write through the shell
    "--permission-mode",
    p.writable ? plugin.models.modes.claude : "dontAsk",
    "--allowedTools",
    [...BASE_ALLOW, ...(c.allow ?? [])].join(","),
    "--disallowedTools",
    [...disallowed, ...(c.deny ?? [])].join(","), // `deny`: what this case's seat is refused, whatever its mode allows
    "--append-system-prompt",
    p.system,
    ...launchFlags,
    "--mcp-config",
    join(p.dir, "mcp.json"),
    "--add-dir",
    skillsDirFor(c.role),
    "--no-session-persistence",
    "--max-budget-usd",
    String(args.budget ?? 4),
  ];
  const { events, code } = await harnessProcess("claude", argv, p.cwd, p.dir, launch.env);
  const tools = [];
  let result = null;
  let init = null;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") init = e;
    if (e.type === "assistant")
      for (const block of e.message?.content ?? [])
        if (block.type === "tool_use") tools.push({ name: block.name, input: block.input });
    if (e.type === "result") result = e;
  }
  return {
    finished: Boolean(result) && !result.is_error,
    exit: code,
    subtype: result?.subtype ?? null,
    turns: result?.num_turns ?? null,
    cost: result?.total_cost_usd ?? null,
    tokens: null,
    denials: (result?.permission_denials ?? []).map((d) => d.tool_name),
    skills: init?.skills ?? null,
    tools,
    text: String(result?.result ?? ""),
  };
}

/** A Codex seat: `codex exec` on the runtime the plugin builds, the prompt as developer instructions. */
async function runCodex(c, run, p) {
  const runtime = plugin.ensureRuntime({ harness: "codex", role: c.role }, plugin.policy);
  const toml = (value) => JSON.stringify(value); // a JSON string is a valid TOML basic string
  const argv = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    p.cwd,
    "-m",
    run.model,
    "-s",
    p.writable ? "workspace-write" : "read-only",
    "-c",
    `model_reasoning_effort=${toml(run.effort)}`,
    "-c",
    `developer_instructions=${toml(p.system)}`,
  ];
  for (const [name, server] of Object.entries(p.servers)) {
    argv.push("-c", `mcp_servers.${name}.command=${toml(server.command)}`);
    argv.push("-c", `mcp_servers.${name}.args=[${server.args.map(toml).join(",")}]`);
    argv.push(
      "-c",
      `mcp_servers.${name}.env={${Object.entries(server.env)
        .map(([k, v]) => `${k}=${toml(v)}`)
        .join(",")}}`,
    );
    argv.push("-c", `mcp_servers.${name}.default_tools_approval_mode="approve"`);
  }
  argv.push(p.prompt);
  writeFileSync(join(p.dir, "codex-argv.json"), JSON.stringify(argv, null, 2));
  const { events, code } = await harnessProcess("codex", argv, p.cwd, p.dir, { CODEX_HOME: runtime });
  const tools = [];
  let text = "";
  let usage = null;
  let failed = false;
  for (const e of events) {
    if (e.type === "turn.completed") usage = e.usage ?? null;
    if (e.type === "turn.failed") failed = true; // an `error` event is a transient stream notice; the turn still completes
    if (e.type !== "item.completed") continue;
    const item = e.item ?? {};
    if (item.type === "mcp_tool_call")
      tools.push({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} });
    else if (item.type === "command_execution") tools.push({ name: "Bash", input: { command: item.command } });
    else if (item.type === "file_change")
      tools.push({ name: "Edit", input: { file_path: (item.changes ?? []).map((ch) => ch.path).join(" ") } });
    else if (item.type === "agent_message") text = String(item.text ?? "");
  }
  return {
    finished: Boolean(usage) && !failed,
    exit: code,
    subtype: usage ? "success" : "no turn.completed",
    turns: tools.length,
    cost: null,
    tokens: usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null,
    denials: [],
    skills: null,
    tools,
    text,
  };
}

async function runOne(c, run) {
  const started = Date.now();
  const p = prepare(c, run);
  const raw = run.harness === "codex" ? await runCodex(c, run, p) : await runClaude(c, run, p);
  const outcome = graded(c, {
    case: c.name,
    role: c.role,
    harness: run.harness,
    model: run.model,
    effort: run.effort,
    note: run.note ?? null,
    minutes: Number(((Date.now() - started) / 60_000).toFixed(1)),
    ...raw,
  });
  writeFileSync(join(p.dir, "result.json"), JSON.stringify(outcome, null, 2));
  writeFileSync(join(p.dir, "final.md"), outcome.text);
  try {
    // what the seat left in its directory is kept beside the transcript
    cpSync(p.cwd, join(p.dir, "cwd"), { recursive: true });
  } catch {
    // the transcript stands without it
  }
  console.log(line(outcome));
  return outcome;
}

const spent = (r) =>
  r.cost != null ? `$${r.cost.toFixed(2)}` : r.tokens != null ? `${Math.round(r.tokens / 1000)}k tok` : "?";
const line = (r) =>
  `${r.pass ? "PASS" : "FAIL"}  ${r.case}@${r.model}  ${r.failed.join(",") || "-"}  turns=${r.turns} ${spent(r)} ${r.minutes}min`;

function report(results) {
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOM, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--short", "--", "plugin/room"], { cwd: ROOM, encoding: "utf8" }).trim()
    ? " (room files modified)"
    : "";
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const rows = results
    .sort((a, b) => a.case.localeCompare(b.case) || a.model.localeCompare(b.model))
    .map(
      (r) =>
        `| ${r.case} | ${r.harness ?? "claude"} ${r.model} ${r.effort}${r.note ? ` (${r.note})` : ""} | ${r.pass ? "pass" : "FAIL"} | ${r.failed.join(", ")} | ${r.turns ?? "?"} | ${spent(r)} | ${r.minutes} |`,
    )
    .join("\n");
  const md = [
    `# Eval report: ${label}`,
    "",
    `${new Date().toISOString().slice(0, 16).replace("T", " ")} · room files at ${head}${dirty} · ${passed}/${results.length} runs pass · Claude $${cost.toFixed(2)} (Codex runs report tokens)`,
    "",
    "| case | seat | result | failed graders | turns | spent | min |",
    "|---|---|---|---|---|---|---|",
    rows,
    "",
    "Each run's folder under `runs/` holds the system prompt, the prompt, the events, the stub's call log and the final message.",
    "",
  ].join("\n");
  writeFileSync(join(OUT, "report.md"), md);
  writeFileSync(
    join(OUT, "summary.json"),
    JSON.stringify(
      {
        label,
        head,
        dirty: Boolean(dirty),
        passed,
        total: results.length,
        cost,
        results: results.map(({ text, tools, skills, ...r }) => r),
      },
      null,
      2,
    ),
  );
  console.log(`\n${passed}/${results.length} pass · Claude $${cost.toFixed(2)} · ${join(OUT, "report.md")}`);
}

/** Grades the saved transcripts of an earlier label again, with the graders in cases.cjs as they are now. */
function regrade() {
  const results = [];
  for (const c of cases) {
    const runs = join(OUT, "runs");
    if (!existsSync(runs)) continue;
    for (const name of readdirSync(runs)) {
      if (!name.startsWith(`${c.name}@`)) continue;
      const file = join(runs, name, "result.json");
      if (!existsSync(file)) continue;
      const outcome = graded(c, JSON.parse(readFileSync(file, "utf8")));
      writeFileSync(file, JSON.stringify(outcome, null, 2));
      console.log(line(outcome));
      results.push(outcome);
    }
  }
  report(results);
}

async function main() {
  if (args.regrade) return regrade();
  setup();
  const jobs = [];
  for (const c of cases) for (const run of runsFor(c)) jobs.push({ c, run });
  if (args.list) {
    for (const j of jobs) console.log(`${j.c.name} @ ${j.run.harness} ${j.run.model}/${j.run.effort}`);
    return;
  }
  const results = [];
  let next = 0;
  const width = Math.max(1, Math.min(Number(args.jobs ?? 3), jobs.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          results.push(await runOne(job.c, job.run));
        } catch (error) {
          console.log(`FAIL  ${job.c.name}@${job.run.model}  harness: ${error.message}`);
          results.push({
            case: job.c.name,
            role: job.c.role,
            harness: job.run.harness,
            model: job.run.model,
            effort: job.run.effort,
            note: null,
            pass: false,
            failed: [`harness: ${error.message}`],
            turns: null,
            cost: 0,
            tokens: null,
            minutes: 0,
          });
        }
      }
    }),
  );
  report(results);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
