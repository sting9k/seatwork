import { owns, ROLES } from "../../shared/workflow";
import type { SeatRecord } from "../coordination/engine";
import { KEEP_LOG_DAYS } from "../gc";
import type { LiveSeat } from "../host";
import type { McpHttpServer, McpToolHandler } from "../mcp-http";

import { describeProjects, registerProject, unregisterProject } from "../orchestration/onboard";
import { retryNote } from "../orchestration/recovery";
import { handoffRequest } from "../orchestration/rotation";
import { describeSeats, type SeatRow } from "../orchestration/seats-view";
import { parseSeat } from "../orchestration/seats";
import { afterWork } from "../orchestration/work-forks";
import { enumRefusal, refusedCaller, roomTool, TOOL_NAMES } from "./tool-table";
import { SUBJECT_SIGNALS } from "../signals";
import { unreadScopes, type Plan, type Work } from "../tasks/graph";
import { graph, work } from "../tasks/tools";
import { refusal } from "../refusal";
import { WorkError } from "../tasks/store";
import { KnowledgeRefused } from "../knowledge/refused";
import { OperationsRefused } from "../operations/index";
import { StoreError } from "../sqlite";
import { fromRoom, taskOf, type RoomContext } from "./context";
import { readInbox, refused, sendMail } from "./mail-tools";
import { clip } from "../excerpt";

/** The room's MCP tools, each answering for the seat whose nonce called it. */

const ROLE_PREFIX = new RegExp(`^(?:${ROLES.join("|")}):`, "i");
const OVERLAPS_ASKED = 64;
const MOST_DEPTH = 16;
const MOST_WHY_CHARS = 300;
const MOST_REASON_CHARS = 500;

/** A seat id as a tool argument: `role:id` and a bare id name the same seat. */
const seatArg = (value: unknown) =>
  String(value ?? "")
    .trim()
    .replace(ROLE_PREFIX, "");

/** How the room's mail stands: unwell stores, answers to asks, refusals by code. */
export function mailHealth(room: RoomContext, since: string): string[] {
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

/** A Task district call's answer; its refusal is said as JSON a seat can act on. */
function answered<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkError) throw new Error(refusal(error));
    throw error;
  }
}

/** A plan with the overlaps the decision model is sure of, where a scope names no path to compare. */
async function readOverlaps(room: RoomContext, work: () => Work, plan: Plan): Promise<Plan> {
  if (!room.forks.open("overlap")) return plan;
  const pairs = unreadScopes(work(), plan, OVERLAPS_ASKED);
  const ids = pairs.map((_, index) => `p${index + 1}`);
  const labels = await room.forks.takeMany(
    "overlap",
    {
      pairs: Object.fromEntries(
        pairs.map((pair, index) => [ids[index], { a: clip(pair.scopes[0], 400), b: clip(pair.scopes[1], 400) }]),
      ),
    },
    ids,
  );
  const read = pairs
    .filter((_, index) => labels[index] === "true")
    .map(({ a, b }) => ({ a, b, paths: [], read: "the decision model reads both scopes as the same code" }));
  return read.length ? { ...plan, overlaps: [...plan.overlaps, ...read] } : plan;
}

