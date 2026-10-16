import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  CODEX_HOME,
  OPENCODE_CONFIG_HOME,
  PI_HOME,
  ROLE_SKILLS_DIR,
  ROOM_DIR,
  ROOM_HOME,
  RUNTIMES_DIR,
  USER_AGENTS_SKILLS,
  USER_HOME,
} from "../paths";
import { loadPolicy, type RuntimePolicy } from "../policy";
import { codexHooks, codexTrust, openCodePlugin, piExtension } from "../safety/hooks";
import { localSkills, localSkillsOf, skillsIn } from "./local-skills";
import type { TurnEvent } from "../host";
import type { Harness, Seat } from "./seats";
import { formatToml, parseToml, type TomlTable } from "../toml";

/** Keeps a seat apart from the user's setup: a home under runtimes/, or launch flags for Claude. */

const RUNTIME_VERSION = 15;
const MARKER = ".seatwork-runtime.json";
const SKILL_DEPTH = 4;
const SKILL_FILES_MOST = 500;
const INSTRUCTIONS_MOST = 16 * 1024;
const SKILL_FILE = /([\w.-]+)\/SKILL\.md\b/g;
const PROJECT_SKILL_FOLDERS = [".claude/skills", ".agents/skills", ".opencode/skills", ".pi/skills"];

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

/** The SKILL.md files under a folder, nested ones included; a skill's own folder is not searched. */
function skillFiles(dir: string, depth = 0, found: string[] = []): string[] {
  if (depth > SKILL_DEPTH || found.length >= SKILL_FILES_MOST) return found;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  if (names.includes("SKILL.md")) {
    found.push(join(dir, "SKILL.md"));
    return found;
  }
  for (const name of names.sort()) {
    const path = join(dir, name);
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) skillFiles(path, depth + 1, found);
  }
  return found;
}

/** A Codex seat's home: the user's config without MCP servers, plugins and hooks, with the policy's switches and shares. */
function buildCodex(runtime: string, policy: RuntimePolicy["codex"], guarded: boolean): void {
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
  for (const tool of policy.toolsOff ?? []) table("tools").set(tool, new Map([["enabled", "false"]]));
  if (policy.multiAgentV2Off) {
    const v2 = table("features").get("multi_agent_v2");
    if (v2 instanceof Map) v2.set("enabled", "false");
    else table("features").set("multi_agent_v2", "false");
  }
  // the room's skills table: the user's skills, each by its SKILL.md, and Codex's bundled ones off
  const skills: TomlTable = new Map([["bundled", new Map([["enabled", "false"]])]]);
  config.delete("skills");
  config.set("skills", skills);
  const off = skillFiles(USER_AGENTS_SKILLS).map(
    (file): TomlTable =>
      new Map([
        ["path", JSON.stringify(file)],
        ["enabled", "false"],
      ]),
  );
  if (off.length) skills.set("config", off);
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
  // the user's ~/.agents/skills is left out; the room's skills sit in this home's skills/
  writeJson(join(runtime, "settings.json"), {
    ...readJsonObject(join(PI_HOME, "settings.json")),
    ...policy.settings,
    skills: [`!${USER_AGENTS_SKILLS}/**`],
  });
  if (guarded) lay(runtime, "extensions/room-guard.ts", piExtension());
  for (const name of policy.shareFiles) share(runtime, PI_HOME, name);
  for (const name of policy.shareDirs) share(runtime, PI_HOME, name);
  ensureDir(join(runtime, "sessions"));
}

/** An OpenCode seat's home: the policy's config, only the role's skills allowed, and the user's shares. */
function buildOpenCode(runtime: string, role: string, policy: RuntimePolicy["opencode"], guarded: boolean): void {
  writeJson(join(runtime, "opencode.json"), { ...policy.config, permission: openCodePermission(role, policy) });
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
  for (const name of localSkills(role)) share(target, localSkillsOf(role), name);
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

/** An OpenCode seat's permissions: the policy's, and only its role's skills; its home's config, its provider and its start all carry them, since OpenCode 2 reads them from the session. */
export function openCodePermission(role: string, policy: RuntimePolicy["opencode"]): Record<string, unknown> {
  return {
    ...(policy.config.permission as Record<string, unknown> | undefined),
    skill: { "*": "deny", ...Object.fromEntries(roleSkillNames(role).map((name) => [name, "allow"])) },
  };
}

/** The names of the skills the room gives a role: its own, the shared ones it is given, and the ones its room seat added. */
export function roleSkillNames(role: string): string[] {
  return [...new Set([...ownSkills(role), ...sharedSkills(role), ...localSkills(role)])].sort();
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
      return buildOpenCode(dir, seat.role, policy.opencode, guarded);
  }
}

