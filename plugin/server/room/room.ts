import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { inRoom, maySpawn, reviews, routeOpen, SPAWN, traits } from "../../shared/workflow";
import { MailEngine } from "../coordination/engine";
import { Collector } from "../gc";
import type { Host } from "../host";
import { McpHttpServer, type Route } from "../mcp-http";
import { projectRootOf, roomProjectDir } from "../orchestration/registry";
import { clip, Forks } from "../orchestration/forks";
import { Recovery, resumeDue } from "../orchestration/recovery";
import { ReviewGate } from "../orchestration/review-gate";
import { Rotations } from "../orchestration/rotation";
import { Rounds } from "../orchestration/rounds";
import { describeIsolation, ensureRuntime, envFor } from "../orchestration/runtimes";
import { enabledSeats, parseSeat } from "../orchestration/seats";
import {
  CLAUDE_HOME,
  CODEX_HOME,
  JEV_DIR,
  KNOWLEDGE_DIR,
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
import { Jev } from "../jev/index";
import { Knowledge } from "../knowledge/index";
import { Safety } from "../safety/index";
import { render, type Cli } from "../safety/hooks";
import { WorkStores } from "../tasks/stores";
import { Callers, serverToken } from "./callers";
import { fromRoom, releaseWork, taskOf, type RoomContext } from "./context";
import { lookAtRunningTurns } from "./council";
import { launch, type Launched, type SeatLaunch } from "./launch";
import { registerTools } from "./tools";
import { rotationFailed, turnEnded, type SeatEvent, type TurnEnd } from "./turns";

/** The running room: it wires the districts, serves the seats' MCP tools, and reacts to the app's events. */

export type { SeatEvent, TurnEnd } from "./turns";

const ROOM_MAIL = join(ROOM_HOME, "mail");

/** A room seat's start as the room lays it out: its launch, the nonce that names it, its MCP server. */
interface SeatStart extends Launched {
  env: Record<string, string>;
  mcpUrl: string;
}

/** A room set up and running on this machine: the app hands it each seat's start, session, turns and archive, and asks what waits for the Owner. */
export interface Room {
  policy: RuntimePolicy;
  filesFrom: string | undefined;
  launch(request: SeatLaunch): Promise<SeatStart>;
  opened(agentId: string, provider: string, nonce: string | undefined, created: boolean): Record<string, string> | null;
  created(seat: SeatEvent): Promise<void>;
  turnStarted(seat: SeatEvent): void;
  turnEnded(end: TurnEnd): Promise<void>;
  archived(seat: SeatEvent): Promise<void>;
  closed(agentId: string): void;
  permissionAsked(seat: SeatEvent, request: unknown): Promise<void>;
  permissionAnswered(agentId: string): void;
  olderSeats(): Promise<string[]>;
  waiting(): Promise<{ chime: boolean; waiting: Awaited<ReturnType<OwedList["current"]>> }>;
  status(): ReturnType<typeof roomStatus>;
  stop(): Promise<void>;
}

/** Builds every enabled seat's runtime home; a failure is logged, and each seat's runtime is tried again at its start. */
function buildRuntimes(policy: RuntimePolicy, version: string): void {
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
}

/** The Knowledge district over the room's seats, mail and work; `room` is read only when it is called on. */
function startKnowledge(
  engine: MailEngine,
  jev: Jev,
  policy: RuntimePolicy,
  room: () => RoomContext,
  log: (message: string) => void,
): Knowledge {
  return new Knowledge({
    roomDir: KNOWLEDGE_DIR,
    policy: () => policy.knowledge,
    projectOf: (id) => engine.projectOf(id),
    projects: () => engine.projects(),
    mailAfter: (root, id, limit) => engine.mailAfter(root, id, limit),
    seen: (reader) =>
      inRoom(engine.seat(reader)?.role)
        ? null
        : [
            reader,
            ...engine.allSeats().flatMap((seat) => (engine.isAncestor(reader, seat.agentId) ? [seat.agentId] : [])),
          ],
    ownedTask: (id, task) => {
      // a short id names the same task as its full one; the work store knows the full one
      let full = task;
      let createdBy: string | null = null;
      try {
        const issue = room().works.existing(engine.projectOf(id))?.get(task);
        if (issue) [full, createdBy] = [issue.id, issue.created_by];
      } catch {
        // a task the store does not know is checked by its id as given
      }
      if (taskOf(room(), id) === full || createdBy === id) return full;
      const below = engine
        .allSeats()
        .some((seat) => engine.isAncestor(id, seat.agentId) && taskOf(room(), seat.agentId) === full);
      return below ? full : null;
    },
    isRoomSeat: (id) => inRoom(engine.seat(id)?.role),
    briefs: (id) => traits(engine.seat(id)?.role).briefs === true,
    taskOf: (id) => taskOf(room(), id),
    rootOf: projectRootOf,
    threadsOf: (id) => engine.threadsFor(id, 5),
    judge: jev,
    busyTimeoutMs: policy.room.work?.busyTimeoutMs ?? 5000,
    log,
  });
}

/** The Safety district over the room's seats; the notice of a rule a seat keeps hitting goes to its Owner by mail. */
function startSafety(engine: MailEngine, jev: Jev, policy: RuntimePolicy, log: (message: string) => void): Safety {
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
    decider: jev,
    log,
  });
  if (safety.on) safety.install();
  return safety;
}

