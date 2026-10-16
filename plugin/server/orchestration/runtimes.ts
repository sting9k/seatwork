import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_HOME,
  CODEX_HOME,
  OPENCODE_CONFIG_HOME,
  PI_HOME,
  ROLE_SKILLS_DIR,
  ROOM_DIR,
  RUNTIMES_DIR,
} from "../paths";
import { loadPolicy, type RuntimePolicy } from "../policy";
import { codexHooks, codexTrust, openCodePlugin, piExtension } from "../safety/hooks";
import type { Harness, Seat } from "./seats";
import { formatToml, parseToml, type TomlTable } from "../toml";

/** Keeps a seat apart from the user's setup: a home under runtimes/, or launch flags for Claude. */

const RUNTIME_VERSION = 14;
const MARKER = ".seatwork-runtime.json";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Links `name` inside the runtime to the same name in the user's home, if it exists there. */
function share(runtime: string, home: string, name: string): void {
  const target = join(home, name);
  const link = join(runtime, name);
  if (!existsSync(target)) return;
  // never replace what is there, symlink or not
  if (lstatSync(link, { throwIfNoEntry: false })) return;
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

/** A JSON object read from a file; empty where the file is absent or holds anything else. */
function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Writes a value as indented JSON. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes one file of a seat's home, folders made. */
function lay(runtime: string, path: string, text: string): void {
  ensureDir(join(runtime, path, ".."));
  writeFileSync(join(runtime, path), text);
}

/** A Codex seat's home: the user's config without MCP servers, plugins and hooks, with the policy's switches and shares. */
function buildCodex(runtime: string, policy: RuntimePolicy["codex"], guarded: boolean): void {
  // the user's config without MCP servers, plugins and hooks, and with Codex's own agent features off
  const file = join(CODEX_HOME, "config.toml");
  let config: TomlTable;
  try {
    config = parseToml(existsSync(file) ? readFileSync(file, "utf8") : "");
  } catch (error) {
    throw new Error(
      `${file} is not TOML the room can read (${error instanceof Error ? error.message : String(error)})`,
    );
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
  // the guard's hook, trusted here or Codex holds it for review
  if (guarded) {
    lay(runtime, "hooks.json", codexHooks());
    const trust = codexTrust(join(runtime, "hooks.json"));
    const state: TomlTable = new Map();
    state.set(JSON.stringify(trust.key), new Map([["trusted_hash", JSON.stringify(trust.hash)]]));
    table("hooks").set("state", state);
  }
  writeFileSync(join(runtime, "config.toml"), formatToml(config));
  for (const name of policy.shareFiles) share(runtime, CODEX_HOME, name);
  if (policy.sharePlugins) share(runtime, CODEX_HOME, "plugins");
  if (policy.shareHooks) share(runtime, CODEX_HOME, "hooks.json");
  ensureDir(join(runtime, "skills"));
  for (const name of policy.shareSkills) share(join(runtime, "skills"), join(CODEX_HOME, "skills"), name);
}

/** A Pi seat's home: the user's settings with the policy's laid over them, and what the policy shares. */
function buildPi(runtime: string, policy: RuntimePolicy["pi"], guarded: boolean): void {
  // credentials and the model catalog are shared; settings are copied with the policy's laid over them
  writeJson(join(runtime, "settings.json"), { ...readJsonObject(join(PI_HOME, "settings.json")), ...policy.settings });
  if (guarded) lay(runtime, "extensions/room-guard.ts", piExtension());
  for (const name of policy.shareFiles) share(runtime, PI_HOME, name);
  for (const name of policy.shareDirs) share(runtime, PI_HOME, name);
  ensureDir(join(runtime, "sessions"));
}

/** An OpenCode seat's home: the policy's config, and what the policy shares of the user's. */
function buildOpenCode(runtime: string, policy: RuntimePolicy["opencode"], guarded: boolean): void {
  // the seat gets an empty config dir plus what policy shares; auth and storage stay shared, not isolated
  writeJson(join(runtime, "opencode.json"), policy.config);
  if (guarded) lay(runtime, "plugins/room-guard.ts", openCodePlugin());
  if (!existsSync(OPENCODE_CONFIG_HOME)) return;
  for (const name of policy.shareEntries) share(runtime, OPENCODE_CONFIG_HOME, name);
}

/** Links a role's skills where its harness reads them. */
function installRoleSkills(runtime: string, seat: Pick<Seat, "harness" | "role">): void {
  const role = seat.role;
  const source = join(ROOM_DIR, "skills", role);
  const target = seat.harness === "claude" ? join(claudeRoleDir(role), ".claude", "skills") : join(runtime, "skills");
  ensureDir(target);
  // a skill the room renamed or dropped leaves a link to nothing
  for (const name of readdirSync(target)) {
    const link = join(target, name);
    if (lstatSync(link).isSymbolicLink() && !existsSync(link)) unlinkSync(link);
  }
  for (const name of ownSkills(role)) share(target, source, name);
  for (const name of sharedSkills(role)) share(target, join(ROOM_DIR, "skills", "shared"), name);
}

/** The skills in a folder of the room's skills: each a folder holding a SKILL.md. */
function skillsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md")));
}

/** A role's own skills, in its folder. */
const ownSkills = (role: string): string[] => skillsIn(join(ROOM_DIR, "skills", role));

/** The skills of `skills/shared` that `skills/shared.json` gives a role. */
function sharedSkills(role: string): string[] {
  const map = join(ROOM_DIR, "skills", "shared.json");
  if (!existsSync(map)) return [];
  const roles = readJsonObject(map);
  return skillsIn(join(ROOM_DIR, "skills", "shared")).filter((name) => {
    const given = roles[name];
    return Array.isArray(given) && given.includes(role);
  });
}

/** The names of the skills the room gives a role: its own and the shared ones it is given. */
export function roleSkillNames(role: string): string[] {
  return [...new Set([...ownSkills(role), ...sharedSkills(role)])].sort();
}

/** The home of a Codex, Pi or OpenCode seat; a Claude seat has none. */
export function runtimeDir(seat: Pick<Seat, "harness" | "role">): string {
  return join(RUNTIMES_DIR, seat.harness, seat.role);
}

/** The extra directory a Claude seat of this role gets: it holds only `.claude/skills`. */
export function claudeRoleDir(role: string): string {
  return join(ROLE_SKILLS_DIR, "claude", role);
}

/** Lays out a seat's home for its harness. */
function build(seat: Pick<Seat, "harness" | "role">, dir: string, policy: RuntimePolicy): void {
  const guarded = policy.safety?.mode !== "off";
  switch (seat.harness) {
    case "claude":
      // a Claude seat runs on the user's home and has none to build
      return;
    case "codex":
      return buildCodex(dir, policy.codex, guarded);
    case "pi":
      return buildPi(dir, policy.pi, guarded);
    case "opencode":
      return buildOpenCode(dir, policy.opencode, guarded);
  }
}

/** What a build is made from: the build logic (RUNTIME_VERSION, bumped when the way a runtime is built changes), the harness's policy and the user file it copies. */
function fingerprint(harness: Exclude<Harness, "claude">, policy: RuntimePolicy): string {
  const copied =
    harness === "codex" ? join(CODEX_HOME, "config.toml") : harness === "pi" ? join(PI_HOME, "settings.json") : null;
  const text = copied && existsSync(copied) ? readFileSync(copied, "utf8") : "";
  return createHash("sha256")
    .update(JSON.stringify([RUNTIME_VERSION, policy[harness], policy.safety?.mode ?? "on", text]))
    .digest("hex");
}

/** A seat's home with its role's skills, rebuilt when its fingerprint changes; null for Claude, whose skills sit in a folder of their own. */
export function ensureRuntime(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy): string | null {
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
    writeJson(marker, {
      fingerprint: print,
      harness: seat.harness,
      role: seat.role,
      builtAt: new Date().toISOString(),
    });
  }
  installRoleSkills(dir, seat);
  return dir;
}

