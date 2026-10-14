import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { maySpawn, reviews, routeOpen, SPAWN } from "../../shared/workflow";
import { MailEngine } from "../coordination/engine";
import { Collector } from "../gc";
import type { Host } from "../host";
import { McpHttpServer } from "../mcp-http";
import { findProject, findRoomMarker, loadRegistry, roomProjectDir } from "../orchestration/registry";
import { Recovery, resumeDue } from "../orchestration/recovery";
import { ReviewGate } from "../orchestration/review-gate";
import { Rotations } from "../orchestration/rotation";
import { Rounds } from "../orchestration/rounds";
import { describeIsolation, ensureRuntime, envFor } from "../orchestration/runtimes";
import { enabledSeats, parseSeat } from "../orchestration/seats";
import {
  CLAUDE_HOME,
  CODEX_HOME,
  OPENCODE_CONFIG_HOME,
  PASEO_HOME,
  PI_HOME,
  REGISTRY_LOG,
  ROOM_HOME,
  SAFETY_DIR,
  SEAT_TMP_DIR,
  USER_HOME,
} from "../paths";
import { loadPolicy, type RuntimePolicy } from "../policy";
import { OwedList, roomStatus } from "./status";
import { Safety } from "../safety/index";
import { render, type Cli } from "../safety/hooks";
import { WorkStores } from "../tasks/stores";
import { Callers, serverToken } from "./callers";
import { fromRoom, releaseWork, type RoomContext } from "./context";
import { launch, type Launched, type SeatLaunch } from "./launch";
import { registerTools } from "./tools";
import { rotationFailed, turnEnded, type SeatEvent, type TurnEnd } from "./turns";

export type { SeatEvent, TurnEnd } from "./turns";

/** The room's own mail, and its MCP server's token and callers. */
const ROOM_MAIL = join(ROOM_HOME, "mail");

/** A room seat's start as the room lays it out: its launch, the nonce that names it, its MCP server. */
export interface SeatStart extends Launched {
  env: Record<string, string>;
  mcpUrl: string;
}

/** A room that is set up on this machine and running: the app tells it what its seats do. */
export interface Room {
  policy: RuntimePolicy;
  /** The plugin version that wrote the room's files: prompts and code are one release. */
  filesFrom: string | undefined;
  /** A room seat's start: held to its project and table, given its prompt and the room's MCP server. */
  launch(request: SeatLaunch): Promise<SeatStart>;
  /** A seat's session opens: the env its runtime needs, or null for an agent that is no room seat. */
  opened(agentId: string, provider: string, nonce: string | undefined, created: boolean): Record<string, string> | null;
  created(seat: SeatEvent): Promise<void>;
  turnStarted(seat: SeatEvent): void;
  turnEnded(end: TurnEnd): Promise<void>;
  archived(seat: SeatEvent): Promise<void>;
  /** A runtime closed and took its turn with it: no end will come for it. */
  closed(agentId: string): void;
  permissionAsked(seat: SeatEvent, request: unknown): Promise<void>;
  permissionAnswered(agentId: string): void;
  /** The titles of open seats that got their prompt from another plugin version. */
  olderSeats(): Promise<string[]>;
  /** The turns that left something for the Owner; the app asks while it is open. */
  waiting(): Promise<{ chime: boolean; waiting: Awaited<ReturnType<OwedList["current"]>> }>;
  status(): ReturnType<typeof roomStatus>;
  stop(): Promise<void>;
}

/** The project a directory lies in, by the registry or by the room's marker above it. */
function projectRoot(cwd: string): string | null {
  const registry = loadRegistry();
  return (registry ? findProject(registry, cwd)?.root : undefined) ?? findRoomMarker(cwd)?.root ?? null;
}