/** The guard's route on the MCP server: its hooks ask here before a command or a file write. */
function gateRoute(safety: Safety, knowledge: Knowledge, log: (message: string) => void): Route {
  return async (body, request) => {
    const cli = (request.query.get("cli") ?? "claude") as Cli;
    try {
      const seat = request.header("x-seat") || null;
      // what a seat should be told rides on the guard's answer to its next command, inside its turn
      const notices = seat ? knowledge.noticesFor(seat) : null;
      const answered = await safety.answer(cli, JSON.parse(body) as Record<string, unknown>, seat, notices?.text);
      if (answered.noted) notices?.told();
      return { type: answered.type, text: answered.text };
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
  };
}

/** A seat its creator was not allowed to create is archived, and the creator is told what happened. */
async function refuseSpawn(
  room: RoomContext,
  agent: SeatEvent,
  parent: string,
  role: string,
  what: string,
): Promise<void> {
  const { host, engine, log } = room;
  const allowed = (SPAWN[role] ?? []).join(", ") || "nothing";
  log(`spawn refused: ${role} ${parent} created ${what} ${agent.id}; archiving it`);
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
    to: parent,
    priority: "blocking",
    subject: `SPAWN REFUSED: a ${role} may create only ${allowed}`,
    body: `You created ${what} titled "${agent.title ?? ""}". ${outcome} Create only the roles your role allows (${allowed}), on the room's providers, and continue.`,
    needs: "nothing",
    why: "a seat you created was outside the room's spawn rules",
  });
}

/** The decision model's pick among the open asks an answer may settle, or null to keep the engine's own rule. */
function chooseAsk(forks: Forks): NonNullable<MailEngine["chooseAsk"]> {
  return async (answer, asks) => {
    const idOf = (id: number) => `m${id}`;
    const label = await forks.take(
      "answers",
      {
        reply: { subject: answer.subject, body: clip(answer.body, 1500) },
        asks: Object.fromEntries(
          asks.map((ask) => [idOf(ask.id), { subject: ask.subject, body: clip(ask.body, 600) }]),
        ),
      },
      Object.fromEntries([
        ...asks.map((ask) => [idOf(ask.id), `it answers asks.${idOf(ask.id)}`] as const),
        ["none", "it answers none of them"] as const,
      ]),
    );
    if (label === null) return null;
    return { ask: label === "none" ? null : Number(label.slice(1)) };
  };
}

/** The room's MCP server: its tools and the guard's route, listening on the policy's port. */
function serve(room: RoomContext, safety: Safety, knowledge: Knowledge) {
  const mcp = new McpHttpServer(serverToken(join(ROOM_MAIL, "token")), "seatwork", room.version);
  registerTools(room, mcp);
  mcp.route("gate", gateRoute(safety, knowledge, room.log));
  let port = room.policy.mail.port;
  let unbound: string | null = null;
  const started = mcp
    .listen(port)
    .then((bound) => {
      port = bound;
      room.log(`the room's MCP server on 127.0.0.1:${port}`);
    })
    .catch((error) => {
      unbound = error instanceof Error ? error.message : String(error);
      console.error(
        `seatwork: the room's MCP server failed to listen on ${port}; the room's tools are unavailable`,
        error,
      );
    });
  return { mcp, started, port: () => port, unbound: () => unbound };
}

