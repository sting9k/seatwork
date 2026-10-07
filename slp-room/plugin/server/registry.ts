import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REGISTRY_FILE } from "./paths";

export interface ProjectEntry {
  name: string;
  cwd: string;
}

export interface Registry {
  /** Overrides where the hq-seatwork project lives (default: paths.HQ_DIR). */
  hq?: string;
  projects: ProjectEntry[];
}

export interface ProjectMatch {
  entry: ProjectEntry;
  /** Real path of the project root. */
  root: string;
  /** Parsed .slp/room.json, or {} when absent. */
  room: Record<string, unknown>;
  /** Contents of .slp/mission.md, or null. */
  mission: string | null;
  /** Contents of .slp/<name>-law.md (or .slp/law.md), or null. */
  law: string | null;
}

/** The project's law: `.slp/<name>-law.md`, else `.slp/law.md`. */
export function readLaw(root: string, name: string): string | null {
  for (const file of [join(root, ".slp", `${name}-law.md`), join(root, ".slp", "law.md")]) {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  return null;
}

export function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * projects.json is optional. When it is missing the room runs in open mode:
 * seats may be created in any directory and no project context is injected.
 * When it exists, project seats (supervisor, lead, peer) must be created inside
 * a registered project. HQ seats live in the hq-seatwork project either way (hq.ts).
 */
export function loadRegistry(): Registry | null {
  if (!existsSync(REGISTRY_FILE)) return null;
  const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Partial<Registry>;
  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  return {
    ...(typeof parsed.hq === "string" ? { hq: realOrSelf(parsed.hq) } : {}),
    projects: projects
      .filter((p): p is ProjectEntry => typeof p?.cwd === "string" && typeof p?.name === "string")
      .map((p) => ({ name: p.name, cwd: realOrSelf(p.cwd) })),
  };
}

export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Finds the registered project that contains cwd, and reads its .slp files. */
export function findProject(registry: Registry, cwd: string): ProjectMatch | null {
  const real = realOrSelf(cwd);
  const entry = registry.projects.find((p) => isInside(real, p.cwd));
  if (!entry) return null;
  const slpDir = join(entry.cwd, ".slp");
  const roomFile = join(slpDir, "room.json");
  const missionFile = join(slpDir, "mission.md");
  const room = existsSync(roomFile) ? (JSON.parse(readFileSync(roomFile, "utf8")) as Record<string, unknown>) : {};
  const mission = existsSync(missionFile) ? readFileSync(missionFile, "utf8").trim() : null;
  return { entry, root: entry.cwd, room, mission, law: readLaw(entry.cwd, entry.name) };
}

/** Walks up from cwd looking for a .slp/room.json, for open mode (no registry). */
export function findRoomMarker(cwd: string): { root: string; mission: string | null; law: string | null } | null {
  let dir = realOrSelf(cwd);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, ".slp", "room.json"))) {
      const missionFile = join(dir, ".slp", "mission.md");
      const name = dir.split("/").pop() ?? dir;
      return { root: dir, mission: existsSync(missionFile) ? readFileSync(missionFile, "utf8").trim() : null, law: readLaw(dir, name) };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The project block appended to a project seat's system prompt. */
export function projectBlock(name: string, root: string, mission: string | null, law: string | null): string {
  const lines = [
    "# Project",
    `Project: ${name}`,
    `Root: ${root}`,
    "You belong to this project only. Do not read, edit, or message agents of any other project.",
  ];
  if (mission) {
    lines.push("", "## Mission (from .slp/mission.md)", mission);
  }
  lines.push("", `## Law (from .slp/${name}-law.md)`, law ?? "No law recorded for this project yet.");
  return lines.join("\n");
}
