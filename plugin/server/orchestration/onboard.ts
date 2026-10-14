import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missingSeats, projectModels } from "./models";
import { REGISTRY_FILE } from "../paths";
import { isInside, loadRegistry, readLaw, realOrSelf, roomProjectDir } from "./registry";
import { rolesWhere } from "../../shared/workflow";
import { enabledSeats } from "./seats";

/** The projects the app knows, by name and folder. */
export type ProjectList = () => Promise<{ name: string; path: string }[]>;

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

function readMarker(root: string): Record<string, unknown> {
  const file = join(root, ".seatwork", "room.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
}

function writeMarker(root: string, content: Record<string, unknown>): void {
  mkdirSync(join(root, ".seatwork"), { recursive: true });
  writeFileSync(join(root, ".seatwork", "room.json"), `${JSON.stringify(content, null, 2)}\n`);
}

/** Writes a project's own model table, or takes it out; returns the seats set up for it. */
async function writeModels(
  root: string,
  models: unknown,
  setUpSeats: (providers: string[]) => Promise<void>,
): Promise<string[]> {
  const content = readMarker(root);
  const none =
    models === null ||
    (typeof models === "object" && !Array.isArray(models) && Object.keys(models as object).length === 0);
  if (none) {
    delete content.models;
    writeMarker(root, content);
    return [];
  }
  const added = missingSeats(
    models,
    enabledSeats().map((s) => s.provider),
    "models",
  );
  if (added.length) await setUpSeats(added);
  // checked before it is written: a table naming a seat the room lacks would refuse every seat
  projectModels(
    models,
    enabledSeats().map((s) => s.provider),
    "models",
  );
  writeMarker(root, { ...content, models });
  return added;
}

/** A registered project as the setup screen lists it. */
export interface ProjectTable {
  name: string;
  root: string;
  own: boolean;
  models: Record<string, unknown>;
  error: string | null;
}

/** Every registered project with the model table of its own, if it has one. */
export function projectTables(): ProjectTable[] {
  return (loadRegistry()?.projects ?? []).map((entry) => {
    try {
      const { models } = readMarker(entry.cwd);
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
        projectModels(
          models,
          enabledSeats().map((s) => s.provider),
          ".seatwork/room.json",
        );
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
  return { own: readMarker(entry.cwd).models !== undefined, seats };
}

/** "default" or "custom", and the seats of one model this project's table names. */
function modelsLine(root: string): string {
  try {
    const marker = readMarker(root);
    const models = projectModels(
      marker.models,
      enabledSeats().map((s) => s.provider),
      ".seatwork/room.json",
    );
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

/** Registers a project the app knows: marker, mission, own table, registry line. Repeatable. */
export async function registerProject(
  list: ProjectList,
  args: { path: string; name?: string; mission?: string; models?: unknown },
  setUpSeats: (providers: string[]) => Promise<void>,
): Promise<string> {
  const wanted = realOrSelf(args.path.trim());
  const project = (await appProjects(list)).find((p) => p.path === wanted || p.name === args.path.trim());
  if (!project)
    throw new Error(`${args.path} is not a project in Paseo (or is the room's own); it has to be added to Paseo first`);
  const name = slug(args.name?.trim() || project.name);
  if (!name) throw new Error("give a name made of letters, digits or dashes");

  const raw = existsSync(REGISTRY_FILE)
    ? (JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Record<string, unknown>)
    : {};
  const entries = (Array.isArray(raw.projects) ? raw.projects : []) as { name: string; cwd: string }[];
  const clash = entries.find((e) => e.name === name && realOrSelf(e.cwd) !== project.path);
  if (clash) throw new Error(`the name ${name} already belongs to ${clash.cwd}; give another name`);
  const known = entries.find((e) => realOrSelf(e.cwd) === project.path);
  if (known && known.name !== name) throw new Error(`${project.path} is already registered as ${known.name}`);

  const seatwork = join(project.path, ".seatwork");
  const added = args.models !== undefined ? await writeModels(project.path, args.models, setUpSeats) : [];
  if (!existsSync(join(seatwork, "room.json"))) writeMarker(project.path, {});
  const mission = args.mission?.trim();
  if (mission) writeFileSync(join(seatwork, "mission.md"), `${mission}\n`);
  if (!known) {
    entries.push({ name, cwd: project.path });
    writeFileSync(REGISTRY_FILE, `${JSON.stringify({ ...raw, projects: entries }, null, 2)}\n`, { mode: 0o600 });
  }
  const missing = [
    existsSync(join(seatwork, "mission.md")) ? null : "mission (.seatwork/mission.md)",
    readLaw(project.path, name)
      ? null
      : `law (.seatwork/${name}-law.md, written by the project's top seat on its first task)`,
  ].filter(Boolean);
  const seats = added.length ? ` Seats set up for this table: ${added.join(", ")}.` : "";
  return `${known ? "already registered" : "registered"}: ${name} at ${project.path}. ${modelsLine(project.path)}.${seats} ${missing.length ? `Still missing: ${missing.join("; ")}.` : "Mission and law are in place."}`;
}

/** Takes a project out of the registry; refused while a seat of it is open. */
export async function unregisterProject(
  project: string,
  openSeats: () => Promise<{ title: string; cwd: string }[]>,
): Promise<string> {
  const raw = existsSync(REGISTRY_FILE)
    ? (JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as Record<string, unknown>)
    : {};
  const entries = (Array.isArray(raw.projects) ? raw.projects : []) as { name: string; cwd: string }[];
  const wanted = project.trim();
  const entry = entries.find((e) => e.name === wanted || realOrSelf(e.cwd) === realOrSelf(wanted));
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
  const left = entries.filter((e) => e !== entry);
  writeFileSync(REGISTRY_FILE, `${JSON.stringify({ ...raw, projects: left }, null, 2)}\n`, { mode: 0o600 });
  return `unregistered: ${entry.name} at ${root}. Its .seatwork/ files stay where they are, and seatwork_register_project brings it back. Registered now: ${left.map((e) => e.name).join(", ") || "no project, so no project seat can start"}.`;
}
