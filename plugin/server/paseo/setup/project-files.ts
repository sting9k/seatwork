import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { ROOM_FOLDER, ROOM_HOME } from "../../paths";
import { isInside, realOrSelf } from "../../orchestration/registry";

const ROOM_FILES = new Set([
  "room.json",
  "mission.md",
  "law.md",
  "status.md",
  "notebook.md",
  "plans",
  "reviews",
  "handoffs",
  ".mail",
  ".work",
  ".knowledge",
]);
const isRoomFile = (name: string) => ROOM_FILES.has(name) || name.endsWith("-law.md");

/** What leaving a project took out of its `.seatwork/`, and what else sat there and was left. */
export interface ProjectFiles {
  root: string;
  moved: string[];
  left: string[];
}

/** The folders a room worked in: every project in its registry, and the folder of every seat in its log. */
export function roomFolders(): string[] {
  const named = new Set<string>();
  const text = (file: string) => (existsSync(join(ROOM_HOME, file)) ? readFileSync(join(ROOM_HOME, file), "utf8") : "");
  try {
    const registry = JSON.parse(text("projects.json") || "{}") as { projects?: { cwd?: unknown }[] };
    for (const project of registry.projects ?? []) if (typeof project?.cwd === "string") named.add(project.cwd);
  } catch {
    // a registry that cannot be read names no project
  }
  for (const line of text("registry-log.jsonl").split("\n")) {
    try {
      const { cwd } = JSON.parse(line) as { cwd?: unknown };
      if (typeof cwd === "string") named.add(cwd);
    } catch {
      // an empty or torn line
    }
  }
  const folders = new Set([...named].map((cwd) => realOrSelf(cwd)));
  // the room's own project sits in the room home and moves with it
  const real = realOrSelf(ROOM_HOME);
  return [...folders].filter((folder) => !isInside(folder, real));
}

/** Where a project's room files go under the folder the room home was moved to: a hash of its path, so two paths never share a folder, then the path as a name. */
export const keptAt = (movedTo: string, root: string) =>
  join(
    movedTo,
    "projects",
    `${createHash("sha256").update(root).digest("hex").slice(0, 8)}-${root.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "")}`,
    ROOM_FOLDER,
  );

/** Moves the room's files, by name, out of a project's `.seatwork/` into `into`; the rest stays. Null when the project has none. */
export function takeRoomFiles(root: string, into: string): ProjectFiles | null {
  const seatwork = join(root, ROOM_FOLDER);
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
