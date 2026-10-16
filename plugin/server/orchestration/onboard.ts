import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missingSeats, projectModels } from "./models";
import {
  isInside,
  loadRegistry,
  readLaw,
  readRegistryFile,
  readRoomJson,
  realOrSelf,
  roomProjectDir,
  writeRegistryFile,
} from "./registry";
import { rolesWhere } from "../../shared/workflow";
import { enabledSeats } from "./seats";

/** Registering projects with the room: the registry, each project's marker, mission and own model table. */

/** The projects the app knows, by name and folder. */
type ProjectList = () => Promise<{ name: string; path: string }[]>;

interface RegistryEntry {
  name: string;
  cwd: string;
}

const enabledProviders = () => enabledSeats().map((seat) => seat.provider);

/** The app's projects, without the room's own. */
async function appProjects(list: ProjectList): Promise<{ name: string; path: string }[]> {
  const own = roomProjectDir();
  return (await list()).map((p) => ({ name: p.name, path: realOrSelf(p.path) })).filter((p) => p.path !== own);
}

/** A registry name: lower-case letters, digits and dashes, as it appears in `.seatwork/<name>-law.md`. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function writeMarker(root: string, content: Record<string, unknown>): void {
  mkdirSync(join(root, ".seatwork"), { recursive: true });
  writeFileSync(join(root, ".seatwork", "room.json"), `${JSON.stringify(content, null, 2)}\n`);
}

/** The projects of the registry file as written. */
function registryEntries(raw: Record<string, unknown>): RegistryEntry[] {
  return (Array.isArray(raw.projects) ? raw.projects : []) as RegistryEntry[];
}

/** Writes a project's own model table, or takes it out; returns the seats set up for it. */
async function writeModels(
  root: string,
  models: unknown,
  setUpSeats: (providers: string[]) => Promise<void>,
): Promise<string[]> {
  const content = readRoomJson(root);
  const none =
    models === null ||
    (typeof models === "object" && !Array.isArray(models) && Object.keys(models as object).length === 0);
  if (none) {
    delete content.models;
    writeMarker(root, content);
    return [];
  }
  const added = missingSeats(models, enabledProviders(), "models");
  if (added.length) await setUpSeats(added);
  // checked before it is written: a table naming a seat the room lacks would refuse every seat
  projectModels(models, enabledProviders(), "models");
  writeMarker(root, { ...content, models });
  return added;
}

/** A registered project as the setup screen lists it. */
interface ProjectTable {
  name: string;
  root: string;
  own: boolean;
  models: Record<string, unknown>;
  error: string | null;
}

