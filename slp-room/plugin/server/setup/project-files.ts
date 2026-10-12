import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_LOG, ROOM_HOME } from "../paths";
import { isInside, loadRegistry, realOrSelf } from "../registry";

/**
 * All the room keeps in a project sits in `.slp/`, under these names: the plugin writes room.json and
 * mission.md, seats write the rest (the law is `<name>-law.md`). A name not listed here is not the room's.
 */
const ROOM_FILES = new Set(["room.json", "mission.md", "law.md", "status.md", "notebook.md", "plans", "reviews"]);
const isRoomFile = (name: string) => ROOM_FILES.has(name) || name.endsWith("-law.md");

/** What leaving a project took out of its `.slp/`, and what else sat there and was left. */
export interface ProjectFiles {
  root: string;
  moved: string[];
  left: string[];
}

/** The folders the room worked in: every registered project, and the folder of every seat it created. */
export function roomFolders(): string[] {
  const folders = new Set((loadRegistry()?.projects ?? []).map((project) => project.cwd));
  if (existsSync(REGISTRY_LOG)) {
    for (const line of readFileSync(REGISTRY_LOG, "utf8").split("\n")) {
      try {
        const { cwd } = JSON.parse(line) as { cwd?: unknown };
        if (typeof cwd === "string") folders.add(realOrSelf(cwd));
      } catch {
        // an empty or torn line
      }
    }
  }
  // HQ's own folder is in the room home and moves with it
  const home = realOrSelf(ROOM_HOME);
  return [...folders].filter((folder) => !isInside(folder, home));
}

/** Where a project's room files go under the folder the room home was moved to. */
export const keptAt = (movedTo: string, root: string) => join(movedTo, "projects", root.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, ""), ".slp");

/**
 * Moves the room's files out of a project's `.slp/` into `into`, by name. Anything else in `.slp/`
 * stays, and `.slp/` itself goes only when nothing is left in it. null when the project holds none.
 */
export function takeRoomFiles(root: string, into: string): ProjectFiles | null {
  const slp = join(root, ".slp");
  // a link named .slp points at someone else's folder
  if (!existsSync(slp) || !lstatSync(slp).isDirectory()) return null;
  const moved = readdirSync(slp).filter(isRoomFile);
  if (moved.length === 0) return null;
  mkdirSync(into, { recursive: true, mode: 0o700 });
  for (const name of moved) move(join(slp, name), join(into, name));
  const left = readdirSync(slp);
  if (left.length === 0) rmdirSync(slp);
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
