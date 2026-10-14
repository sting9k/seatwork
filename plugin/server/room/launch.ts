import { join } from "node:path";
import { inRoom, specFromTitle } from "../../shared/workflow";
import { fitSeat, loadModels, projectModels, type Models, type SeatFit } from "../orchestration/models";
import { checkPlacement, findProject, findRoomMarker, loadRegistry, projectBlock } from "../orchestration/registry";
import { claudeRoleDir, ensureRuntime, roleSkillNames, sharedClaudeFiles } from "../orchestration/runtimes";
import { enabledSeats, parseSeat, rolePrompt } from "../orchestration/seats";
import { SAFETY_DIR } from "../paths";
import type { RuntimePolicy } from "../policy";

/** A seat about to start, as the app asks for it. */
export interface SeatLaunch {
  provider: string;
  model?: string;
  cwd: string;
  title?: string | null;
  /** a specialization the app passed beside the title */
  spec?: string;
  systemPrompt?: string;
}

/** What the room lays into that start: the table's model, the prompt, Claude's flags. */
export interface Launched {
  /** absent: the asked model stands; `thinking` null takes the model's own default */
  model?: { id: string; thinking?: string | null };
  systemPrompt: string;
  claude?: { dirs: string[]; args: Record<string, string | null> };
}

interface Project {
  name: string;
  root: string;
  room: Record<string, unknown>;
  mission: string | null;
  law: string | null;
}

/** The project a folder lies in: by the registry, or by the room's marker above it in open mode. */
function projectAt(cwd: string, role: string, provider: string): Project | null {
  const registry = loadRegistry();
  if (inRoom(role)) return null;
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

/** A room seat's start: held to its project and table, given its prompt; throws when refused. */
export function launch(request: SeatLaunch, policy: RuntimePolicy, log: (message: string) => void): Launched {
  const seat = parseSeat(request.provider)!;
  if (!enabledSeats().some((s) => s.provider === seat.provider))
    throw new Error(
      `seatwork: ${seat.provider} is not a seat the room has set up (the room's setup screen gives a role its seats; the room's own seat sets one up when a project's model table names it)`,
    );
  checkPlacement(seat.role, seat.provider, request.cwd);
  const project = projectAt(request.cwd, seat.role, seat.provider);
  const { models, own } = tableOf(project);
  const fit = fitSeat(models, seat.role, seat.provider, request.model);
  if (!fit.ok) {
    const table = own ? `project ${project!.name} lists` : "the room's table lists";
    throw new Error(
      `seatwork: ${seat.provider}/${request.model ?? "(default model)"} refused: ${table} for ${seat.role} only ${fit.listed.join(", ")} (${own ?? "the Seatwork screen sets it"}). Create the seat again on one of these.`,
    );
  }
  // a seat asked for on a model the table has since replaced starts on the table's
  if (fit.model)
    log(
      `${seat.provider}: asked for ${request.model ?? "its default model"}, starts on ${fit.model} as the model table says`,
    );
  // without its own home a seat would start on the user's, with the user's MCP servers and plugins
  try {
    ensureRuntime(seat, policy);
  } catch (error) {
    throw new Error(
      `seatwork: ${seat.provider} refused: its runtime could not be built (${error instanceof Error ? error.message : String(error)}). Fix that and create the seat again.`,
    );
  }
  const spec = specFromTitle(request.title) ?? request.spec;
  const systemPrompt = [
    rolePrompt(seat.role, { harness: seat.harness, spec, params: policy.room.params, models }),
    project ? projectBlock(project.name, project.root, project.mission, project.law, roleSkillNames(seat.role)) : null,
    seat.harness === "claude" ? sharedClaudeFiles(policy) : null,
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
              // the guard: a plugin whose hook checks each command and file write
              ...(policy.safety?.mode !== "off" ? { "plugin-dir": join(SAFETY_DIR, "claude") } : {}),
            },
          },
        }
      : {}),
  };
}
