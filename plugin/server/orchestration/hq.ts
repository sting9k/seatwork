import { mkdirSync } from "node:fs";
import { paseoCli } from "../cli";
import type { PaseoApi } from "../paseo";
import { HQ_DIR, HQ_PROJECT } from "../paths";
import { isInside, loadRegistry, realOrSelf } from "./registry";

/** Where HQ seats live: `hq` in projects.json when set, else the room's default project. */
export function hqDir(): string {
  return loadRegistry()?.hq ?? realOrSelf(HQ_DIR);
}

/** An hq seat is created inside the HQ project and nothing else is created there. */
export function checkHqPlacement(role: string, provider: string, cwd: string): void {
  const dir = hqDir();
  const inside = isInside(realOrSelf(cwd), dir);
  if (role === "hq" && !inside)
    throw new Error(`seatwork: ${provider} may only be created in the ${HQ_PROJECT} project (${dir}), not in ${cwd}`);
  if (role !== "hq" && inside)
    throw new Error(`seatwork: ${provider} refused: ${dir} is the ${HQ_PROJECT} project, it holds only hq seats`);
}

const dirOf = (workspace: { workspaceDirectory?: string; projectRootPath: string }) =>
  realOrSelf(workspace.workspaceDirectory ?? workspace.projectRootPath);
/** One opening at a time: two that both find no workspace would both make one. */
let opening: Promise<void> = Promise.resolve();

/** The room's default Paseo project: its directory, project and workspace, for the HQ profile. Safe to repeat. */
export function ensureHqProject(paseo: PaseoApi, log: (message: string) => void): Promise<void> {
  const open = async () => {
    mkdirSync(hqDir(), { recursive: true });
    const dir = hqDir(); // read again: a symlinked path resolves only once the directory exists
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

/** Takes the HQ project out of Paseo; false when only its workspaces could be archived. */
export async function removeHqProject(paseo: PaseoApi): Promise<boolean> {
  if (await deleteProjectAt(hqDir())) return true;
  await closeHqProject(paseo);
  return false;
}
