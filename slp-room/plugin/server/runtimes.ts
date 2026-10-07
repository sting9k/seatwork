import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOME, CODEX_HOME, OPENCODE_CONFIG_HOME, PI_HOME, ROOM_DIR, RUNTIMES_DIR } from "./paths";
import { loadPolicy, type RuntimePolicy } from "./policy";
import type { Harness, Role, Seat } from "./seats";

/**
 * Isolated runtimes, the "Codex Room" idea applied to every harness.
 *
 * Each seat gets its own home directory that the harness treats as its user
 * home: own sessions, history, databases and settings. Only what policy.json
 * lists is shared from the user's real home by symlink, so a seat does not
 * inherit the user's skills, plugins, MCP servers, hooks or extensions unless
 * the policy says so. Harness-native features that overlap with the room
 * (sub-agents, browser, computer use, apps) are switched off in the copy.
 *
 * Role prompts are NOT written into the runtime. They go through Paseo's
 * provider-agnostic `systemPrompt`, so every harness gets the same text once.
 */

const RUNTIME_VERSION = 10;
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

/* ---------- Claude Code: CLAUDE_CONFIG_DIR ---------- */

function buildClaude(runtime: string, policy: RuntimePolicy["claude"]): void {
  const settings = readJsonObject(join(CLAUDE_HOME, "settings.json"));
  if (!policy.keepHooks) delete settings.hooks;
  if (!policy.keepEnabledPlugins) {
    delete settings.enabledPlugins;
    delete settings.extraKnownMarketplaces;
  }
  // Deny the bundled skills that overlap the room; Skill(skill:x) matches a skill under any of its names.
  const permissions = (settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {}) as Record<string, unknown>;
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const skillRules = policy.deniedSkills.map((name) => `Skill(skill:${name})`);
  settings.permissions = { ...permissions, deny: [...deny.filter((r) => !skillRules.includes(r)), ...skillRules] };
  writeJson(join(runtime, "settings.json"), settings);
  for (const name of policy.shareFiles) share(runtime, CLAUDE_HOME, name);
  if (policy.sharePlugins) share(runtime, CLAUDE_HOME, "plugins");
  ensureDir(join(runtime, "skills"));
  for (const name of policy.shareSkills) share(join(runtime, "skills"), join(CLAUDE_HOME, "skills"), name);
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

/**
 * Role skills: room/skills/<role>/<skill>/SKILL.md symlinked into the runtime's
 * skills directory, which every harness reads (Claude, Codex, Pi: <home>/skills;
 * OpenCode: <config dir>/skills). A seat sees its role's skills and nothing else.
 */
function installRoleSkills(runtime: string, role: Role): void {
  const source = join(ROOM_DIR, "skills", role);
  const target = join(runtime, "skills");
  ensureDir(target);
  if (!existsSync(source)) return;
  for (const name of readdirSync(source)) {
    if (!existsSync(join(source, name, "SKILL.md"))) continue;
    share(target, source, name);
  }
}

export function runtimeDir(seat: Pick<Seat, "harness" | "role">): string {
  return join(RUNTIMES_DIR, seat.harness, seat.role);
}

function build(seat: Pick<Seat, "harness" | "role">, dir: string, policy: RuntimePolicy): void {
  switch (seat.harness) {
    case "claude":
      return buildClaude(dir, policy.claude);
    case "codex":
      return buildCodex(dir, policy.codex);
    case "pi":
      return buildPi(dir, policy.pi);
    case "opencode":
      return buildOpenCode(dir, policy.opencode);
  }
}

/** Builds the runtime once per RUNTIME_VERSION; later calls only verify the marker. */
export function ensureRuntime(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy = loadPolicy()): string {
  const dir = runtimeDir(seat);
  const marker = join(dir, MARKER);
  if (existsSync(marker) && readJsonObject(marker).version === RUNTIME_VERSION) return dir;
  ensureDir(dir);
  pruneLinks(dir);
  build(seat, dir, policy);
  installRoleSkills(dir, seat.role);
  writeJson(marker, { version: RUNTIME_VERSION, harness: seat.harness, role: seat.role, builtAt: new Date().toISOString() });
  return dir;
}

/** The environment that points a harness at its isolated runtime. */
export function envFor(harness: Harness, dir: string): Record<string, string> {
  switch (harness) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: dir };
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
  const claudeSkills = existsSync(join(CLAUDE_HOME, "skills")) ? readdirSync(join(CLAUDE_HOME, "skills")).length : 0;
  return [
    `claude: shares ${policy.claude.shareFiles.join(",") || "nothing"}; skills ${policy.claude.shareSkills.length}/${claudeSkills}; plugins ${policy.claude.sharePlugins}; denied skills ${policy.claude.deniedSkills.length}`,
    `codex: strips [${policy.codex.stripTables.join(",")}], features off ${policy.codex.featuresOff.length}`,
    `pi: shares ${policy.pi.shareFiles.join(",")}; packages kept only if matching [${policy.pi.keepPackages.join(",")}]`,
    `opencode: task denied, built-in subagents disabled`,
  ].join(" | ");
}
