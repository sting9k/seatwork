import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paseoCli } from "./cli";
import { hqDir } from "./hq";
import { missingSeats, projectModels } from "./models";
import { REGISTRY_FILE } from "./paths";
import { loadRegistry, readLaw, realOrSelf } from "./registry";
import { enabledSeats, enableSeats } from "./seats";

interface PaseoProject {
  projectId: string;
  name: string;
  path: string;
}

/** Paseo's projects, without the room's own hq-seatwork. */
async function paseoProjects(): Promise<PaseoProject[]> {
  const hq = hqDir();
  const all = JSON.parse(await paseoCli(["project", "ls", "--json"])) as PaseoProject[];
  return all.map((p) => ({ ...p, path: realOrSelf(p.path) })).filter((p) => p.path !== hq);
}

/** A registry name: lower-case letters, digits and dashes, as it appears in `.slp/<name>-law.md`. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readMarker(root: string): Record<string, unknown> {
  const file = join(root, ".slp", "room.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
}

/** "default" or "custom", and the Supervisor seat this project's table names. */
function modelsLine(root: string): string {
  try {
    const marker = readMarker(root);
    const models = projectModels(marker.models, enabledSeats().map((s) => s.provider), ".slp/room.json");
    return `models: ${marker.models === undefined ? "default" : "custom"} | supervisor: ${models.seats.supervisor.provider} thinking ${models.seats.supervisor.thinking}`;
  } catch (error) {
    return `models: INVALID (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Every Paseo project with what the room knows about it, one line each. */
export async function describeProjects(): Promise<string> {
  const registry = loadRegistry();
  const projects = await paseoProjects();
  if (projects.length === 0) return "Paseo has no project besides the room's own. Ask for the project to be added to Paseo first.";
  return projects
    .map((p) => {
      const entry = registry?.projects.find((e) => e.cwd === p.path);
      const has = (file: string) => (existsSync(join(p.path, ".slp", file)) ? "yes" : "no");
      const law = readLaw(p.path, entry?.name ?? slug(p.name)) ? "yes" : "no";
      return `${entry ? `registered as ${entry.name}` : "NOT registered"} | ${p.name} | ${p.path} | mission: ${has("mission.md")} | law: ${law} | ${modelsLine(p.path)}`;
    })
    .join("\n");
}

/**
 * Registers a project Paseo already knows: the `.slp/room.json` marker, the
 * mission and the project's own model table when given, and its line in
 * projects.json. Repeating it updates what is given and changes nothing else.
 * A table may put a role on a harness the room has no seat for yet: those
 * seats are set up before the table is written.
 */
export async function registerProject(args: { path: string; name?: string; mission?: string; models?: unknown }): Promise<string> {
  const wanted = realOrSelf(args.path.trim());
  const project = (await paseoProjects()).find((p) => p.path === wanted || p.name === args.path.trim());
  if (!project) throw new Error(`${args.path} is not a project in Paseo (or is the room's own); it has to be added to Paseo first`);
  const name = slug(args.name?.trim() || project.name);
  if (!name) throw new Error("give a name made of letters, digits or dashes");

  const raw = existsSync(REGISTRY_FILE) ? (JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Record<string, unknown>) : {};
  const entries = (Array.isArray(raw.projects) ? raw.projects : []) as { name: string; cwd: string }[];
  const clash = entries.find((e) => e.name === name && realOrSelf(e.cwd) !== project.path);
  if (clash) throw new Error(`the name ${name} already belongs to ${clash.cwd}; give another name`);
  const known = entries.find((e) => realOrSelf(e.cwd) === project.path);
  if (known && known.name !== name) throw new Error(`${project.path} is already registered as ${known.name}`);

  const slp = join(project.path, ".slp");
  mkdirSync(slp, { recursive: true });
  const marker = join(slp, "room.json");
  const content = readMarker(project.path);
  let added: string[] = [];
  if (args.models !== undefined) {
    added = missingSeats(args.models, enabledSeats().map((s) => s.provider), "models");
    await enableSeats(added);
    // checked before it is written: a table that names a seat the room does not have would refuse every seat
    projectModels(args.models, enabledSeats().map((s) => s.provider), "models");
    content.models = args.models;
  }
  if (args.models !== undefined || !existsSync(marker)) writeFileSync(marker, `${JSON.stringify(content, null, 2)}\n`);
  const mission = args.mission?.trim();
  if (mission) writeFileSync(join(slp, "mission.md"), `${mission}\n`);
  if (!known) {
    entries.push({ name, cwd: project.path });
    writeFileSync(REGISTRY_FILE, `${JSON.stringify({ ...raw, projects: entries }, null, 2)}\n`, { mode: 0o600 });
  }
  const missing = [
    existsSync(join(slp, "mission.md")) ? null : "mission (.slp/mission.md)",
    readLaw(project.path, name) ? null : `law (.slp/${name}-law.md, written by the project's Supervisor on its first task)`,
  ].filter(Boolean);
  const seats = added.length ? ` Seats set up for this table: ${added.join(", ")}.` : "";
  return `${known ? "already registered" : "registered"}: ${name} at ${project.path}. ${modelsLine(project.path)}.${seats} ${missing.length ? `Still missing: ${missing.join("; ")}.` : "Mission and law are in place."}`;
}