const said = (value: unknown) => String(value ?? "").trim();
const reasonOf = (args: Record<string, unknown>) => said(args.reason).slice(0, MOST_REASON_CHARS);
const idOf = (args: Record<string, unknown>) => Number(String(args.id ?? "").replace(/^#/, ""));

/** seatwork_safety: one action of the room's safety for the seat `me`. */
async function safetyTool(room: RoomContext, me: string, args: Record<string, unknown>): Promise<string> {
  const action = String(args.action ?? "");
  if (action === "ack") {
    const id = said(args.id);
    const reason = reasonOf(args);
    if (!id || reason.length < 10)
      throw new Error("seatwork_safety ack: give the finding's `id` and a `reason` of a sentence");
    return room.safety.acknowledge(me, id, reason)
      ? `Acknowledged ${id}: it rides up with your next candidate, with your reason.`
      : `No finding ${id} of yours: copy the id from the returned candidate.`;
  }
  if (action === "council") return room.safety.councilLines(Number(args.days) > 0 ? Number(args.days) : 30);
  if (action === "label") {
    const id = idOf(args);
    const value = String(args.value ?? "");
    const reason = reasonOf(args);
    if (!Number.isInteger(id) || (value !== "right" && value !== "wrong") || reason.length < 10)
      throw new Error(
        "seatwork_safety label: give the finding's `id`, `value` right or wrong, and a `reason` of a sentence",
      );
    return room.safety.label(me, id, value, reason);
  }
  if (action === "rule") {
    const id = idOf(args);
    const reason = reasonOf(args);
    if (!Number.isInteger(id) || typeof args.send_back !== "boolean" || reason.length < 10)
      throw new Error(
        "seatwork_safety rule: give the appeal's `id`, `send_back` true or false, and a `reason` of a sentence",
      );
    return room.safety.rule(me, id, args.send_back, reason);
  }
  if (action === "control") {
    const writer = said(args.seat);
    const owner = room.engine.parentOf(writer);
    if (!room.engine.seat(writer) || !owner || (me !== owner && room.engine.parentOf(me) !== owner))
      throw new Error("seatwork_safety control: give the `seat` of a writer under you, or beside you under one Owner");
    return room.safety.control(writer);
  }
  throw new Error("seatwork_safety: `action` is ack, council, label, rule or control");
}

/** The open seats under `me`, each below its Owner, in the order the room registered them. */
function seatRows(room: RoomContext, me: string, live: ReadonlyMap<string, LiveSeat>): SeatRow[] {
  const { engine } = room;
  const below = new Map<string | null, SeatRecord[]>();
  for (const seat of engine.allSeats()) {
    if (!live.has(seat.agentId)) continue;
    const owner = engine.parentOf(seat.agentId);
    below.set(owner, [...(below.get(owner) ?? []), seat]);
  }
  const rows: SeatRow[] = [];
  const walk = (owner: string, depth: number) => {
    if (depth > MOST_DEPTH) return;
    for (const seat of below.get(owner) ?? []) {
      const now = live.get(seat.agentId)!;
      const usage = now.usage ?? room.lastUsage.get(seat.agentId);
      const retry = room.recovery.pending(seat.agentId);
      const held = engine.holding(seat.agentId);
      rows.push({
        agentId: seat.agentId,
        role: seat.role,
        title: seat.title,
        depth,
        status: now.status,
        waiting: now.waiting,
        updatedAt: now.updatedAt || null,
        turnStartedAt: now.turnStartedAt,
        heldMail: held?.mails ?? 0,
        ...(held?.oldestAt ? { heldSince: held.oldestAt } : {}),
        ...(held?.later ? { heldForRound: { reports: held.later, dueAt: held.dueAt! } } : {}),
        owes: engine.owes(seat.agentId),
        retry: retry ? retryNote(retry) : null,
        error: now.status === "error" ? (now.error ?? "").slice(0, 160) || null : null,
        contextTokens: usage?.contextWindowUsedTokens ?? null,
        costUsd: usage?.totalCostUsd ?? null,
        lastSignal: room.lastSignal.get(seat.agentId) ?? null,
        rejected: room.rounds.rejected(taskOf(room, seat.agentId)),
      });
      walk(seat.agentId, depth + 1);
    }
  };
  walk(me, 0);
  return rows;
}

/** Serves the room's tools on `mcp`, in the order shared/tools.json lists them. */
export function registerTools(room: RoomContext, mcp: McpHttpServer): void {
  const { engine } = room;
  const vars = {
    signals: SUBJECT_SIGNALS.join(", "),
    keep_log_days: String(KEEP_LOG_DAYS),
    rotate_k: String(Math.round(room.rotateAt / 1000)),
    mail_chars: room.policy.room.params.mailChars.toLocaleString("en-US"),
  };
  const callerOf = (tool: string, nonce: string): string => {
    const me = room.callers.seatOf(nonce);
    if (!me || !engine.seat(me))
      throw new Error(`${tool}: this session is not a registered room seat (unknown caller)`);
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
      throw new Error(
        `${tool}: ${engine.seat(me)?.cwd} lies in no project of the room; a work store belongs to a project`,
      );
    return { me: { id: me, owner: owns(engine.seat(me)?.role) }, ...room.works.of(root) };
  };
  add("seatwork_work", async (args, me) => {
    const { me: caller, store, rules } = workOf("seatwork_work", me);
    const done = answered(() => work(store, rules, caller, args));
    return JSON.stringify(await afterWork(room, store, me, args, done));
  });
  add("seatwork_graph", async (args, me) => {
    const { store, rules } = workOf("seatwork_graph", me);
    const answer = answered(() => graph(store, rules, args, new Date()));
    return JSON.stringify(
      args.view === "plan" ? await readOverlaps(room, () => store.openWork(), answer as Plan) : answer,
    );
  });

  add("seatwork_knowledge", async (args, me) => {
    try {
      return JSON.stringify(await room.knowledge.act(me, args));
    } catch (error) {
      if (error instanceof KnowledgeRefused) throw new Error(refusal(error));
      if (error instanceof StoreError)
        throw new Error(
          refusal({ code: error.code, message: error.message, retryable: error.code === "DATABASE_LOCKED" }),
        );
      throw error;
    }
  });

  add("seatwork_safety", (args, me) => safetyTool(room, me, args));

  add("seatwork_seats", async (_args, me) =>
    describeSeats(seatRows(room, me, await room.host.live()), room.rotateAt, Date.now()),
  );

  add("seatwork_rotate", async (args, me) => {
    const target = seatArg(args.agent_id);
    const seat = engine.seat(target);
    if (!seat)
      throw new Error("seatwork_rotate: give agent_id, the id of a seat under you (seatwork_seats lists them)");
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
      body: handoffRequest(clip(said(args.why), MOST_WHY_CHARS)),
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
        law: args.law ? String(args.law) : undefined,
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
  add("seatwork_room", (args, me) => {
    try {
      return JSON.stringify(room.operations.act(me, args));
    } catch (error) {
      if (error instanceof OperationsRefused) throw new Error(refusal(error));
      if (error instanceof StoreError)
        throw new Error(
          refusal({ code: error.code, message: error.message, retryable: error.code === "DATABASE_LOCKED" }),
        );
      throw error;
    }
  });

  for (const name of TOOL_NAMES) {
    const run = handlers.get(name);
    if (!run) throw new Error(`seatwork: shared/tools.json defines ${name}, which the room does not serve`);
    mcp.register(roomTool(name, vars), async (args, context) => {
      const wrong = enumRefusal(name, args);
      if (wrong) throw new Error(wrong);
      return run(args, context);
    });
  }
  // a seat is listed the tools its role may call; a session the room does not know yet is listed them all
  mcp.visible = (tool, context) => {
    const role = engine.seat(room.callers.seatOf(context.nonce) ?? "")?.role;
    return role === undefined || refusedCaller(tool, role) === null;
  };
}
