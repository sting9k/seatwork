import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { REGISTRY_FILE, ROOM_PROJECT_DIR } from "../paths";
import { inRoom, ROOM_PROJECT } from "../../shared/workflow";

/** The registry of projects (projects.json) and what each project keeps under .seatwork/. */

interface ProjectEntry {
  name: string;
  cwd: string;
}

export interface Registry {
  roomProject?: string;
  projects: ProjectEntry[];
}

interface ProjectFiles {
  room: Record<string, unknown>;
  mission: string | null;
  law: string | null;
}

interface ProjectMatch extends ProjectFiles {
  entry: ProjectEntry;
  root: string;
}

/** The project's law: `.seatwork/<name>-law.md`, else `.seatwork/law.md`. */
export function readLaw(root: string, name: string): string | null {
  for (const file of [join(root, ".seatwork", `${name}-law.md`), join(root, ".seatwork", "law.md")]) {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  return null;
}

/** A project's room marker (.seatwork/room.json); empty where it has none. */
export function readRoomJson(root: string): Record<string, unknown> {
  const file = join(root, ".seatwork", "room.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
}

function readProjectFiles(root: string, name: string): ProjectFiles {
  const missionFile = join(root, ".seatwork", "mission.md");
  return {
    room: readRoomJson(root),
    mission: existsSync(missionFile) ? readFileSync(missionFile, "utf8").trim() : null,
    law: readLaw(root, name),
  };
}

/** The real path of a folder, or its absolute path where it does not exist. */
export function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** projects.json is optional: without it the room is in open mode, and seats may be created anywhere. */
export function loadRegistry(): Registry | null {
  if (!existsSync(REGISTRY_FILE)) return null;
  const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Partial<Registry>;
  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  return {
    ...(typeof parsed.roomProject === "string" ? { roomProject: realOrSelf(parsed.roomProject) } : {}),
    projects: projects
      .filter((p): p is ProjectEntry => typeof p?.cwd === "string" && typeof p?.name === "string")
      .map((p) => ({ name: p.name, cwd: realOrSelf(p.cwd) })),
  };
}

/** The registry file as written, so that keys this plugin does not know survive its changes. */
export function readRegistryFile(): Record<string, unknown> {
  return existsSync(REGISTRY_FILE) ? (JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Record<string, unknown>) : {};
}

/** Writes the registry file whole by a rename: a reader sees the old file or the new one. */
export function writeRegistryFile(content: Record<string, unknown>): void {
  writeFileSync(`${REGISTRY_FILE}.tmp`, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${REGISTRY_FILE}.tmp`, REGISTRY_FILE);
}

/** Whether `child` is `parent` or lies inside it. */
export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Where the room's own seats sit: `roomProject` in the registry, else the default. */
export function roomProjectIn(registry: Registry | null): string {
  return registry?.roomProject ?? realOrSelf(ROOM_PROJECT_DIR);
}

/** Where the room's own seats sit, by the registry as it is now. */
export function roomProjectDir(): string {
  return roomProjectIn(loadRegistry());
}

/** A seat at home in the room is created in the room's project, and nothing else is created there. */
export function checkPlacement(role: string, provider: string, cwd: string): void {
  const dir = roomProjectDir();
  const inside = isInside(realOrSelf(cwd), dir);
  if (inRoom(role) && !inside)
    throw new Error(`seatwork: ${provider} may only be created in the ${ROOM_PROJECT} project (${dir}), not in ${cwd}`);
  if (!inRoom(role) && inside)
    throw new Error(
      `seatwork: ${provider} refused: ${dir} is the ${ROOM_PROJECT} project, it holds only the room's own seats`,
    );
}

/** The registered project a folder lies in; a project inside another is the one a folder in it belongs to. */
function entryFor(registry: Registry, cwd: string): ProjectEntry | undefined {
  const real = realOrSelf(cwd);
  return registry.projects
    .filter((p) => isInside(real, p.cwd))
    .reduce<ProjectEntry | undefined>((best, p) => (!best || p.cwd.length > best.cwd.length ? p : best), undefined);
}

/** Finds the registered project that contains cwd, and reads its .seatwork files. */
export function findProject(registry: Registry, cwd: string): ProjectMatch | null {
  const entry = entryFor(registry, cwd);
  return entry ? { entry, root: entry.cwd, ...readProjectFiles(entry.cwd, entry.name) } : null;
}

/** The nearest folder above cwd that holds a .seatwork/room.json, for open mode (no registry). */
export function markerRoot(cwd: string): string | null {
  let dir = realOrSelf(cwd);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, ".seatwork", "room.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Walks up from cwd looking for a .seatwork/room.json, for open mode (no registry). */
export function findRoomMarker(cwd: string): (ProjectFiles & { root: string }) | null {
  const root = markerRoot(cwd);
  return root ? { root, ...readProjectFiles(root, root.split("/").pop() ?? root) } : null;
}

/** The same place in the main checkout of the linked git worktree a folder lies in, read from the `.git` file at the worktree's top; null for a folder in none. */
export function inMainCheckout(cwd: string): string | null {
  const real = realOrSelf(cwd);
  let dir = real;
  for (let i = 0; i < 64; i += 1) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        if (!statSync(dotGit).isFile()) return null;
        const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!named) return null;
        const own = resolve(dir, named);
        const listed = join(own, "commondir");
        const common = existsSync(listed)
          ? resolve(own, readFileSync(listed, "utf8").trim())
          : basename(dirname(own)) === "worktrees"
            ? dirname(dirname(own))
            : null;
        return common && basename(common) === ".git" ? join(dirname(common), relative(dir, real)) : null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The project a folder lies in, by the registry or by the room's marker above it, or else those of the main checkout of its git worktree; only its root. */
export function projectRootOf(cwd: string): string | null {
  const registry = loadRegistry();
  const rootOf = (folder: string) => (registry ? entryFor(registry, folder)?.cwd : undefined) ?? markerRoot(folder);
  const own = rootOf(cwd);
  if (own) return own;
  const main = inMainCheckout(cwd);
  return main ? rootOf(main) : null;
}

/** The skills of a role that a law names in backticks. */
function lawSkills(law: string | null, roleSkills: readonly string[]): string[] {
  return roleSkills.filter((skill) => (law ?? "").includes(`\`${skill}\``));
}

/** A project seat's block: project, mission, law, and its own skills the law names. */
export function projectBlock(
  name: string,
  root: string,
  mission: string | null,
  law: string | null,
  roleSkills: string[] = [],
): string {
  const lines = [
    "# Project",
    `Project: ${name}`,
    `Root: ${root}`,
    "You belong to this project only. Do not read, edit, or message agents of any other project.",
  ];
  if (mission) {
    lines.push("", "## Mission (from .seatwork/mission.md)", mission);
  }
  lines.push("", `## Law (from .seatwork/${name}-law.md)`, law ?? "No law recorded for this project yet.");
  const named = lawSkills(law, roleSkills);
  if (named.length)
    lines.push(
      "",
      `Skills of your seat this law names: ${named.map((skill) => `\`${skill}\``).join(", ")}. Load each before your first edit.`,
    );
  return lines.join("\n");
}
