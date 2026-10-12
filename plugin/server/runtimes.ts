import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOME, CODEX_HOME, OPENCODE_CONFIG_HOME, PI_HOME, ROLE_SKILLS_DIR, ROOM_DIR, RUNTIMES_DIR } from "./paths";
import { loadPolicy, type RuntimePolicy } from "./policy";
import type { Harness, Role, Seat } from "./seats";
import { formatToml, parseToml, type TomlTable } from "./toml";

/** Keeps a seat apart from the user's setup: a home under runtimes/, or launch flags for Claude. */

/** Bump when the way a runtime is built changes. Policy and user config changes rebuild on their own. */
const RUNTIME_VERSION = 13;
const MARKER = ".seatwork-runtime.json";

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

function buildCodex(runtime: string, policy: RuntimePolicy["codex"]): void {
  // the user's config without MCP servers, plugins and hooks, and with Codex's own agent features off
  const file = join(CODEX_HOME, "config.toml");
  let config: TomlTable;
  try {
    config = parseToml(existsSync(file) ? readFileSync(file, "utf8") : "");
  } catch (error) {
    throw new Error(`${file} is not TOML the room can read (${error instanceof Error ? error.message : String(error)})`);
  }
  for (const name of [...policy.stripTables, ...policy.stripKeys]) config.delete(name);
  /** The top-level table `name`, replacing anything there that is not a table. */
  const table = (name: string): TomlTable => {
    const found = config.get(name);
    if (found instanceof Map) return found;
    const made: TomlTable = new Map();
    config.set(name, made);
    return made;
  };
  if (policy.agentsOff) table("agents").set("enabled", "false");
  for (const feature of policy.featuresOff) table("features").set(feature, "false");
  if (policy.multiAgentV2Off) {
    const v2 = table("features").get("multi_agent_v2");
    if (v2 instanceof Map) v2.set("enabled", "false");
    else table("features").set("multi_agent_v2", "false");
  }
  writeFileSync(join(runtime, "config.toml"), formatToml(config));
  for (const name of policy.shareFiles) share(runtime, CODEX_HOME, name);
  if (policy.sharePlugins) share(runtime, CODEX_HOME, "plugins");
  if (policy.shareHooks) share(runtime, CODEX_HOME, "hooks.json");
  ensureDir(join(runtime, "skills"));
  for (const name of policy.shareSkills) share(join(runtime, "skills"), join(CODEX_HOME, "skills"), name);
}

/* ---------- Pi: PI_CODING_AGENT_DIR ---------- */

function buildPi(runtime: string, policy: RuntimePolicy["pi"]): void {
  // credentials and the model catalog are shared; settings are copied with the policy's laid over them
  writeJson(join(runtime, "settings.json"), { ...readJsonObject(join(PI_HOME, "settings.json")), ...policy.settings });
  for (const name of policy.shareFiles) share(runtime, PI_HOME, name);
  for (const name of policy.shareDirs) share(runtime, PI_HOME, name);
  ensureDir(join(runtime, "sessions"));
}

/* ---------- OpenCode v2: OPENCODE_CONFIG_DIR + OPENCODE_CONFIG ---------- */

function buildOpenCode(runtime: string, policy: RuntimePolicy["opencode"]): void {
  // the seat gets an empty config dir plus what policy shares; auth and storage stay shared, not isolated
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

/** What a build is made from: the build logic, the harness's policy and the user file it copies. */
function fingerprint(harness: Exclude<Harness, "claude">, policy: RuntimePolicy): string {
  const copied = harness === "codex" ? join(CODEX_HOME, "config.toml") : harness === "pi" ? join(PI_HOME, "settings.json") : null;
  const text = copied && existsSync(copied) ? readFileSync(copied, "utf8") : "";
  return createHash("sha256").update(JSON.stringify([RUNTIME_VERSION, policy[harness], text])).digest("hex");
}

/** Links the seat's role skills and returns its home, rebuilt whenever its fingerprint changes; null for Claude. */
export function ensureRuntime(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy = loadPolicy()): string | null {
  if (seat.harness === "claude") {
    installRoleSkills("", seat);
    return null;
  }
  const dir = runtimeDir(seat);
  const marker = join(dir, MARKER);
  const print = fingerprint(seat.harness, policy);
  if (readJsonObject(marker).fingerprint !== print) {
    ensureDir(dir);
    pruneLinks(dir);
    build(seat, dir, policy);
    writeJson(marker, { fingerprint: print, harness: seat.harness, role: seat.role, builtAt: new Date().toISOString() });
  }
  installRoleSkills(dir, seat);
  return dir;
}

/** The files of ~/.claude the policy shares (CLAUDE.md), as text for the seat's prompt. */
export function sharedClaudeFiles(policy: RuntimePolicy = loadPolicy()): string | null {
  const texts = policy.claude.shareFiles.map((name) => join(CLAUDE_HOME, name)).filter((file) => existsSync(file)).map((file) => readFileSync(file, "utf8").trim());
  return texts.filter(Boolean).join("\n\n") || null;
}

/** The environment every session of a seat opens with (policy `launch.env`). */
export function envFor(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy = loadPolicy()): Record<string, string> {
  const home = seat.harness === "claude" ? "" : runtimeDir(seat);
  return Object.fromEntries(Object.entries(policy.launch[seat.harness].env).map(([name, value]) => [name, value.replaceAll("{runtime}", home)]));
}


/** Everything in the shared homes that a runtime deliberately does not see; for `seatwork` logs. */
export function describeIsolation(policy: RuntimePolicy = loadPolicy()): string {
  return [
    `claude: user home, personal settings off; shares ${policy.claude.shareFiles.join(",") || "nothing"}; denied skills ${policy.claude.deniedSkills.length}`,
    `codex: strips [${policy.codex.stripTables.join(",")}], features off ${policy.codex.featuresOff.length}`,
    `pi: shares ${policy.pi.shareFiles.join(",")}; no user package or extension`,
    `opencode: task denied, built-in subagents disabled`,
  ].join(" | ");
}
