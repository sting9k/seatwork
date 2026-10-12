import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOM_HOME } from "../paths";
import { isInside, realOrSelf } from "../registry";

/**
 * All the room keeps in a project sits in `.seatwork/`, under these names: the plugin writes room.json and
 * mission.md, seats write the rest (the law is `<name>-law.md`). A name not listed here is not the room's.
 */
const ROOM_FILES = new Set(["room.json", "mission.md", "law.md", "status.md", "notebook.md", "plans", "reviews"]);
const isRoomFile = (name: string) => ROOM_FILES.has(name) || name.endsWith("-law.md");

/** What leaving a project took out of its `.seatwork/`, and what else sat there and was left. */
export interface ProjectFiles {
  root: string;
  moved: string[];
  left: string[];
}

/** The folders a room worked in: every project in its registry, and the folder of every seat in its log. */
export function roomFolders(home: string = ROOM_HOME): string[] {
  const folders = new Set<string>();
  const lines = (file: string) => (existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").split("\n") : []);
  try {
    const registry = JSON.parse(lines("projects.json").join("\n") || "{}") as { projects?: { cwd?: unknown }[] };
    for (const project of registry.projects ?? []) if (typeof project?.cwd === "string") folders.add(realOrSelf(project.cwd));
  } catch {
    // a registry that cannot be read names no project
  }
  for (const line of lines("registry-log.jsonl")) {
    try {
      const { cwd } = JSON.parse(line) as { cwd?: unknown };
      if (typeof cwd === "string") folders.add(realOrSelf(cwd));
    } catch {
      // an empty or torn line
    }
  }
  // HQ's own folder is in the room home and moves with it
  const real = realOrSelf(home);
  return [...folders].filter((folder) => !isInside(folder, real));
}

/** Where a project's room files go under the folder the room home was moved to. */
export const keptAt = (movedTo: string, root: string, folder = ".seatwork") => join(movedTo, "projects", root.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, ""), folder);

/**
 * Moves the room's files out of a project's `.seatwork/` into `into`, by name. Anything else in `.seatwork/`
 * stays, and `.seatwork/` itself goes only when nothing is left in it. null when the project holds none.
 * `folder` is that folder's name: `.slp` for a room from before 0.19.0.
 */
export function takeRoomFiles(root: string, into: string, folder = ".seatwork"): ProjectFiles | null {
  const seatwork = join(root, folder);
  // a link of that name points at someone else's folder
  if (!existsSync(seatwork) || !lstatSync(seatwork).isDirectory()) return null;
  const moved = readdirSync(seatwork).filter(isRoomFile);
  if (moved.length === 0) return null;
  mkdirSync(into, { recursive: true, mode: 0o700 });
  for (const name of moved) move(join(seatwork, name), join(into, name));
  const left = readdirSync(seatwork);
  if (left.length === 0) rmdirSync(seatwork);
  return { root, moved, left };
}

/** A rename, or a copy and a removal when the project is on another volume than the room home. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}
