import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PaseoApi } from "../api";
import { paseoCli } from "../cli";
import { removeRoomProject } from "../room-project";
import { removeWithSdk, restoreSkillSelection, skillSelection } from "./paseo-config";
import { keptAt, roomFolders, takeRoomFiles, type ProjectFiles } from "./project-files";
import { isSetUp, moveRoomHomeAside } from "./room-home";
import { parseSeat } from "../../orchestration/seats";
import { CLAUDE_HOME, PASEO_HOME, ROOM_HOME, USER_HOME } from "../../paths";
import { ROOM_PROJECT } from "../../../shared/workflow";

/** The room leaving Paseo and the disk: the daemon's switches put back, its seats' records and sessions set aside, and at an uninstall what is left put in the Trash. */

const SWITCHES_FILE = "daemon-before.json";
const LIST_PAGES = 50;
const DELETES_AT_ONCE = 4;

/** The daemon-wide switches as they stood before the room first set them, null where the daemon named none; `skills` is the selection in the config.json at `file`. */
interface Before {
  injectIntoAgents: boolean | null;
  browserTools: boolean | null;
  terminalHooks: boolean | null;
  skills: { file: string; selection: unknown } | null;
}

/** What taking the room out did: the providers it removed, where the room home went, what it took from each project, and what it could not do. */
interface Left {
  removed: string[];
  movedTo: string;
  projects: ProjectFiles[];
  notes: string[];
}

/** A JSON file of the room home, or null when it is missing or torn. */
function readRoomFile<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(ROOM_HOME, name), "utf8")) as T;
  } catch {
    return null;
  }
}

/** Keeps the daemon's switches as they are, once, before setup first sets them. */
export async function keepSwitches(paseo: PaseoApi, pluginDir: string): Promise<void> {
  const file = join(ROOM_HOME, SWITCHES_FILE);
  if (existsSync(file)) return;
  const { config } = await paseo.config.get();
  const now = config as Record<string, any>;
  const before: Before = {
    injectIntoAgents: now.mcp?.injectIntoAgents ?? null,
    browserTools: now.browserTools?.enabled ?? null,
    terminalHooks: now.enableTerminalAgentHooks ?? null,
    skills: skillSelection(PASEO_HOME, pluginDir),
  };
  mkdirSync(ROOM_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 });
}

/** Puts back each switch the room set while it still holds the room's value; true when config.json changed and the daemon must read it again. */
async function restoreSwitches(paseo: PaseoApi): Promise<boolean> {
  const before = readRoomFile<Before>(SWITCHES_FILE);
  if (!before) return false;
  const policy = readRoomFile<{ daemon?: Record<string, unknown> }>("policy.json")?.daemon ?? {};
  const { config } = await paseo.config.get();
  const now = config as Record<string, any>;
  const patch: Record<string, unknown> = {};
  /** Whether a switch still holds what the room set and held something else before. */
  const ours = (was: boolean | null, is: unknown, set: unknown) => was !== null && is === set && was !== set;
  if (ours(before.injectIntoAgents, now.mcp?.injectIntoAgents, true))
    patch.mcp = { injectIntoAgents: before.injectIntoAgents };
  if (ours(before.browserTools, now.browserTools?.enabled, policy.browserTools ?? false))
    patch.browserTools = { enabled: before.browserTools };
  if (ours(before.terminalHooks, now.enableTerminalAgentHooks, policy.enableTerminalAgentHooks ?? false))
    patch.enableTerminalAgentHooks = before.terminalHooks;
  if (Object.keys(patch).length > 0) await paseo.config.patch(patch as never);
  return before.skills !== null && restoreSkillSelection(before.skills.file, before.skills.selection);
}

/** The room's archived seats as Paseo keeps them, with the Claude session each wrote. */
async function archivedSeats(paseo: PaseoApi): Promise<{ id: string; cwd: string | null; session: string | null }[]> {
  const out: { id: string; cwd: string | null; session: string | null }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of result.entries) {
      const agent = (entry as { agent: Record<string, any> }).agent;
      const seat = parseSeat(String(agent.provider ?? "").split("/")[0]);
      if (!seat || !agent.archivedAt) continue;
      const session =
        seat.harness === "claude" ? (agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null) : null;
      out.push({ id: agent.id, cwd: agent.cwd ?? null, session });
    }
    const info = (result as { pageInfo?: { nextCursor?: string | null; hasMore?: boolean } }).pageInfo;
    cursor = info?.hasMore && info.nextCursor ? info.nextCursor : undefined;
    if (!cursor) break;
  }
  return out;
}

