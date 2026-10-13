import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REGISTRY_FILE } from "./paths";

export interface ProjectEntry {
  name: string;
  cwd: string;
}

export interface Registry {
  hq?: string;
  projects: ProjectEntry[];
}

export interface ProjectMatch {
  entry: ProjectEntry;
  root: string;
  room: Record<string, unknown>;
  mission: string | null;
  law: string | null;
}

/** The project's law: `.seatwork/<name>-law.md`, else `.seatwork/law.md`. */
export function readLaw(root: string, name: string): string | null {
  for (const file of [join(root, ".seatwork", `${name}-law.md`), join(root, ".seatwork", "law.md")]) {
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

/** projects.json is optional: without it the room is in open mode, and seats may be created anywhere. */
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

/** Finds the registered project that contains cwd, and reads its .seatwork files. */
export function findProject(registry: Registry, cwd: string): ProjectMatch | null {
  const real = realOrSelf(cwd);
  const entry = registry.projects.find((p) => isInside(real, p.cwd));
  if (!entry) return null;
  const seatworkDir = join(entry.cwd, ".seatwork");
  const roomFile = join(seatworkDir, "room.json");
  const missionFile = join(seatworkDir, "mission.md");
  const room = existsSync(roomFile) ? (JSON.parse(readFileSync(roomFile, "utf8")) as Record<string, unknown>) : {};
  const mission = existsSync(missionFile) ? readFileSync(missionFile, "utf8").trim() : null;
  return { entry, root: entry.cwd, room, mission, law: readLaw(entry.cwd, entry.name) };
}

/** Walks up from cwd looking for a .seatwork/room.json, for open mode (no registry). */
export function findRoomMarker(
  cwd: string,
): { root: string; room: Record<string, unknown>; mission: string | null; law: string | null } | null {
  let dir = realOrSelf(cwd);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, ".seatwork", "room.json"))) {
      const missionFile = join(dir, ".seatwork", "mission.md");
      const name = dir.split("/").pop() ?? dir;
      const room = JSON.parse(readFileSync(join(dir, ".seatwork", "room.json"), "utf8")) as Record<string, unknown>;
      return {
        root: dir,
        room,
        mission: existsSync(missionFile) ? readFileSync(missionFile, "utf8").trim() : null,
        law: readLaw(dir, name),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
  // a law names a skill in backticks; one written before 0.20.0 carries the old `seatwork-` prefix
  const named = roleSkills.filter((skill) => new RegExp(`\`(?:seatwork-)?${skill}\``).test(law ?? ""));
  if (named.length)
    lines.push(
      "",
      `Skills of your seat this law names: ${named.map((skill) => `\`${skill}\``).join(", ")}. Load each before your first edit.`,
    );
  return lines.join("\n");
}