/** The room's timers: the minute's sweep, the collector and the council's look; `touch` is the app's first word. */
function startTimers(room: RoomContext, gc: Collector): { touch(): void; stop(): void } {
  const { engine, safety, policy, log } = room;
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
    try {
      room.knowledge.tick();
    } catch (error) {
      log(`knowledge: the minute's pass failed: ${(error as Error).message}`);
    }
    void resumeDue(room.recovery, engine, Date.now(), log).catch((error) =>
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
  const collect = setInterval(
    () => {
      if (touched) void gc.run();
    },
    Math.max(1, policy.gc.everyMinutes) * 60_000,
  );
  // the council looks at running turns for loops and silence; one look at a time
  let looking = false;
  const councilTick = setInterval(
    () => {
      if (looking || !safety.council.on) return;
      looking = true;
      void lookAtRunningTurns(room)
        .catch((error) => log(`the council could not look at running turns: ${String(error)}`))
        .finally(() => (looking = false));
    },
    Math.max(15, policy.safety?.council?.tickSeconds ?? 60) * 1000,
  );
  return {
    touch() {
      if (touched) return;
      touched = true;
      // held mail moves at once rather than at the next sweep
      void engine.sweep().catch((error) => console.error("seatwork: the mail sweep failed", error));
    },
    stop() {
      clearInterval(sweep);
      clearInterval(collect);
      clearInterval(councilTick);
    },
  };
}

/** A new seat of the room: the room remembers it, the guard notes where it starts, a reviewer joins its round. */
async function seatCreated(room: RoomContext, agent: SeatEvent): Promise<void> {
  const seat = parseSeat(agent.provider);
  const parent = agent.parentId ? room.engine.seat(agent.parentId) : undefined;
  // a seat may create only what the workflow's spawn table gives its role
  if (parent && !(seat && maySpawn(parent.role, seat.role, agent.title))) {
    const what = seat ? `a ${seat.role} seat` : `a non-room agent (provider ${agent.provider})`;
    await refuseSpawn(room, agent, parent.agentId, parent.role, what);
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
    version: room.version,
  };
  room.engine.rememberSeat(record);
  void room.safety
    .started(agent.id, agent.cwd)
    .catch((error) => console.error("seatwork: the guard did not note where a seat starts", error));
  if (parent && room.policy.mail.gatherReviews && reviews(seat.role, agent.title))
    room.gate.launched(parent.agentId, agent.id);
  try {
    appendFileSync(REGISTRY_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch (error) {
    console.error("seatwork: cannot append registry log", error);
  }
}

/** An archived seat: what the room held for it is released, and whoever waited on it is told. */
async function seatArchived(room: RoomContext, gc: Collector, seat: SeatEvent): Promise<void> {
  const { engine } = room;
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
  try {
    const round = room.gate.gone(id);
    const owner = round ? engine.parentOf(id) : null;
    if (round && owner) await engine.release(owner, round);
  } finally {
    // what the room held for the seat goes even when the step before failed
    await gc.onArchived(id);
  }
}

/** A seat waits for a permission: its Owner is asked to answer, where the route up is open. */
async function permissionAsked(room: RoomContext, agent: SeatEvent, request: unknown): Promise<void> {
  const { engine } = room;
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
}

/** Starts the room on this machine's files: its districts, its MCP server and its timers; `addSeats` sets up seats the room lacks, as the app's own setup does. */
export function startRoom(input: {
  host: Host;
  version: string;
  filesFrom: string | undefined;
  addSeats(providers: string[]): Promise<void>;
}): Room {
  const { host, version, filesFrom } = input;
  // the room home holds mail bodies and copies of the user's harness config: its owner only
  chmodSync(ROOM_HOME, 0o700);
  mkdirSync(ROOM_MAIL, { recursive: true });
  mkdirSync(roomProjectDir(), { recursive: true });
  const policy = loadPolicy();
  const log = (message: string) => console.log(`seatwork: ${message}`);
  buildRuntimes(policy, version);

  const engine = new MailEngine(host, policy.mail, log, {
    rootOf: projectRootOf,
    mailChars: policy.room.params.mailChars,
    quietChars: policy.mail.quietChars,
    dedupeSeconds: policy.mail.dedupeSeconds,
  });
  const jev = new Jev({ dir: JEV_DIR, policy: () => policy.jev, log });
  const forks = new Forks({ router: jev, on: (name) => policy.jev?.forks?.includes(name) === true, log });
  const knowledge = startKnowledge(engine, jev, policy, () => room, log);
  engine.appendix = (agentId) => knowledge.appendix(agentId);
  engine.chooseAsk = chooseAsk(forks);
  const safety = startSafety(engine, jev, policy, log);
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
    jev,
    forks,
    knowledge,
    mailedUp: new Map(),
    lastSignal: new Map(),
    lastUsage: new Map(),
    briefs: new Map(),
    rotateAt: policy.room.params.rotateAtTokens ?? Infinity,
    addSeats: input.addSeats,
  };
  /** An archived seat can never call the room's tools again. */
  const forget = (agentId: string) => {
    room.rounds.forget(agentId);
    room.lastUsage.delete(agentId);
    room.callers.forget(agentId);
    room.briefs.delete(agentId);
    safety.forget(agentId);
    knowledge.forget(agentId);
  };
  const gc = new Collector(host, engine, policy.gc, log, forget, policy.mail.keepDays, policy.mail.expireUnreadDays, [
    { what: "guard records", expire: (before) => safety.expire(before) },
    { what: "decision states", expire: (before) => jev.expire(before) },
    { what: "council readings", expire: () => safety.expireCouncil() },
    { what: "knowledge record", expire: () => knowledge.expire() },
    { what: "task rounds", expire: (before) => room.rounds.expire(before) },
    // a closed issue lives as long as the finished mail about it
    { what: "closed issues", expire: (before) => room.works.expire(before, engine.projects()) },
  ]);
  const served = serve(room, safety, knowledge);
  const timers = startTimers(room, gc);

  return {
    policy,
    filesFrom,
    async launch(request) {
      await served.started;
      // a seat started now would hold an address nothing answers: it is refused, and says why
      const unbound = served.unbound();
      if (unbound)
        throw new Error(
          `seatwork: the room's server could not listen on 127.0.0.1:${served.port()} (${unbound}); no seat starts until the room is started again`,
        );
      const launched = launch(request, policy, log);
      // agent.session_open ties this nonce to the agent id
      const nonce = room.callers.issue();
      // the decisions in force reach every seat at its start, whoever opens it; the nonce names the launch they were shown in
      const decisions = knowledge.promptFor(request.cwd, nonce);
      if (decisions) launched.systemPrompt = `${launched.systemPrompt}\n\n${decisions}`;
      return { ...launched, env: { SEATWORK_NONCE: nonce }, mcpUrl: served.mcp.urlFor(served.port(), nonce) };
    },
    opened(agentId, provider, nonce, created) {
      if (nonce && created) room.callers.bind(nonce, agentId);
      timers.touch();
      const seat = parseSeat(provider);
      if (!seat) return null;
      // the seat holds the decisions its launch's prompt showed
      knowledge.opened(agentId, nonce ?? null);
      // the app saves no env with an agent: a reopened seat would start on the user's own home
      ensureRuntime(seat, policy);
      // a temporary directory per seat: one seat's cleanup cannot take another seat's files
      const tmp = join(SEAT_TMP_DIR, agentId.slice(0, 8));
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      return {
        ...envFor(seat, policy),
        TMPDIR: tmp,
        ...safety.env(agentId, served.mcp.routeUrl(served.port(), "gate")),
      };
    },
    created(agent) {
      timers.touch();
      return seatCreated(room, agent);
    },
    turnStarted(seat) {
      timers.touch();
      room.owed.clear(seat.id);
      room.gate.turnStarted(seat.id);
      safety.council.turnStarted(seat.id, seat.cwd);
      knowledge.turnStarted(seat.id);
    },
    turnEnded: (end) => turnEnded(room, end),
    archived: (seat) => seatArchived(room, gc, seat),
    closed(agentId) {
      room.mailedUp.delete(agentId);
      engine.takeWake(agentId);
      knowledge.turnLost(agentId);
    },
    permissionAsked: (agent, request) => permissionAsked(room, agent, request),
    permissionAnswered(agentId) {
      engine.settlePermission(agentId);
    },
    async olderSeats() {
      return [...(await host.live()).values()]
        .filter((seat) => parseSeat(seat.provider) && engine.seat(seat.id)?.version !== version)
        .map((seat) => seat.title ?? seat.id);
    },
    async waiting() {
      timers.touch();
      return { chime: policy.owner.chime, waiting: await room.owed.current(() => host.live()) };
    },
    status: async () => roomStatus(await host.live(), engine, room.owed),
    async stop() {
      timers.stop();
      room.works.close();
      engine.close();
      safety.close();
      jev.close();
      knowledge.close();
      // a mail server still binding would stay open behind a close that came first
      await served.started;
      await served.mcp.close();
    },
  };
}
