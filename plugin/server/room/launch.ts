import { join } from "node:path";
import { inRoom, specFromTitle } from "../../shared/workflow";
import type { Host } from "../host";
import type { Asker } from "../orchestration/forks";
import {
  fitSeat,
  loadModels,
  pickModel,
  projectModels,
  stepUp,
  type Models,
  type SeatFit,
} from "../orchestration/models";
import { checkPlacement, findProject, findRoomMarker, loadRegistry, projectBlock } from "../orchestration/registry";
import {
  claudeRoleDir,
  ensureRuntime,
  openCodePermission,
  projectSkillsShadowing,
  roleSkillNames,
  sharedInstructions,
} from "../orchestration/runtimes";
import { enabledSeats, knownSpecs, parseSeat, rolePrompt } from "../orchestration/seats";
import { SAFETY_DIR } from "../paths";
import type { RuntimePolicy } from "../policy";
import type { SeatRecord } from "../coordination/engine";

/** A seat about to start, as the app asks for it; `spec` is a specialization the app passed beside the title. */
export interface SeatLaunch {
  provider: string;
  model?: string;
  cwd: string;
  title?: string | null;
  spec?: string;
  systemPrompt?: string;
}

/** What the room lays into a start: the table's model (absent where the asked one stands; `thinking` null takes the model's own default), the prompt, Claude's flags, OpenCode's permissions. */
export interface Launched {
  model?: { id: string; thinking?: string | null };
  systemPrompt: string;
  claude?: { dirs: string[]; args: Record<string, string | null> };
  opencode?: { permission: Record<string, unknown> };
}

/** A registered project, or one found by its marker, as a seat's start sees it. */
interface Project {
  name: string;
  root: string;
  room: Record<string, unknown>;
  mission: string | null;
  law: string | null;
}

/** The project a folder lies in: by the registry, or by the room's marker above it in open mode. */
function projectAt(cwd: string, role: string, provider: string): Project | null {
  if (inRoom(role)) return null;
  const registry = loadRegistry();
  if (!registry) {
    const marker = findRoomMarker(cwd);
    return marker
      ? {
          name: marker.root.split("/").pop() ?? marker.root,
          root: marker.root,
          room: marker.room,
          mission: marker.mission,
          law: marker.law,
        }
      : null;
  }
  const match = findProject(registry, cwd);
  if (!match) {
    const names = registry.projects.map((p) => `${p.name} (${p.cwd})`).join(", ") || "none";
    throw new Error(`seatwork: ${provider} refused: ${cwd} is not a registered Seatwork project. Registered: ${names}`);
  }
  return { name: match.entry.name, root: match.root, room: match.room, mission: match.mission, law: match.law };
}

/** The table in force at a project: the room's, with the project's own differences laid over it. */
function tableOf(project: Project | null): { models: Models; own: string | null } {
  const own = project?.room.models !== undefined ? `${project.root}/.seatwork/room.json` : null;
  const models = own
    ? projectModels(
        project!.room.models,
        enabledSeats().map((s) => s.provider),
        `seatwork: ${own}`,
      )
    : loadModels();
  return { models, own };
}

/** What the table in force at a folder makes of a seat on this model. */
export function fitAt(cwd: string, role: string, provider: string, model: string | undefined): SeatFit {
  return fitSeat(tableOf(projectAt(cwd, role, provider)).models, role, provider, model);
}

/** The model of the next tier up that the table in force at a folder gives a seat on this provider, if it lists one. */
export function stepUpAt(cwd: string, role: string, provider: string, model: string): string | undefined {
  return stepUp(tableOf(projectAt(cwd, role, provider)).models, role, provider, model);
}

/** The line that names the model a new seat for a task sent back twice starts on, a tier above the seat's; null where the table lists none. */
export async function tierUpNote(host: Pick<Host, "seat">, seat: SeatRecord): Promise<string | null> {
  const now = await host.seat(seat.agentId).catch(() => null);
  const up = now?.model ? stepUpAt(now.cwd, seat.role, seat.provider, now.model) : undefined;
  return up
    ? `Sent back twice: a new ${seat.role} for the repair starts a tier up, on ${seat.provider}/${up}. Name that model when you create it.`
    : null;
}

