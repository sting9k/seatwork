import { mkdirSync } from "node:fs";
import { paseoCli } from "./cli";
import type { PaseoApi } from "./api";
import { realOrSelf, roomProjectDir } from "../orchestration/registry";
import { ROOM_PROJECT } from "../../shared/workflow";

const dirOf = (workspace: { workspaceDirectory?: string; projectRootPath: string }) =>
  realOrSelf(workspace.workspaceDirectory ?? workspace.projectRootPath);
/** One opening at a time: two that both find no workspace would both make one. */
let opening: Promise<void> = Promise.resolve();

/** The room's own project in Paseo: its directory, project and workspace. Safe to repeat. */
export function ensureRoomProject(paseo: PaseoApi, log: (message: string) => void): Promise<void> {
  const open = async () => {
    mkdirSync(roomProjectDir(), { recursive: true });
    const dir = roomProjectDir(); // read again: a symlinked path resolves only once the directory exists
    const { entries } = await paseo.workspaces.list();
    if (entries.some((workspace) => dirOf(workspace) === dir)) return;
    await paseo.workspaces.open({ cwd: dir });
    log(`opened the ${ROOM_PROJECT} project at ${dir}`);
  };
  opening = opening.then(open, open);
  return opening;
}

/** Archives the room project's workspaces: they leave Paseo's lists, the project's own line stays. */
async function closeRoomProject(paseo: PaseoApi): Promise<void> {
  const dir = roomProjectDir();
  const { entries } = await paseo.workspaces.list();
  for (const workspace of entries) if (dirOf(workspace) === dir) await paseo.workspaces.archive(workspace.id);
}

/** Deletes from Paseo the project at this folder, through the CLI (the SDK has no call); false when it could not. */
export async function deleteProjectAt(dir: string): Promise<boolean> {
  const real = realOrSelf(dir);
  try {
    const projects = JSON.parse(await paseoCli(["project", "ls", "--json"])) as { projectId: string; path: string }[];
    for (const project of projects)
      if (realOrSelf(project.path) === real) await paseoCli(["project", "delete", project.projectId]);
    return true;
  } catch {
    return false;
  }
}

/** Takes the room's project out of Paseo; false when only its workspaces could be archived. */
export async function removeRoomProject(paseo: PaseoApi): Promise<boolean> {
  if (await deleteProjectAt(roomProjectDir())) return true;
  await closeRoomProject(paseo);
  return false;
}
