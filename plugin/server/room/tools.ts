import { ROLES } from "../../shared/workflow";
import { KEEP_LOG_DAYS } from "../gc";
import type { McpHttpServer, McpToolHandler } from "../mcp-http";
import { describeProjects, registerProject, unregisterProject } from "../orchestration/onboard";
import { retryNote } from "../orchestration/recovery";
import { handoffRequest } from "../orchestration/rotation";
import { describeSeats, type SeatRow } from "../orchestration/seats-view";
import { parseSeat } from "../orchestration/seats";
import { refusedCaller, roomTool, TOOL_NAMES } from "./tool-table";
import { SUBJECT_SIGNALS } from "../signals";
import { roomStats } from "../stats";
import { graph, work } from "../tasks/tools";
import { refusal } from "../refusal";
import { WorkError } from "../tasks/store";
import { owns } from "../../shared/workflow";
import { fromRoom, taskOf, type RoomContext } from "./context";
import { readInbox, refused, sendMail } from "./mail-tools";

/** The room's MCP tools, each answering for the seat whose nonce called it. */

/** `role:id` and a bare id name the same seat. */
const ROLE_PREFIX = new RegExp(`^(?:${ROLES.join("|")}):`, "i");
const seatArg = (value: unknown) => String(value ?? "").trim().replace(ROLE_PREFIX, "");

/** How the room's mail stands: unwell stores, answers to asks, refusals by code. */
function mailHealth(room: RoomContext, since: string): string[] {
  const lines = room.engine
    .health()
    .map((ill) => `mail store ${ill.state} since ${ill.since.slice(0, 16)}: ${ill.folder}: ${ill.detail}`);
  const { minutes, open, refusals } = room.engine.answering(since);
  if (minutes.length > 0 || open > 0) {
    const sorted = [...minutes].sort((a, b) => a - b);
    const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null;
    lines.push(
      `asks answered: ${minutes.length}${median === null ? "" : `, half within ${median} min`}; still open: ${open}`,
    );
  }
  if (refusals.size > 0)
    lines.push(
      `mail refused: ${[...refusals]
        .sort((a, b) => b[1] - a[1])
        .map(([code, n]) => `${code} ${n}`)
        .join(", ")}`,
    );
  return lines;
}

/** Runs one call on a work store; a refusal reaches the seat as JSON. */
function asJson(run: () => unknown): string {
  try {
    return JSON.stringify(run());
  } catch (error) {
    if (error instanceof WorkError) throw new Error(refusal(error));
    throw error;
  }
}