/** What a build is made from: RUNTIME_VERSION, the harness's policy, the user file it copies, the skills it names. */
function fingerprint(
  seat: Pick<Seat, "role"> & { harness: Exclude<Harness, "claude"> },
  policy: RuntimePolicy,
): string {
  const { harness, role } = seat;
  const copied =
    harness === "codex" ? join(CODEX_HOME, "config.toml") : harness === "pi" ? join(PI_HOME, "settings.json") : null;
  const text = copied && existsSync(copied) ? readFileSync(copied, "utf8") : "";
  const skills =
    harness === "codex" ? skillFiles(USER_AGENTS_SKILLS) : harness === "opencode" ? roleSkillNames(role) : [];
  return createHash("sha256")
    .update(JSON.stringify([RUNTIME_VERSION, policy[harness], policy.safety?.mode ?? "on", text, skills]))
    .digest("hex");
}

/** Lays out a seat's home and its role's skills, rebuilding the home when its fingerprint changes; null for Claude, which has none. */
export function ensureRuntime(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy): string | null {
  if (seat.harness === "claude") {
    installRoleSkills("", seat);
    return null;
  }
  const dir = runtimeDir(seat);
  const marker = join(dir, MARKER);
  const print = fingerprint({ harness: seat.harness, role: seat.role }, policy);
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

/** The policy's instruction files as one text after the room's prompt: paths in the room home, absolute, or under the user's ~/. */
export function sharedInstructions(policy: RuntimePolicy): string | null {
  const texts = (policy.room.instructions ?? [])
    .map((name) =>
      name.startsWith("~/") ? join(USER_HOME, name.slice(2)) : isAbsolute(name) ? name : join(ROOM_HOME, name),
    )
    .filter((file) => existsSync(file) && statSync(file).isFile())
    .map((file) => readFileSync(file, "utf8").trim().slice(0, INSTRUCTIONS_MOST));
  return texts.filter(Boolean).join("\n\n") || null;
}

/** The environment every session of a seat opens with (policy `launch.env`), `{runtime}` filled with the seat's home. */
export function envFor(seat: Pick<Seat, "harness" | "role">, policy: RuntimePolicy): Record<string, string> {
  const home = seat.harness === "claude" ? "" : runtimeDir(seat);
  return Object.fromEntries(
    Object.entries(policy.launch[seat.harness].env).map(([name, value]) => [name, value.replaceAll("{runtime}", home)]),
  );
}

/** A line for the logs: what each harness's runtime leaves out of the user's setup. */
export function describeIsolation(policy: RuntimePolicy = loadPolicy()): string {
  return [
    `claude: user home, personal settings off; denied skills ${policy.claude.deniedSkills.length}`,
    `codex: strips [${policy.codex.stripTables.join(",")}], features off ${policy.codex.featuresOff.length}, user and bundled skills off`,
    `pi: shares ${policy.pi.shareFiles.join(",")}; no user package, extension or skill`,
    `opencode: task denied, built-in subagents disabled, only the role's skills`,
  ].join(" | ");
}

/** The skills a turn loaded, each agent CLI's way: a skill tool's label, or a SKILL.md read in a shell or by file. */
export function skillsLoaded(events: readonly TurnEvent[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    if (event.kind === "tool" && (event.name === "Skill" || event.name === "skill") && event.label)
      names.add(event.label.trim().split(/\s+/)[0]);
    else if (event.kind === "shell") for (const [, name] of event.command.matchAll(SKILL_FILE)) names.add(name);
    else if (event.kind === "read") for (const [, name] of event.path.matchAll(SKILL_FILE)) names.add(name);
  }
  return [...names].filter(Boolean).sort();
}

/** The project's skills named like one the room gives `role`: on Claude the project's hides the room's. */
export function projectSkillsShadowing(root: string, role: string): { name: string; folder: string }[] {
  const given = new Set(roleSkillNames(role));
  return PROJECT_SKILL_FOLDERS.flatMap((folder) =>
    skillsIn(join(root, folder))
      .filter((name) => given.has(name))
      .map((name) => ({ name, folder })),
  );
}