const told = new Set<string>();
const TOLD_MOST = 500;

/** A line for each project skill named like one of the role's that this process has not told of yet. */
function shadowLines(root: string, role: string): string[] {
  const lines: string[] = [];
  for (const { name, folder } of projectSkillsShadowing(root, role)) {
    const key = `${root}\0${folder}\0${name}`;
    if (told.has(key)) continue;
    if (told.size >= TOLD_MOST) told.delete(told.values().next().value!);
    told.add(key);
    lines.push(
      `skills: the project "${root}" has its own "${name}" in "${folder}", so its Claude seats cannot see the room's "${name}"; rename one`,
    );
  }
  return lines;
}

/** A room seat's start: held to its project and table, given its prompt; throws when refused. A creator that named no model may have the decision model pick the tier. */
export async function launch(
  request: SeatLaunch,
  policy: RuntimePolicy,
  log: (message: string) => void,
  forks?: Asker,
): Promise<Launched> {
  const seat = parseSeat(request.provider)!;
  if (!enabledSeats().some((s) => s.provider === seat.provider))
    throw new Error(
      `seatwork: ${seat.provider} is not a seat the room has set up (the room's setup screen gives a role its seats; the room's own seat sets one up when a project's model table names it)`,
    );
  checkPlacement(seat.role, seat.provider, request.cwd);
  const project = projectAt(request.cwd, seat.role, seat.provider);
  const { models, own } = tableOf(project);
  const spec = specFromTitle(request.title) ?? request.spec;
  if (spec && !knownSpecs().includes(spec))
    throw new Error(
      `seatwork: no specialization "${spec}". The room has: ${knownSpecs().join(", ") || "none"}. Create the seat again with one of these, or none.`,
    );
  const fit = fitSeat(models, seat.role, seat.provider, request.model);
  if (!fit.ok) {
    const table = own ? `project ${project!.name} lists` : "the room's table lists";
    throw new Error(
      `seatwork: ${seat.provider}/${request.model ?? "(default model)"} refused: ${table} for ${seat.role} only ${fit.listed.join(", ")} (${own ?? "the Seatwork screen sets it"}). Create the seat again on one of these.`,
    );
  }
  const task = { title: request.title, spec, brief: request.systemPrompt };
  const picked = request.model || !forks ? undefined : await pickModel(forks, models, seat.role, seat.provider, task);
  if (picked) fit.model = picked;
  if (fit.model)
    log(
      `${seat.provider}: asked for ${request.model ?? "its default model"}, starts on ${fit.model} as the model table says`,
    );
  const root = project?.root ?? (inRoom(seat.role) ? null : request.cwd);
  if (root) for (const line of shadowLines(root, seat.role)) log(line);
  // without its own home a seat would start on the user's, with the user's MCP servers and plugins
  try {
    ensureRuntime(seat, policy);
  } catch (error) {
    throw new Error(
      `seatwork: ${seat.provider} refused: its runtime could not be built (${error instanceof Error ? error.message : String(error)}). Fix that and create the seat again.`,
    );
  }
  const systemPrompt = [
    rolePrompt(seat.role, { harness: seat.harness, spec, params: policy.room.params, models }),
    project ? projectBlock(project.name, project.root, project.mission, project.law, roleSkillNames(seat.role)) : null,
    sharedInstructions(policy),
    request.systemPrompt,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");
  return {
    ...(fit.model
      ? {
          model: {
            id: fit.model,
            ...(fit.thinking ? { thinking: fit.thinking === "default" ? null : fit.thinking } : {}),
          },
        }
      : {}),
    systemPrompt,
    // a Claude seat runs on ~/.claude: customizations off by flags, its role's skills as an added directory
    ...(seat.harness === "claude"
      ? {
          claude: {
            dirs: [claudeRoleDir(seat.role)],
            args: {
              ...(policy.launch.claude.extraArgs ?? {}),
              // the guard: a plugin whose hook reads and records each command and file write
              ...(policy.safety?.mode !== "off" ? { "plugin-dir": join(SAFETY_DIR, "claude") } : {}),
            },
          },
        }
      : {}),
    ...(seat.harness === "opencode"
      ? { opencode: { permission: openCodePermission(seat.role, policy.opencode) } }
      : {}),
  };
}