export function registerTools(
  room: RoomContext,
  mcp: McpHttpServer,
  extra: { watchStats(): string },
): void {
  const { engine } = room;
  const vars = {
    signals: SUBJECT_SIGNALS.join(", "),
    keep_log_days: String(KEEP_LOG_DAYS),
    rotate_k: String(Math.round(room.rotateAt / 1000)),
    mail_chars: room.policy.room.params.mailChars.toLocaleString("en-US"),
  };
  const callerOf = (tool: string, nonce: string): string => {
    const me = room.callers.seatOf(nonce);
    if (!me || !engine.seat(me)) throw new Error(`${tool}: this session is not a registered room seat (unknown caller)`);
    const why = refusedCaller(tool, engine.seat(me)?.role);
    if (why) throw new Error(`${tool} refused: ${why}`);
    return me;
  };
  const handlers = new Map<string, McpToolHandler>();
  const add = (name: string, run: (args: Record<string, unknown>, me: string) => Promise<string> | string) =>
    handlers.set(name, async (args, context) => run(args, callerOf(name, context.nonce)));

  for (const [name, run] of [
    ["seatwork_mail", sendMail],
    ["seatwork_inbox", readInbox],
  ] as const)
    handlers.set(name, async (args, context) => {
      const me = room.callers.seatOf(context.nonce);
      try {
        if (!me) throw new Error(`${name}: this session is not a registered room seat (unknown caller)`);
        return await run(room, me, args);
      } catch (error) {
        throw refused(room, me, error);
      }
    });

  /** The work store and rules of a seat's project, and the seat as the store knows it. */
  const workOf = (tool: string, me: string) => {
    const root = engine.projectOf(me);
    if (!root)
      throw new Error(`${tool}: ${engine.seat(me)?.cwd} lies in no project of the room; a work store belongs to a project`);
    return { me: { id: me, owner: owns(engine.seat(me)?.role) }, ...room.works.of(root) };
  };
  add("seatwork_work", (args, me) =>
    asJson(() => {
      const { me: caller, store, rules } = workOf("seatwork_work", me);
      return work(store, rules, caller, args);
    }),
  );
  add("seatwork_graph", (args, me) =>
    asJson(() => {
      const { store, rules } = workOf("seatwork_graph", me);
      return graph(store, rules, args, new Date());
    }),
  );

  add("seatwork_seats", async (_args, me) => {
    const live = await room.host.live();
    const open = engine.allSeats().filter((seat) => live.has(seat.agentId));
    const rows: SeatRow[] = [];
    const held = (id: string) => {
      const mails = engine.held(id);
      return { heldMail: mails.length, ...(mails.length > 0 ? { heldSince: mails[0].at } : {}) };
    };
    // each seat under its Owner, the Owner first
    const under = (owner: string, depth: number) => {
      for (const seat of open) {
        if (engine.parentOf(seat.agentId) !== owner || depth > 16) continue;
        const now = live.get(seat.agentId)!;
        const usage = now.usage ?? room.lastUsage.get(seat.agentId);
        const retry = room.recovery.pending(seat.agentId);
        rows.push({
          agentId: seat.agentId,
          role: seat.role,
          title: seat.title,
          depth,
          status: now.status,
          waiting: now.waiting,
          updatedAt: now.updatedAt || null,
          turnStartedAt: now.turnStartedAt,
          ...held(seat.agentId),
          owes: engine.owes(seat.agentId),
          retry: retry ? retryNote(retry) : null,
          error: now.status === "error" ? (now.error ?? "").slice(0, 160) || null : null,
          contextTokens: usage?.contextWindowUsedTokens ?? null,
          costUsd: usage?.totalCostUsd ?? null,
          lastSignal: room.lastSignal.get(seat.agentId) ?? null,
          rejected: room.rounds.rejected(taskOf(room, seat.agentId)),
        });
        under(seat.agentId, depth + 1);
      }
    };
    under(me, 0);
    return describeSeats(rows, room.rotateAt, Date.now());
  });

  add("seatwork_rotate", async (args, me) => {
    const target = seatArg(args.agent_id);
    const seat = engine.seat(target);
    if (!seat) throw new Error("seatwork_rotate: give agent_id, the id of a seat under you (seatwork_seats lists them)");
    if (!engine.isAncestor(me, target)) throw new Error("seatwork_rotate refused: you replace only a seat under you");
    const status = await engine.recipientStatus(target);
    if (status === "gone") throw new Error(`seatwork_rotate refused: ${target} is archived or gone`);
    if (room.rotations.get(target))
      return `${seat.role} ${target} was already asked for its handoff; the notice comes when it answers.`;
    const asked = await engine.post({
      from: fromRoom,
      to: target,
      priority: "action",
      subject: "HANDOFF: write your handoff; a fresh seat continues your work",
      body: handoffRequest(String(args.why ?? "").trim()),
      needs: "reply",
      why: "the seat above you is replacing this seat with a fresh one, for the size of its context",
    });
    room.rotations.ask(target, me, asked.id, Date.now());
    return `asked ${seat.role} ${target} for its handoff${status === "running" ? "; it reads the request when its turn ends" : ""}. When it answers, the room starts its successor, hands its open seats over and archives it. You get one notice with the new seat's id.`;
  });

  add("seatwork_adopt", async (args, me) => {
    const child = seatArg(args.agent_id);
    if (!child) throw new Error("seatwork_adopt: give agent_id");
    const result = await engine.adopt(me, child);
    if (!result.ok) throw new Error(`seatwork_adopt refused: ${result.reason}`);
    const seat = engine.seat(child)!;
    if (result.previous !== me)
      await engine.post({
        from: fromRoom,
        to: child,
        priority: "fyi",
        subject: "OWNER CHANGED: you were handed over",
        body: "Your Owner seat changed. Mail addressed `to: owner`, your final messages and your permission requests now reach the new Owner; answer its mail with reply_to as usual. Your brief stands until the new Owner writes; continue your current work.",
        needs: "nothing",
        why: "a handoff moved you under a new Owner",
      });
    return `adopted ${seat.role} ${child} (${seat.title ?? ""}); it now reports to you. Mail it its brief and your disposition of its last signal.`;
  });

  const projects = () => room.host.projects();
  add("seatwork_projects", () => describeProjects(projects));
  add("seatwork_register_project", (args) =>
    registerProject(
      projects,
      {
        path: String(args.path ?? ""),
        name: args.name ? String(args.name) : undefined,
        mission: args.mission ? String(args.mission) : undefined,
        models: args.models ?? undefined,
      },
      room.addSeats,
    ),
  );
  add("seatwork_unregister_project", (args) =>
    unregisterProject(String(args.project ?? ""), async () =>
      [...(await room.host.live()).values()]
        .filter((seat) => parseSeat(seat.provider) && seat.cwd)
        .map((seat) => ({ title: seat.title ?? seat.id, cwd: seat.cwd })),
    ),
  );
  add("seatwork_room_stats", (args) =>
    roomStats(
      Number(args.days) > 0 ? Number(args.days) : KEEP_LOG_DAYS,
      (since) => engine.posted(since),
      (since) => mailHealth(room, since),
    ),
  );
  add("seatwork_watch_stats", () => extra.watchStats());

  // a seat is shown the tools in the table's order
  for (const name of TOOL_NAMES) {
    const run = handlers.get(name);
    if (!run) throw new Error(`seatwork: shared/tools.json defines ${name}, which the room does not serve`);
    mcp.register(roomTool(name, vars), run);
  }
}