/** Starts the room on this machine's files: its districts, its MCP server and its timers. */
export function startRoom(input: {
  host: Host;
  version: string;
  filesFrom: string | undefined;
  /** Sets up seats the room does not have yet; the app's own setup does it. */
  addSeats(providers: string[]): Promise<void>;
}): Room {
  const { host, version, filesFrom } = input;
  // the room home holds mail bodies and copies of the user's harness config: its owner only
  chmodSync(ROOM_HOME, 0o700);
  mkdirSync(ROOM_MAIL, { recursive: true });
  mkdirSync(roomProjectDir(), { recursive: true });
  const policy = loadPolicy();
  const log = (message: string) => console.log(`seatwork: ${message}`);
  try {
    const seats = enabledSeats();
    for (const seat of seats) ensureRuntime(seat, policy);
    console.log(
      `seatwork ${version}: ${seats.length} seats enabled (${seats.map((s) => s.provider).join(", ")}); runtimes under ${ROOM_HOME}/runtimes`,
    );
    console.log(`seatwork: isolation: ${describeIsolation()}`);
  } catch (error) {
    console.error("seatwork: building runtimes failed; they will be retried per seat", error);
  }

  const engine = new MailEngine(host, policy.mail, log, {
    rootOf: projectRoot,
    mailChars: policy.room.params.mailChars,
    quietChars: policy.mail.quietChars,
    dedupeSeconds: policy.mail.dedupeSeconds,
  });
  const safety = new Safety({
    dir: SAFETY_DIR,
    userHome: USER_HOME,
    policy: () => policy.safety,
    seat: (id) => {
      const record = engine.seat(id);
      return record ? { role: record.role, cwd: record.cwd ?? null } : null;
    },
    projectOf: (id) => engine.projectOf(id),
    isAncestor: (ancestor, id) => engine.isAncestor(ancestor, id),
    tmpOf: (id) => join(SEAT_TMP_DIR, id.slice(0, 8)),
    // what decides how every seat runs: the room, the agents' homes, the app's config
    guard: {
      paths: [ROOM_HOME, CLAUDE_HOME, CODEX_HOME, PI_HOME, OPENCODE_CONFIG_HOME, PASEO_HOME],
      except: [SEAT_TMP_DIR, roomProjectDir()],
    },
    roomFolder: ".seatwork",
    repeated: (seat, rule, count, command) => {
      const owner = engine.parentOf(seat);
      if (!owner) return;
      void engine
        .post({
          from: fromRoom,
          to: owner,
          priority: "action",
          subject: `GUARD: ${engine.seat(seat)?.title ?? seat} hit ${rule} ${count} times`,
          body: `The room's guard blocked the same rule ${count} times in a row for this seat. Last command: ${command}\nIt may be trying other ways round the block. Read its work, and grant a code with seatwork_safety only if the command is right.`,
          needs: "nothing",
          why: "a seat under you keeps running into the room's guard",
        })
        .catch((error) => console.error("seatwork: the guard's notice was not sent", error));
    },
    log,
  });
  if (safety.on) safety.install();
  const room: RoomContext = {
    host,
    policy,
    version,
    log,
    engine,
    works: new WorkStores(policy.room.work, log),
    rounds: new Rounds(join(ROOM_HOME, "rounds.json")),
    gate: new ReviewGate(),
    recovery: new Recovery(join(ROOM_HOME, "recovery.json"), policy.room.recovery),
    rotations: new Rotations(join(ROOM_HOME, "rotations.json")),
    owed: new OwedList(join(ROOM_HOME, "owed.json")),
    callers: new Callers(join(ROOM_MAIL, "nonces.json")),
    safety,
    mailedUp: new Map(),
    lastSignal: new Map(),
    lastUsage: new Map(),
    rotateAt: policy.room.params.rotateAtTokens ?? Infinity,
    addSeats: input.addSeats,
  };
  /** An archived seat can never call the room's tools again. */
  const forget = (agentId: string) => {
    room.rounds.forget(agentId);
    room.lastUsage.delete(agentId);
    room.callers.forget(agentId);
    safety.forget(agentId);
  };
  const gc = new Collector(
    host,
    engine,
    policy.gc,
    log,
    forget,
    policy.mail.keepDays,
    policy.mail.expireUnreadDays,
    (before) => safety.expire(before),
  );

  const mcp = new McpHttpServer(serverToken(join(ROOM_MAIL, "token")), "seatwork", version);
  registerTools(room, mcp);
  // the guard's hooks ask here before a command or a file write
  mcp.route("gate", async (body, request) => {
    const cli = (request.query.get("cli") ?? "claude") as Cli;
    try {
      return await safety.answer(cli, JSON.parse(body) as Record<string, unknown>, request.header("x-seat") || null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`the guard failed on a ${cli} call: ${reason}`);
      return render(cli, {
        allow: false,
        message: `The room's guard failed while checking this call (${reason}), so it does not run.`,
        finding: null,
        code: null,
        grantor: null,
      });
    }
  });
  let port = policy.mail.port;
  const starting = mcp
    .listen(port)
    .then((bound) => {
      port = bound;
      log(`the room's MCP server on 127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error(
        `seatwork: the room's MCP server failed to listen on ${port}; the room's tools are unavailable`,
        error,
      );
    });

  // a rotation left half-done by a stop of the plugin is said once, not repeated
  for (const [seat, asked] of room.rotations.interrupted) {
    const record = engine.seat(seat);
    if (record)
      void rotationFailed(
        room,
        asked.by,
        record,
        "the room stopped while it started the successor; seatwork_seats shows whether one stands",
      ).catch((error) => console.error("seatwork: the notice of an interrupted rotation was not sent", error));
  }

  // what waits is moved every minute: held mail, failed turns due again, handoffs never written
  const sweep = setInterval(() => {
    void engine.sweep().catch((error) => console.error("seatwork: the mail sweep failed", error));
    void resumeDue(room.recovery, engine, Date.now()).catch((error) =>
      console.error("seatwork: resuming a failed seat did not work", error),
    );
    for (const [seat, asked] of room.rotations.expired(Date.now(), policy.room.rotation?.answerMinutes ?? 120)) {
      const record = engine.seat(seat);
      if (record)
        void rotationFailed(room, asked.by, record, "it did not answer the handoff request in time").catch((error) =>
          console.error("seatwork: the notice of a failed rotation was not sent", error),
        );
    }
  }, 60_000);
  // the collector reads the app's seats: it starts once the app has handed the room a way in
  let touched = false;
  /** The app's first word after a start: held mail moves at once rather than at the next sweep. */
  const touch = () => {
    if (touched) return;
    touched = true;
    void engine.sweep().catch((error) => console.error("seatwork: the mail sweep failed", error));
  };
  const collect = setInterval(
    () => {
      if (touched) void gc.run();
    },
    Math.max(1, policy.gc.everyMinutes) * 60_000,
  );

  return {
    policy,
    filesFrom,
    async launch(request) {
      await starting;
      const launched = launch(request, policy, log);
      // agent.session_open ties this nonce to the agent id
      const nonce = room.callers.issue();
      return { ...launched, env: { SEATWORK_NONCE: nonce }, mcpUrl: mcp.urlFor(port, nonce) };
    },
    opened(agentId, provider, nonce, created) {
      if (nonce && created) room.callers.bind(nonce, agentId);
      touch();
      const seat = parseSeat(provider);
      if (!seat) return null;
      // the app saves no env with an agent: a reopened seat would start on the user's own home
      ensureRuntime(seat);
      // a temporary directory per seat: one seat's cleanup cannot take another seat's files
      const tmp = join(SEAT_TMP_DIR, agentId.slice(0, 8));
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      return { ...envFor(seat, policy), TMPDIR: tmp, ...safety.env(agentId, mcp.routeUrl(port, "gate")) };
    },
    async created(agent) {
      touch();
      const seat = parseSeat(agent.provider);
      const parent = agent.parentId ? engine.seat(agent.parentId) : undefined;
      // a seat may create only what the workflow's spawn table gives its role
      if (parent && !(seat && maySpawn(parent.role, seat.role, agent.title))) {
        const allowed = (SPAWN[parent.role] ?? []).join(", ") || "nothing";
        const what = seat ? `a ${seat.role} seat` : `a non-room agent (provider ${agent.provider})`;
        log(`spawn refused: ${parent.role} ${parent.agentId} created ${what} ${agent.id}; archiving it`);
        // the app sends a new agent its first prompt without waiting for this: the seat may be at work already
        let outcome =
          "The room archived it. If you gave it a first prompt, that turn may have started before the archive: check what it changed.";
        try {
          await host.archive(agent.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          log(`spawn refused: could not archive ${agent.id}: ${reason}`);
          outcome = `The room could not archive it (${reason}), so it is still there: archive ${agent.id} yourself, then check what it changed.`;
        }
        await engine.post({
          from: fromRoom,
          to: parent.agentId,
          priority: "blocking",
          subject: `SPAWN REFUSED: a ${parent.role} may create only ${allowed}`,
          body: `You created ${what} titled "${agent.title ?? ""}". ${outcome} Create only the roles your role allows (${allowed}), on the room's providers, and continue.`,
          needs: "nothing",
          why: "a seat you created was outside the room's spawn rules",
        });
        return;
      }
      if (!seat) return;
      const record = {
        agentId: agent.id,
        parentAgentId: agent.parentId,
        role: seat.role,
        provider: seat.provider,
        title: agent.title,
        cwd: agent.cwd,
        version,
      };
      engine.rememberSeat(record);
      void safety
        .started(agent.id, agent.cwd)
        .catch((error) => console.error("seatwork: the guard did not note where a seat starts", error));
      if (parent && policy.mail.gatherReviews && reviews(seat.role, agent.title))
        room.gate.launched(parent.agentId, agent.id);
      try {
        appendFileSync(REGISTRY_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
      } catch (error) {
        console.error("seatwork: cannot append registry log", error);
      }
    },
    turnStarted(seat) {
      touch();
      room.owed.clear(seat.id);
      room.gate.turnStarted(seat.id);
    },
    turnEnded: (end) => turnEnded(room, end),
    async archived(seat) {
      const id = seat.id;
      room.owed.clear(id);
      room.mailedUp.delete(id);
      room.lastSignal.delete(id);
      room.recovery.forget(id);
      try {
        releaseWork(room, id, null);
      } catch (error) {
        console.error(`seatwork: the work of ${id} could not be released`, error);
      }
      const asked = room.rotations.get(id);
      room.rotations.done(id);
      room.gate.ownerGone(id);
      if (asked && engine.seat(asked.by))
        await engine
          .post({
            from: fromRoom,
            to: asked.by,
            priority: "action",
            subject: `ROTATION FAILED: ${seat.title ?? id} was archived before its handoff`,
            body: "The seat you asked to replace was archived before it wrote its handoff. Nothing was started for it; brief a new seat if its work still matters.",
            needs: "nothing",
            why: "the rotation you asked for did not happen",
          })
          .catch((error) => console.error("seatwork: the notice of a failed rotation was not sent", error));
      // a reviewer archived before its report holds its round back no longer
      const round = room.gate.gone(id);
      const owner = round ? engine.parentOf(id) : null;
      if (round && owner) await engine.release(owner, round);
      await gc.onArchived(id);
    },
    closed(agentId) {
      room.mailedUp.delete(agentId);
      engine.takeWake(agentId);
    },
    async permissionAsked(agent, request) {
      const seat = parseSeat(agent.provider);
      const parentId = engine.parentOf(agent.id) ?? agent.parentId;
      const parent = parentId ? engine.seat(parentId) : undefined;
      // where the route up is off, the parent looks at the room instead of being told
      if (!seat || !parent || !routeOpen(seat.role, parent.role)) return;
      await engine.post({
        from: { agentId: agent.id, role: seat.role },
        to: parent.agentId,
        priority: "blocking",
        subject: `PERMISSION: ${seat.role} ${agent.title ?? agent.id} is waiting for approval`,
        body: JSON.stringify(request).slice(0, 2000),
        needs: "decision",
        why: "the seat is stopped until someone answers with respond_to_permission",
      });
    },
    permissionAnswered(agentId) {
      engine.settlePermission(agentId);
    },
    async olderSeats() {
      return [...(await host.live()).values()]
        .filter((seat) => parseSeat(seat.provider) && engine.seat(seat.id)?.version !== version)
        .map((seat) => seat.title ?? seat.id);
    },
    async waiting() {
      touch();
      return { chime: policy.owner.chime, waiting: await room.owed.current(() => host.live()) };
    },
    status: async () => roomStatus(await host.live(), engine, room.owed),
    async stop() {
      clearInterval(sweep);
      clearInterval(collect);
      room.works.close();
      engine.close();
      safety.close();
      // a mail server still binding would stay open behind a close that came first
      await starting;
      await mcp.close();
    },
  };
}