/** Every registered project with the model table of its own, if it has one. */
export function projectTables(): ProjectTable[] {
  const providers = enabledProviders();
  return (loadRegistry()?.projects ?? []).map((entry) => {
    try {
      const { models } = readRoomJson(entry.cwd);
      const own = models !== undefined;
      const table = {
        name: entry.name,
        root: entry.cwd,
        own,
        models: (own && typeof models === "object" && models !== null && !Array.isArray(models)
          ? models
          : {}) as Record<string, unknown>,
      };
      try {
        projectModels(models, providers, ".seatwork/room.json");
        return { ...table, error: null };
      } catch (error) {
        return { ...table, error: error instanceof Error ? error.message : String(error) };
      }
    } catch (error) {
      return {
        name: entry.name,
        root: entry.cwd,
        own: true,
        models: {},
        error: `.seatwork/room.json cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}

/** The setup screen's way to a project's own table: written into its marker, or taken out of it. */
export async function writeProjectModels(
  name: string,
  models: Record<string, unknown> | null,
  setUpSeats: (providers: string[]) => Promise<void>,
): Promise<{ own: boolean; seats: string[] }> {
  const entry = loadRegistry()?.projects.find((project) => project.name === name);
  if (!entry) throw new Error(`${name} is not a registered project`);
  const seats = await writeModels(entry.cwd, models, setUpSeats);
  return { own: readRoomJson(entry.cwd).models !== undefined, seats };
}

/** "default" or "custom", and the seats of one model this project's table names. */
function modelsLine(root: string): string {
  try {
    const marker = readRoomJson(root);
    const models = projectModels(marker.models, enabledProviders(), ".seatwork/room.json");
    const seats = rolesWhere((role) => role.models === "one" && role.home !== "room").flatMap((role) => {
      const seat = models.seats[role];
      return seat ? [`${role}: ${seat.provider} thinking ${seat.thinking}`] : [];
    });
    return [`models: ${marker.models === undefined ? "default" : "custom"}`, ...seats].join(" | ");
  } catch (error) {
    return `models: INVALID (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Every project of the app with what the room knows about it, one line each. */
export async function describeProjects(list: ProjectList): Promise<string> {
  const registry = loadRegistry();
  const projects = await appProjects(list);
  if (projects.length === 0)
    return "Paseo has no project besides the room's own. Ask for the project to be added to Paseo first.";
  return projects
    .map((p) => {
      const entry = registry?.projects.find((e) => e.cwd === p.path);
      const has = (file: string) => (existsSync(join(p.path, ".seatwork", file)) ? "yes" : "no");
      const law = readLaw(p.path, entry?.name ?? slug(p.name)) ? "yes" : "no";
      return `${entry ? `registered as ${entry.name}` : "NOT registered"} | ${p.name} | ${p.path} | mission: ${has("mission.md")} | law: ${law} | ${modelsLine(p.path)}`;
    })
    .join("\n");
}

/** Checks a project against the registry's entries: refused when another holds its name or it is listed under another; returns its own entry, if any. */
function claimOf(entries: readonly RegistryEntry[], name: string, path: string): { known: RegistryEntry | undefined } {
  const clash = entries.find((e) => e.name === name && realOrSelf(e.cwd) !== path);
  if (clash) throw new Error(`the name ${name} already belongs to ${clash.cwd}; give another name`);
  const known = entries.find((e) => realOrSelf(e.cwd) === path);
  if (known && known.name !== name) throw new Error(`${path} is already registered as ${known.name}`);
  return { known };
}

/** Registers a project the app knows (marker, mission, law, own table, registry line), repeatably; the registry is read and written in one step, so projects registered at once all stay. */
export async function registerProject(
  list: ProjectList,
  args: { path: string; name?: string; mission?: string; law?: string; models?: unknown },
  setUpSeats: (providers: string[]) => Promise<void>,
): Promise<string> {
  const wanted = realOrSelf(args.path.trim());
  const project = (await appProjects(list)).find((p) => p.path === wanted || p.name === args.path.trim());
  if (!project)
    throw new Error(`${args.path} is not a project in Paseo (or is the room's own); it has to be added to Paseo first`);
  const name = slug(args.name?.trim() || project.name);
  if (!name) throw new Error("give a name made of letters, digits or dashes");
  // a clash leaves nothing written
  claimOf(registryEntries(readRegistryFile()), name, project.path);

  const seatwork = join(project.path, ".seatwork");
  const added = args.models !== undefined ? await writeModels(project.path, args.models, setUpSeats) : [];
  if (!existsSync(join(seatwork, "room.json"))) writeMarker(project.path, {});
  const mission = args.mission?.trim();
  if (mission) writeFileSync(join(seatwork, "mission.md"), `${mission}\n`);
  const law = args.law?.trim();
  if (law) writeFileSync(join(seatwork, `${name}-law.md`), `${law}\n`);
  const raw = readRegistryFile();
  const { known } = claimOf(registryEntries(raw), name, project.path);
  if (!known) writeRegistryFile({ ...raw, projects: [...registryEntries(raw), { name, cwd: project.path }] });
  const missing = [
    existsSync(join(seatwork, "mission.md")) ? null : "mission (.seatwork/mission.md)",
    readLaw(project.path, name) ? null : `law (.seatwork/${name}-law.md: give \`law\`)`,
  ].filter(Boolean);
  const seats = added.length ? ` Seats set up for this table: ${added.join(", ")}.` : "";
  return `${known ? "already registered" : "registered"}: ${name} at ${project.path}. ${modelsLine(project.path)}.${seats} ${missing.length ? `Still missing: ${missing.join("; ")}.` : "Mission and law are in place."}`;
}

/** Takes a project out of the registry; refused while a seat of it is open. The file is read and written in one step, after the open seats are asked. */
export async function unregisterProject(
  project: string,
  openSeats: () => Promise<{ title: string; cwd: string }[]>,
): Promise<string> {
  const wanted = project.trim();
  const entry = registryEntries(readRegistryFile()).find(
    (e) => e.name === wanted || realOrSelf(e.cwd) === realOrSelf(wanted),
  );
  if (!wanted || !entry) throw new Error(`${project} is not a registered project (seatwork_projects lists them)`);
  const root = realOrSelf(entry.cwd);
  const open = (await openSeats()).filter((seat) => isInside(realOrSelf(seat.cwd), root));
  if (open.length)
    throw new Error(
      `${open.length} seat${open.length === 1 ? "" : "s"} of ${entry.name} ${open.length === 1 ? "is" : "are"} still open (${open
        .slice(0, 3)
        .map((seat) => seat.title)
        .join(", ")}${open.length > 3 ? ", …" : ""}); archive ${open.length === 1 ? "it" : "them"} first`,
    );
  const raw = readRegistryFile();
  const left = registryEntries(raw).filter((e) => !(e.name === entry.name && e.cwd === entry.cwd));
  writeRegistryFile({ ...raw, projects: left });
  return `unregistered: ${entry.name} at ${root}. Its .seatwork/ files stay where they are, and seatwork_register_project brings it back. Registered now: ${left.map((e) => e.name).join(", ") || "no project, so no project seat can start"}.`;
}
