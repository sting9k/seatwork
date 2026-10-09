#!/usr/bin/env node
/**
 * Evals for the room's prompts. Each case opens one real seat session the way the plugin opens it: the prompt
 * it assembles (role, specialization, harness sheet, project block), the role's skills, and stand-in MCP
 * servers for `slp` and `paseo` (stub-mcp.mjs). Claude seats run through `claude -p`, Codex seats through
 * `codex exec` on the runtime the plugin builds. The transcript is then graded by the case's graders.
 *
 *   node evals/run.cjs --label baseline [--only <regex on case name>] [--harness claude|codex] [--jobs 3] [--budget 4] [--list]
 *   node evals/run.cjs --regrade baseline          # grade saved transcripts again with the current graders
 *   node evals/run.cjs --label old --room-from <dir> # take the room files from another copy (an earlier run's)
 *
 * Output: evals/results/<label>/report.md and summary.json, plus one folder per run with the system prompt,
 * the prompt, the events and the stub's call log. Needs `claude` (and `codex`) signed in; every run costs tokens.
 */
"use strict";
const { spawn, execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const EVALS = __dirname;
const ROOM = resolve(EVALS, "..");
const args = parseArgs(process.argv.slice(2));
const label = args.regrade ?? args.label ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const OUT = join(EVALS, "results", label);
const HOME = join(OUT, "room-home");
const cases = require("./cases.cjs").filter((c) => !args.only || new RegExp(args.only).test(c.name));

// the room's own tools per role; Paseo's come from policy.json
const SLP_TOOLS = {
  hq: ["slp_mail", "slp_inbox", "slp_adopt", "slp_projects", "slp_register_project", "slp_room_stats"],
  supervisor: ["slp_mail", "slp_inbox", "slp_adopt"],
  lead: ["slp_mail", "slp_inbox", "slp_adopt"],
  peer: ["slp_mail", "slp_inbox"],
  lens: ["slp_mail", "slp_inbox"],
};
// what a Claude seat may run without asking; cases add Edit/Write when the brief is writable
const BASE_ALLOW = ["Read", "Grep", "Glob", "Skill", "mcp__slp", "mcp__paseo", ...["git", "ls", "cat", "node", "npm", "wc", "head", "tail", "grep", "rg", "find", "sed", "pwd", "mkdir", "chmod", "shasum", "echo"].map((c) => `Bash(${c}:*)`)];
const TIMEOUT_MS = Number(args.timeout ?? 20) * 60_000;

let plugin = null; // the plugin's prompt assembly and runtime builder, loaded only for real runs

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
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  cpSync(args["room-from"] ? resolve(args["room-from"]) : join(ROOM, "room"), join(HOME, "room"), { recursive: true });
  cpSync(join(ROOM, "paseo", "policy.json"), join(HOME, "policy.json"));
  writeFileSync(join(HOME, "seats.json"), JSON.stringify({ providers: ["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "claude-lens", "codex-peer", "codex-lens"] }));
  process.env.SLP_ROOM_HOME = HOME;
  require("../plugin/test/register.cjs");
  const { rolePrompt, specFromTitle } = require("../plugin/server/seats");
  const { projectBlock } = require("../plugin/server/registry");
  const { loadPolicy } = require("../plugin/server/policy");
  const { loadModels } = require("../plugin/server/models");
  const { ensureRuntime } = require("../plugin/server/runtimes");
  plugin = { rolePrompt, specFromTitle, projectBlock, ensureRuntime, policy: loadPolicy(), models: loadModels(), rawPolicy: JSON.parse(readFileSync(join(ROOM, "paseo", "policy.json"), "utf8")) };
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
  else if (c.role === "peer") runs = ["default", "cheap", "cross-family"].map((tier) => models.peer.tiers[tier]).filter(Boolean).map((tier) => seat(tier.providers[0], tier.thinking));
  else if (c.role === "lens") runs = models.lens.pair.map((provider) => seat(provider, models.lens.thinking));
  else runs = [seat(models.seats[c.role].provider, models.seats[c.role].thinking)];
  // --codex-model <model>: also run every role on Codex with that model, to measure roles models.json keeps on Claude
  if (args["codex-model"] && !runs.some((run) => run.harness === "codex")) runs.push({ harness: "codex", model: args["codex-model"], effort: runs[0]?.effort ?? "high", note: "not a room seat" });
  return runs.filter((run) => ["claude", "codex"].includes(run.harness) && (!args.harness || run.harness === args.harness));
}

const skillDirs = new Map();
/** A directory whose .claude/skills holds the role's skills, as the plugin links them for a Claude seat. */
function skillsDirFor(role) {
  if (skillDirs.has(role)) return skillDirs.get(role);
  const dir = join(OUT, "skills", role);
  const target = join(dir, ".claude", "skills");
  mkdirSync(target, { recursive: true });
  const source = join(HOME, "room", "skills", role); // the copy taken at start, so edits during a run change nothing
  if (existsSync(source)) for (const name of readdirSync(source)) symlinkSync(join(source, name), join(target, name));
  skillDirs.set(role, dir);
  return dir;
}

function git(cwd, ...argv) {
  execFileSync("git", ["-c", "user.email=eval@room", "-c", "user.name=eval", ...argv], { cwd, stdio: "ignore" });
}

/** Runs a harness CLI that prints one JSON event per line; returns the events and the exit code. */
function harnessProcess(command, argv, cwd, dir, extraEnv) {
  return new Promise((done) => {
    const env = { ...process.env, ...extraEnv };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const events = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += "\n[eval] timeout: killed\n";
      child.kill("SIGKILL");
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
      writeFileSync(join(dir, "stderr.txt"), stderr);
      writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
      done({ events, code });
    });
  });
}

function matchesWhere(tool, g) {
  if (g.input && !new RegExp(g.input, "s").test(JSON.stringify(tool.input ?? {}))) return false;
  for (const [key, pattern] of Object.entries(g.where ?? {})) {
    const value = tool.input?.[key];
    if (value === undefined) return false;
    if (!new RegExp(pattern, "s").test(typeof value === "string" ? value : JSON.stringify(value))) return false;
  }
  return true;
}

/** One grader against one run. Shapes: signal, first_line, last_line, text, not_text, tool, no_tool, any_of. */
function grade(g, ctx) {
  const { text, lines, tools } = ctx;
  if (g.any_of) return g.any_of.some((inner) => grade(inner, ctx));
  if (g.signal) {
    const re = new RegExp(`^${g.signal}\\b`);
    const mailed = tools.some((t) => /slp_mail$/.test(t.name) && (re.test(String(t.input?.subject ?? "").trim()) || re.test(String(t.input?.body ?? "").trim())));
    return re.test(lines[0] ?? "") || mailed;
  }
  if (g.first_line) return new RegExp(g.first_line).test(lines[0] ?? "");
  if (g.last_line) return new RegExp(g.last_line).test(lines[lines.length - 1] ?? "");
  if (g.text) return new RegExp(g.text, "m").test(text);
  if (g.not_text) return !new RegExp(g.not_text, "m").test(text);
  if (g.tool) {
    const hits = tools.filter((t) => new RegExp(g.tool).test(t.name) && matchesWhere(t, g));
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

/** Lines of the final message with markdown dressing (bold, heading marks, quotes) stripped: a model reads through it. */
const plainLines = (text) =>
  text
    .split("\n")
    .map((l) => l.trim().replace(/^[#>*_` ]+/, "").replace(/[*_`]+$/, "").trim())
    .filter((l) => l && !/^-{3,}$/.test(l));

function graded(c, outcome) {
  const text = String(outcome.text ?? "");
  const ctx = { text, lines: plainLines(text), tools: outcome.tools ?? [] };
  const graders = c.graders.map((g) => ({ id: g.id, pass: safeGrade(g, ctx) }));
  const finished = outcome.finished ?? outcome.subtype === "success";
  return { ...outcome, finished, pass: graders.every((g) => g.pass) && finished, failed: graders.filter((g) => !g.pass).map((g) => g.id) };
}

const runDir = (c, run) => join(OUT, "runs", `${c.name}@${run.model}`.replace(/[^a-z0-9@.-]/gi, "_"));

/** The working directory, stub servers and prompts a run starts with, whichever harness runs it. */
function prepare(c, run) {
  const dir = runDir(c, run);
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const fill = (s) => String(s).replace(/\{\{cwd\}\}/g, cwd);

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
  for (const server of ["slp", "paseo"]) {
    const tools = (server === "slp" ? SLP_TOOLS[c.role] : plugin.rawPolicy.paseoTools.allow[c.role]).filter((t) => !(c.hide ?? []).includes(t));
    if (tools.length === 0) continue;
    servers[server] = {
      command: process.execPath,
      args: [join(EVALS, "stub-mcp.mjs")],
      env: { SLP_EVAL_SERVER: server, SLP_EVAL_TOOLS: tools.join(","), SLP_EVAL_STATE: statePath, SLP_EVAL_LOG: join(dir, "calls.jsonl") },
    };
  }

  const spec = c.spec ?? plugin.specFromTitle(c.title);
  const parts = [plugin.rolePrompt(c.role, { harness: run.harness, spec, params: plugin.policy.room.params, models: plugin.models })];
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
  const disallowed = [...plugin.rawPolicy.claude.disallowedTools[c.role], ...plugin.rawPolicy.claude.deniedSkills.map((s) => `Skill(skill:${s})`)];
  const argv = [
    "-p", p.prompt,
    "--model", run.model,
    "--effort", run.effort,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk",
    "--allowedTools", [...BASE_ALLOW, ...(c.allow ?? [])].join(","),
    "--disallowedTools", disallowed.join(","),
    "--append-system-prompt", p.system,
    "--setting-sources", "project,local",
    "--strict-mcp-config", "--mcp-config", join(p.dir, "mcp.json"),
    "--add-dir", skillsDirFor(c.role),
    "--no-session-persistence",
    "--max-budget-usd", String(args.budget ?? 4),
  ];
  const { events, code } = await harnessProcess("claude", argv, p.cwd, p.dir, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  const tools = [];
  let result = null;
  let init = null;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") init = e;
    if (e.type === "assistant") for (const block of e.message?.content ?? []) if (block.type === "tool_use") tools.push({ name: block.name, input: block.input });
    if (e.type === "result") result = e;
  }
  return {
    finished: Boolean(result) && !result.is_error, exit: code, subtype: result?.subtype ?? null,
    turns: result?.num_turns ?? null, cost: result?.total_cost_usd ?? null, tokens: null,
    denials: (result?.permission_denials ?? []).map((d) => d.tool_name), skills: init?.skills ?? null,
    tools, text: String(result?.result ?? ""),
  };
}

/** A Codex seat: `codex exec` on the runtime the plugin builds (CODEX_HOME), the prompt as developer instructions. */
async function runCodex(c, run, p) {
  const runtime = plugin.ensureRuntime({ harness: "codex", role: c.role }, plugin.policy);
  const toml = (value) => JSON.stringify(value); // a JSON string is a valid TOML basic string
  const argv = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", p.cwd, "-m", run.model, "-s", p.writable ? "workspace-write" : "read-only", "-c", `model_reasoning_effort=${toml(run.effort)}`, "-c", `developer_instructions=${toml(p.system)}`];
  for (const [name, server] of Object.entries(p.servers)) {
    argv.push("-c", `mcp_servers.${name}.command=${toml(server.command)}`);
    argv.push("-c", `mcp_servers.${name}.args=[${server.args.map(toml).join(",")}]`);
    argv.push("-c", `mcp_servers.${name}.env={${Object.entries(server.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`);
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
    if (item.type === "mcp_tool_call") tools.push({ name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} });
    else if (item.type === "command_execution") tools.push({ name: "Bash", input: { command: item.command } });
    else if (item.type === "file_change") tools.push({ name: "Edit", input: { file_path: (item.changes ?? []).map((ch) => ch.path).join(" ") } });
    else if (item.type === "agent_message") text = String(item.text ?? "");
  }
  return {
    finished: Boolean(usage) && !failed, exit: code, subtype: usage ? "success" : "no turn.completed",
    turns: tools.length, cost: null, tokens: usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : null,
    denials: [], skills: null, tools, text,
  };
}

async function runOne(c, run) {
  const started = Date.now();
  const p = prepare(c, run);
  const raw = run.harness === "codex" ? await runCodex(c, run, p) : await runClaude(c, run, p);
  const outcome = graded(c, { case: c.name, role: c.role, harness: run.harness, model: run.model, effort: run.effort, note: run.note ?? null, minutes: Number(((Date.now() - started) / 60_000).toFixed(1)), ...raw });
  writeFileSync(join(p.dir, "result.json"), JSON.stringify(outcome, null, 2));
  writeFileSync(join(p.dir, "final.md"), outcome.text);
  console.log(line(outcome));
  return outcome;
}

const spent = (r) => (r.cost != null ? `$${r.cost.toFixed(2)}` : r.tokens != null ? `${Math.round(r.tokens / 1000)}k tok` : "?");
const line = (r) => `${r.pass ? "PASS" : "FAIL"}  ${r.case}@${r.model}  ${r.failed.join(",") || "-"}  turns=${r.turns} ${spent(r)} ${r.minutes}min`;

function report(results) {
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOM, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--short", "--", "room"], { cwd: ROOM, encoding: "utf8" }).trim() ? " (room files modified)" : "";
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const rows = results
    .sort((a, b) => a.case.localeCompare(b.case) || a.model.localeCompare(b.model))
    .map((r) => `| ${r.case} | ${r.harness ?? "claude"} ${r.model} ${r.effort}${r.note ? ` (${r.note})` : ""} | ${r.pass ? "pass" : "FAIL"} | ${r.failed.join(", ")} | ${r.turns ?? "?"} | ${spent(r)} | ${r.minutes} |`)
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
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ label, head, dirty: Boolean(dirty), passed, total: results.length, cost, results: results.map(({ text, tools, skills, ...r }) => r) }, null, 2));
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
          results.push({ case: job.c.name, role: job.c.role, harness: job.run.harness, model: job.run.model, effort: job.run.effort, note: null, pass: false, failed: [`harness: ${error.message}`], turns: null, cost: 0, tokens: null, minutes: 0 });
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
