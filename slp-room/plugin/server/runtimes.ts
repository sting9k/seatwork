import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOME, CODEX_HOME, OPENCODE_CONFIG_HOME, PI_HOME, ROLE_SKILLS_DIR, ROOM_DIR, RUNTIMES_DIR } from "./paths";
import { loadPolicy, type RuntimePolicy } from "./policy";
import type { Harness, Role, Seat } from "./seats";

/**
 * Keeps a seat apart from the user's own setup: Codex, Pi and OpenCode get a home under runtimes/,
 * Claude runs on ~/.claude with launch flags. Role prompts go through Paseo's systemPrompt, not here.
 */

const RUNTIME_VERSION = 11;
const MARKER = ".slp-runtime.json";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Symlink `name` inside the runtime to the same name in the user's home, if it exists. */
function share(runtime: string, home: string, name: string): void {
  const target = join(home, name);
  const link = join(runtime, name);
  if (!existsSync(target)) return;
  try {
    lstatSync(link);
    return; // never replace what is there, symlink or not
  } catch {
    // link does not exist: create it
  }
  symlinkSync(target, link);
}

/** Drops the symlinks a previous build created (top level and skills/); session state is kept. */
function pruneLinks(runtime: string): void {
  for (const sub of ["", "skills"]) {
    const dir = join(runtime, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
    }
  }
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}


/* ---------- Codex: CODEX_HOME ---------- */

/** Sets `key = value` under `[table]` in a TOML string, adding the table when missing. */
function setTomlScalar(toml: string, table: string, key: string, value: string): string {
  const header = new RegExp(`^\\[${table.replace(/\./g, "\\.")}\\]\\s*$`, "m");
  const match = header.exec(toml);
  if (!match) {
    const sep = toml.endsWith("\n") || toml.length === 0 ? "" : "\n";
    return `${toml}${sep}\n[${table}]\n${key} = ${value}\n`;
  }
  const start = match.index + match[0].length;
  const rest = toml.slice(start);
  const next = /^\[[^\]]+\]\s*$/m.exec(rest);
  const sectionEnd = next ? start + next.index : toml.length;
  const section = toml.slice(start, sectionEnd);
  const keyLine = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const updated = keyLine.test(section)
    ? section.replace(keyLine, `${key} = ${value}`)
    : `${section.replace(/\s*$/, "")}\n${key} = ${value}\n`;
  return toml.slice(0, start) + updated + toml.slice(sectionEnd);
}

/** Removes every `[table]` and `[table.sub]` section (header through the next header). */
function stripTomlTables(toml: string, tables: string[]): string {
  if (tables.length === 0) return toml;
  const lines = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const name = header[1].replace(/^"|"$/g, "");
      skipping = tables.some((t) => name === t || name.startsWith(`${t}.`));
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** Removes top-level `key = ...` lines (including multi-line arrays) before the first table. */
function stripTomlTopKeys(toml: string, keys: string[]): string {
  if (keys.length === 0) return toml;
  const firstTable = /^\s*\[[^\]]+\]\s*$/m.exec(toml);
  const headEnd = firstTable ? firstTable.index : toml.length;
  let head = toml.slice(0, headEnd);
  for (const key of keys) {
    head = head.replace(new RegExp(`^\\s*${key}\\s*=\\s*\\[[\\s\\S]*?\\]\\s*$`, "m"), "");
    head = head.replace(new RegExp(`^\\s*${key}\\s*=.*$`, "m"), "");
  }
  return head + toml.slice(headEnd);
}

function buildCodex(runtime: string, policy: RuntimePolicy["codex"]): void {
  // Start from the user's config so model providers and trust settings carry
  // over; drop MCP servers, plugins and hooks (Paseo supplies the seat's MCP);
  // switch off Codex's own multi-agent, browser, computer-use and apps features.
  const base = existsSync(join(CODEX_HOME, "config.toml")) ? readFileSync(join(CODEX_HOME, "config.toml"), "utf8") : "";
  let merged = stripTomlTopKeys(stripTomlTables(base, policy.stripTables), policy.stripKeys);
  if (policy.agentsOff) merged = setTomlScalar(merged, "agents", "enabled", "false");
  for (const feature of policy.featuresOff) merged = setTomlScalar(merged, "features", feature, "false");
  if (policy.multiAgentV2Off) {
    merged = /^\[features\.multi_agent_v2\]\s*$/m.test(merged)
      ? setTomlScalar(merged, "features.multi_agent_v2", "enabled", "false")
      : setTomlScalar(merged, "features", "multi_agent_v2", "false");
  }
  writeFileSync(join(runtime, "config.toml"), merged);
  for (const name of policy.shareFiles) share(runtime, CODEX_HOME, name);
  if (policy.sharePlugins) share(runtime, CODEX_HOME, "plugins");
  if (policy.shareHooks) share(runtime, CODEX_HOME, "hooks.json");
  ensureDir(join(runtime, "skills"));
  for (const name of policy.shareSkills) share(join(runtime, "skills"), join(CODEX_HOME, "skills"), name);
}

/* ---------- Pi: PI_CODING_AGENT_DIR ---------- */