/** Moves a Claude session a seat wrote, and the folder of its side chats, out of the user's Claude folder into `into`. */
function moveSession(cwd: string, session: string, into: string): boolean {
  const folder = cwd.replace(/[^A-Za-z0-9]/g, "-");
  const from = join(CLAUDE_HOME, "projects", folder);
  const names = [`${session}.jsonl`, session].filter((name) => existsSync(join(from, name)));
  if (names.length === 0) return false;
  mkdirSync(join(into, folder), { recursive: true, mode: 0o700 });
  for (const name of names) renameSync(join(from, name), join(into, folder, name));
  if (readdirSync(from).length === 0) rmdirSync(from);
  return true;
}

/** Deletes Paseo's records of these seats, a call each; notes what it could not do. */
async function deleteRecords(seats: readonly { id: string }[]): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < seats.length; i += DELETES_AT_ONCE)
    await Promise.all(
      seats
        .slice(i, i + DELETES_AT_ONCE)
        .map((seat) => paseoCli(["delete", seat.id]).catch(() => failed.push(seat.id))),
    );
  return failed.length
    ? [
        `Paseo still lists ${failed.length} archived seat${failed.length === 1 ? "" : "s"} of the room: the paseo CLI could not delete them.`,
      ]
    : [];
}

/** Takes the room out of Paseo and moves its files aside with its archived seats' Claude sessions, as Remove does; `records` also deletes those seats' records, a call each. */
export async function takeRoomOut(paseo: PaseoApi, records: boolean): Promise<Left> {
  const folders = roomFolders(); // read from the room home, before it moves
  // read before the room's project goes: deleting it drops the records of the seats it held
  const archived = await archivedSeats(paseo);
  const { removed } = await removeWithSdk(paseo);
  const reload = await restoreSwitches(paseo);
  for (const seat of archived)
    if (seat.cwd && seat.session) moveSession(seat.cwd, seat.session, join(ROOM_HOME, "claude-sessions"));
  const notes = records ? await deleteRecords(archived) : [];
  const [projectGone] = await Promise.all([
    removeRoomProject(paseo),
    reload &&
      paseoCli(["daemon", "reload"]).catch(() =>
        notes.push("Paseo's bundled skills are back in config.json; `paseo daemon reload` makes it take effect."),
      ),
  ]);
  if (!projectGone)
    notes.push(
      `The ${ROOM_PROJECT} project is still in Paseo's list, empty: the paseo CLI could not delete it. Delete it there.`,
    );
  const movedTo = moveRoomHomeAside(ROOM_HOME);
  const projects: ProjectFiles[] = [];
  for (const root of folders) {
    try {
      const taken = takeRoomFiles(root, keptAt(movedTo, root));
      if (taken) projects.push(taken);
    } catch (error) {
      notes.push(`${root}/.seatwork could not be moved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, movedTo, projects, notes };
}

/** A name free in `dir`: `name`, else `name 2`, `name 3` and on. */
function freeName(dir: string, name: string): string {
  let free = name;
  for (let n = 2; existsSync(join(dir, free)); n += 1) free = `${name} ${n}`;
  return free;
}

/** Moves a path into the user's Trash, ~/.Trash on macOS or the freedesktop Trash elsewhere; false when there is none or the move fails. */
export function toTrash(path: string): boolean {
  try {
    if (process.platform === "darwin") {
      const trash = join(USER_HOME, ".Trash");
      if (!existsSync(trash)) return false;
      renameSync(path, join(trash, freeName(trash, basename(path))));
      return true;
    }
    const trash = join(process.env.XDG_DATA_HOME?.trim() || join(USER_HOME, ".local", "share"), "Trash");
    mkdirSync(join(trash, "files"), { recursive: true });
    mkdirSync(join(trash, "info"), { recursive: true });
    const name = freeName(join(trash, "files"), basename(path));
    renameSync(path, join(trash, "files", name));
    const deleted = new Date().toISOString().slice(0, 19);
    writeFileSync(
      join(trash, "info", `${name}.trashinfo`),
      `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${deleted}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** When Paseo removed the plugin: the room leaves Paseo, and its home, what earlier removals set aside and setup's config backups go to the Trash; lines for the log. */
export async function leaveAtUninstall(paseo: PaseoApi): Promise<string[]> {
  const said: string[] = [];
  if (isSetUp(ROOM_HOME)) {
    const left = await takeRoomOut(paseo, false);
    said.push(`the room left Paseo as the plugin was removed: ${left.removed.length} seats`, ...left.notes);
  }
  const aside = [
    ...readdirSync(dirname(ROOM_HOME))
      .filter((name) => name.startsWith(`${basename(ROOM_HOME)}.removed-`))
      .map((name) => join(dirname(ROOM_HOME), name)),
    ...(existsSync(PASEO_HOME) ? readdirSync(PASEO_HOME) : [])
      .filter((name) => name.startsWith("config.json.bak-"))
      .map((name) => join(PASEO_HOME, name)),
  ];
  for (const path of aside) said.push(toTrash(path) ? `moved ${path} to the Trash` : `${path} stays: no Trash took it`);
  return said;
}
