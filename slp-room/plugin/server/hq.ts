import { mkdirSync } from "node:fs";
import { paseoCli } from "./cli";
import type { PaseoApi } from "./paseo";
import { HQ_DIR, HQ_PROJECT } from "./paths";
import { isInside, loadRegistry, realOrSelf } from "./registry";

/** Where HQ seats live: `hq` in projects.json when set, else the room's default project. */
export function hqDir(): string {
  return loadRegistry()?.hq ?? realOrSelf(HQ_DIR);
}

/** An hq seat is created inside the HQ project and nothing else is created there. */
export function checkHqPlacement(role: string, provider: string, cwd: string): void {
  const dir = hqDir();
  const inside = isInside(realOrSelf(cwd), dir);
  if (role === "hq" && !inside) throw new Error(`seatwork: ${provider} may only be created in the ${HQ_PROJECT} project (${dir}), not in ${cwd}`);
  if (role !== "hq" && inside) throw new Error(`seatwork: ${provider} refused: ${dir} is the ${HQ_PROJECT} project, it holds only hq seats`);
}

const dirOf = (workspace: { workspaceDirectory?: string; projectRootPath: string }) => realOrSelf(workspace.workspaceDirectory ?? workspace.projectRootPath);
/** One opening at a time: two that both find no workspace would both make one. */
let opening: Promise<void> = Promise.resolve();

/**
 * The room's default Paseo project: the directory, and the project and local workspace Paseo
 * opens for it, so the HQ Supervisor profile has a home. Safe to repeat: a workspace that is
 * already there is left alone, and so is a project the user renamed.
 */
export function ensureHqProject(paseo: PaseoApi, log: (message: string) => void): Promise<void> {
  const open = async () => {
    mkdirSync(hqDir(), { recursive: true });
    const dir = hqDir(); // read again: a path through a symlink resolves only once the directory exists
    const { entries } = await paseo.workspaces.list();
    if (entries.some((workspace) => dirOf(workspace) === dir)) return;
    await paseo.workspaces.open({ cwd: dir });
    log(`opened the ${HQ_PROJECT} project at ${dir}`);
  };
  opening = opening.then(open, open);
  return opening;
}

/** Archives the HQ project's workspaces: they leave Paseo's lists, the project's own line stays. */
async function closeHqProject(paseo: PaseoApi): Promise<void> {
  const dir = hqDir();
  const { entries } = await paseo.workspaces.list();
  for (const workspace of entries) if (dirOf(workspace) === dir) await paseo.workspaces.archive(workspace.id);
}

/**
 * Takes the HQ project out of Paseo when the room is removed, and no other project. The SDK has no
 * call for it, so the paseo CLI does it; false when the CLI could not, and only the workspaces were archived.
 */
export async function removeHqProject(paseo: PaseoApi): Promise<boolean> {
  const dir = hqDir();
  try {
    const projects = JSON.parse(await paseoCli(["project", "ls", "--json"])) as { projectId: string; path: string }[];
    for (const project of projects) if (realOrSelf(project.path) === dir) await paseoCli(["project", "delete", project.projectId]);
    return true;
  } catch {
    await closeHqProject(paseo);
    return false;
  }
}