function buildPi(runtime: string, policy: RuntimePolicy["pi"]): void {
  // Pi reads everything from the agent dir. Credentials and the model catalog
  // are shared; settings are copied with packages/extensions emptied so a seat
  // loads no user extension; sessions stay private to the seat.
  const user = readJsonObject(join(PI_HOME, "settings.json"));
  const userPackages = Array.isArray(user.packages) ? (user.packages as unknown[]) : [];
  const packages = userPackages.filter((entry) => {
    const text = typeof entry === "string" ? entry : JSON.stringify(entry);
    return policy.keepPackages.some((keep) => text.includes(keep));
  });
  const settings = { ...user, ...policy.settings, packages };
  writeJson(join(runtime, "settings.json"), settings);
  for (const name of policy.shareFiles) share(runtime, PI_HOME, name);
  for (const name of policy.shareDirs) share(runtime, PI_HOME, name);
  // Kept packages are installed under <agent-dir>/npm; share it so they resolve.
  if (packages.length > 0) share(runtime, PI_HOME, "npm");
  ensureDir(join(runtime, "sessions"));
}

/* ---------- OpenCode v2: OPENCODE_CONFIG_DIR + OPENCODE_CONFIG ---------- */

function buildOpenCode(runtime: string, policy: RuntimePolicy["opencode"]): void {
  // OPENCODE_CONFIG_DIR scopes agents, commands, plugins and skills; the seat
  // gets an empty one plus whatever policy shares. opencode.json (via
  // OPENCODE_CONFIG) denies the task tool and disables the built-in subagents.
  // Auth and storage live in the shared data dir and are not isolated.
  writeJson(join(runtime, "opencode.json"), policy.config);
  if (!existsSync(OPENCODE_CONFIG_HOME)) return;
  for (const name of policy.shareEntries) share(runtime, OPENCODE_CONFIG_HOME, name);
}

/** Links a role's skills where its harness reads them: the seat's runtime, or claudeRoleDir(role) for Claude. */
function installRoleSkills(runtime: string, seat: Pick<Seat, "harness" | "role">): void {
  const role = seat.role;
  const source = join(ROOM_DIR, "skills", role);
  const target = seat.harness === "claude" ? join(claudeRoleDir(role), ".claude", "skills") : join(runtime, "skills");
  ensureDir(target);
  if (!existsSync(source)) return;
  for (const name of readdirSync(source)) {
    if (!existsSync(join(source, name, "SKILL.md"))) continue;
    share(target, source, name);
  }
}

/** The home of a Codex, Pi or OpenCode seat. Claude seats have none. */
export function runtimeDir(seat: Pick<Seat, "harness" | "role">): string {
  return join(RUNTIMES_DIR, seat.harness, seat.role);
}

/** The directory a Claude seat of this role gets as an additional directory: it holds only `.claude/skills`. */
export function claudeRoleDir(role: Role): string {
  return join(ROLE_SKILLS_DIR, "claude", role);
}

function build(seat: Pick<Seat, "harness" | "role">, dir: string, policy: RuntimePolicy): void {
  switch (seat.harness) {
    case "claude":
      return; // no home to build
    case "codex":
      return buildCodex(dir, policy.codex);
    case "pi":
      return buildPi(dir, policy.pi);
    case "opencode":
      return buildOpenCode(dir, policy.opencode);
  }
}

/** Links the seat's role skills and returns its home, built once per RUNTIME_VERSION; null for Claude. */
export function ensureRuntime(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy = loadPolicy()): string | null {
  if (seat.harness === "claude") {
    installRoleSkills("", seat);
    return null;
  }
  const dir = runtimeDir(seat);
  const marker = join(dir, MARKER);
  if (existsSync(marker) && readJsonObject(marker).version === RUNTIME_VERSION) {
    installRoleSkills(dir, seat);
    return dir;
  }
  ensureDir(dir);
  pruneLinks(dir);
  build(seat, dir, policy);
  installRoleSkills(dir, seat);
  writeJson(marker, { version: RUNTIME_VERSION, harness: seat.harness, role: seat.role, builtAt: new Date().toISOString() });
  return dir;
}

/** Flags of every Claude seat: from ~/.claude it takes the sign-in only, no user settings and no personal MCP server. */
export const CLAUDE_ARGS: Record<string, string | null> = { "setting-sources": "project,local", "strict-mcp-config": null };

/** The files of ~/.claude the policy shares (CLAUDE.md), as text for the seat's prompt. */
export function sharedClaudeFiles(policy: RuntimePolicy = loadPolicy()): string | null {
  const texts = policy.claude.shareFiles.map((name) => join(CLAUDE_HOME, name)).filter((file) => existsSync(file)).map((file) => readFileSync(file, "utf8").trim());
  return texts.filter(Boolean).join("\n\n") || null;
}

/** The environment a seat starts with: its isolated home, or for Claude the switch that keeps it from writing auto-memory into ~/.claude. */
export function envFor(harness: Harness, dir: string | null): Record<string, string> {
  if (harness === "claude") return { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  if (!dir) return {};
  switch (harness) {
    case "codex":
      return { CODEX_HOME: dir };
    case "pi":
      return { PI_CODING_AGENT_DIR: dir };
    case "opencode":
      return { OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: join(dir, "opencode.json") };
  }
}


/** Everything in the shared homes that a runtime deliberately does not see; for `slp-seat` logs. */
export function describeIsolation(policy: RuntimePolicy = loadPolicy()): string {
  return [
    `claude: user home, personal settings off; shares ${policy.claude.shareFiles.join(",") || "nothing"}; denied skills ${policy.claude.deniedSkills.length}`,
    `codex: strips [${policy.codex.stripTables.join(",")}], features off ${policy.codex.featuresOff.length}`,
    `pi: shares ${policy.pi.shareFiles.join(",")}; packages kept only if matching [${policy.pi.keepPackages.join(",")}]`,
    `opencode: task denied, built-in subagents disabled`,
  ].join(" | ");
}
