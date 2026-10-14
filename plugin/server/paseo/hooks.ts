import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import type { TurnOutcome } from "../host";
import { parseSeat } from "../orchestration/seats";
import type { Room, SeatEvent } from "../room/room";
import type { PaseoApi } from "./api";
import type { PaseoHost } from "./host";
import { ensureRoomProject } from "./room-project";
import { eventsOf, sinceMark, type ReadMark } from "./timeline";

/** Paseo's hooks and events, told to the room in its own words; the room never sees Paseo's shapes. */

type CreateRequest = PluginBeforeRequests["agent.create"];

/** The agent Paseo's events carry. */
interface Agent {
  id: string;
  provider: string;
  title?: string | null;
  cwd: string;
  parentAgentId?: string | null;
}

/** A Paseo agent as the room's seat. */
const seatOf = (agent: Agent): SeatEvent => ({
  id: agent.id,
  provider: agent.provider,
  title: agent.title ?? null,
  cwd: agent.cwd,
  parentId: agent.parentAgentId ?? null,
});

/** A seat's create request with the room's start laid in. */
export async function seatRequest(room: Room, request: CreateRequest): Promise<CreateRequest> {
  const config = request.config;
  const start = await room.launch({
    provider: config.provider,
    ...(config.model ? { model: config.model } : {}),
    cwd: config.cwd,
    title: config.title ?? null,
    ...(typeof (config.featureValues as { seatworkSpec?: unknown } | undefined)?.seatworkSpec === "string"
      ? { spec: (config.featureValues as { seatworkSpec: string }).seatworkSpec }
      : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
  });
  let providerOptions = config.providerOptions;
  if (start.claude) {
    const current = (providerOptions ?? {}) as {
      additionalDirectories?: unknown;
      extraArgs?: Record<string, string | null>;
    };
    const dirs = Array.isArray(current.additionalDirectories)
      ? current.additionalDirectories.filter((d): d is string => typeof d === "string")
      : [];
    providerOptions = {
      ...current,
      additionalDirectories: [...new Set([...dirs, ...start.claude.dirs])],
      extraArgs: { ...(current.extraArgs ?? {}), ...start.claude.args },
    };
  }
  return {
    ...request,
    env: { ...(request.env ?? {}), ...start.env },
    config: {
      ...config,
      ...(start.model
        ? {
            model: start.model.id,
            ...(start.model.thinking !== undefined ? { thinkingOptionId: start.model.thinking ?? undefined } : {}),
          }
        : {}),
      systemPrompt: start.systemPrompt,
      mcpServers: {
        ...(config.mcpServers ?? {}),
        seatwork: { type: "http" as const, url: start.mcpUrl, alwaysLoad: true },
      },
      ...(providerOptions ? { providerOptions } : {}),
    },
  };
}

/** Wires Paseo's events to a running room; returns what takes them back. */
export function connect(server: Pick<PluginServerContext, "on" | "before">, room: Room, host: PaseoHost): () => void {
  let projectOpened = false;
  const marks = new Map<string, ReadMark>();
  /** Gives the room Paseo's client, which every hook carries; the first hook also opens the room's own project. */
  const enter = (paseo: PaseoApi): Room => {
    host.use(paseo);
    if (!projectOpened) {
      projectOpened = true;
      void ensureRoomProject(paseo, (message) => console.log(`seatwork: ${message}`)).catch((error) =>
        console.error("seatwork: the room's project could not be opened", error),
      );
    }
    return room;
  };
  const off = [
    // session_open is the first hook that knows the agent id: the nonce from agent.create is tied to it here
    server.before("agent.session_open", ({ request }) => {
      const env = room.opened(
        request.agentId,
        request.provider,
        request.env?.SEATWORK_NONCE,
        request.reason === "create",
      );
      return env ? { ...request, env: { ...request.env, ...env } } : request;
    }),
    server.on("agent.created", async (event, { paseo }) => {
      await enter(paseo).created(seatOf(event.agent));
    }),
    // the app runs the user's own agents too: only the room's seats are the room's business
    server.on("agent.turn_started", (event, { paseo }) => {
      if (parseSeat(event.agent.provider)) enter(paseo).turnStarted(seatOf(event.agent));
    }),
    server.on("agent.turn_ended", async (event, { paseo }) => {
      if (!parseSeat(event.agent.provider)) return;
      const outcome: TurnOutcome =
        event.outcome.kind === "failed"
          ? { kind: "failed", error: event.outcome.error.message }
          : { kind: event.outcome.kind === "canceled" ? "canceled" : "completed" };
      // the app hands the seat's whole timeline: the turn is what came after the last one read
      const read = sinceMark(event.timeline, marks.get(event.agent.id));
      marks.set(event.agent.id, read.mark);
      const events = eventsOf(read.items);
      await enter(paseo).turnEnded({
        seat: seatOf(event.agent),
        turnId: event.turnId,
        outcome,
        // the seat's last words, never the prompt that opened its turn
        text: events.findLast((one) => one.kind === "say")?.text ?? "",
        events,
      });
    }),
    server.on("agent.archived", async (event, { paseo }) => {
      if (!parseSeat(event.agent.provider)) return;
      marks.delete(event.agent.id);
      await enter(paseo).archived(seatOf(event.agent));
    }),
    // a runtime that closes takes its turn with it and Paseo sends no end
    server.on("agent.closed", (event) => {
      if (!parseSeat(event.agent.provider)) return;
      marks.delete(event.agent.id);
      room.closed(event.agent.id);
    }),
    server.on("agent.permission_requested", async (event, { paseo }) => {
      if (parseSeat(event.agent.provider)) await enter(paseo).permissionAsked(seatOf(event.agent), event.request);
    }),
    // a permission answered in Paseo, by anyone, settles the PERMISSION mail that asked for it
    server.on("agent.permission_resolved", (event, { paseo }) => {
      enter(paseo).permissionAnswered(event.agent.id);
    }),
  ];
  return () => {
    for (const remove of off) remove();
  };
}