/** The files of ~/.claude the policy shares (CLAUDE.md), as text for the seat's prompt. */
export function sharedClaudeFiles(policy: RuntimePolicy = loadPolicy()): string | null {
  const texts = policy.claude.shareFiles
    .map((name) => join(CLAUDE_HOME, name))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8").trim());
  return texts.filter(Boolean).join("\n\n") || null;
}

/** The environment every session of a seat opens with (policy `launch.env`), `{runtime}` filled with the seat's home. */
export function envFor(
  seat: Pick<Seat, "harness" | "role">,
  policy: RuntimePolicy = loadPolicy(),
): Record<string, string> {
  const home = seat.harness === "claude" ? "" : runtimeDir(seat);
  return Object.fromEntries(
    Object.entries(policy.launch[seat.harness].env).map(([name, value]) => [name, value.replaceAll("{runtime}", home)]),
  );
}

/** A line for the logs: what each harness's runtime leaves out of the user's setup. */
export function describeIsolation(policy: RuntimePolicy = loadPolicy()): string {
  return [
    `claude: user home, personal settings off; shares ${policy.claude.shareFiles.join(",") || "nothing"}; denied skills ${policy.claude.deniedSkills.length}`,
    `codex: strips [${policy.codex.stripTables.join(",")}], features off ${policy.codex.featuresOff.length}`,
    `pi: shares ${policy.pi.shareFiles.join(",")}; no user package or extension`,
    `opencode: task denied, built-in subagents disabled`,
  ].join(" | ");
}
