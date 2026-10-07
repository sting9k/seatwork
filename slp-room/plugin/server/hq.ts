import { mkdirSync } from "node:fs";
import { paseoCli } from "./cli";
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
  if (role === "hq" && !inside) throw new Error(`slp-seat: ${provider} may only be created in the ${HQ_PROJECT} project (${dir}), not in ${cwd}`);
  if (role !== "hq" && inside) throw new Error(`slp-seat: ${provider} refused: ${dir} is the ${HQ_PROJECT} project, it holds only hq seats`);
}

/**
 * The room's default Paseo project: the directory, the project named
 * hq-seatwork and one local workspace in it, so the HQ Supervisor profile has
 * a home right after install. Safe to repeat; a project the user renamed or
 * a workspace that already exists is left alone.
 */
export async function ensureHqProject(log: (message: string) => void): Promise<void> {
  const dir = hqDir();
  mkdirSync(dir, { recursive: true });
  const projects = JSON.parse(await paseoCli(["project", "ls", "--json"])) as { projectId: string; name: string; path: string }[];
  let project = projects.find((p) => realOrSelf(p.path) === dir);
  if (!project) {
    project = JSON.parse(await paseoCli(["project", "create", dir, "--json"])) as { projectId: string; name: string; path: string };
    if (project.name !== HQ_PROJECT) await paseoCli(["project", "rename", project.projectId, HQ_PROJECT]);
    log(`created the ${HQ_PROJECT} project at ${dir}`);
  }
  const workspaces = JSON.parse(await paseoCli(["workspace", "ls", "--json"])) as { cwd: string }[];
  if (!workspaces.some((w) => realOrSelf(w.cwd) === dir)) {
    await paseoCli(["workspace", "create", "--project", project.projectId, "--path", dir, "--isolation", "local", "--title", HQ_PROJECT, "--json"]);
    log(`created the ${HQ_PROJECT} workspace`);
  }
}
