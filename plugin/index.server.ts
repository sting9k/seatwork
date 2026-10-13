import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "./server/paseo";
import { z } from "zod";
import { paseoCli } from "./server/cli";
import { collectFiles, Collector, KEEP_LOG_DAYS, liveAgents, type LiveAgent } from "./server/gc";
import { MailEngine, waitsOnSomeone, type Mail, type Priority, type Needs, type SeatRecord } from "./server/mail";
import { checkHqPlacement, ensureHqProject, hqDir, removeHqProject } from "./server/orchestration/hq";
import { McpHttpServer } from "./server/mcp-http";
import { HQ_PROJECT, PASEO_HOME, REGISTRY_LOG, ROOM_HOME, SEAT_TMP_DIR, WATCH_DIR } from "./server/paths";
import {
  describeProjects,
  projectTables,
  registerProject,
  unregisterProject,
  writeProjectModels,
} from "./server/orchestration/onboard";
import { OwedList, roomStatus as readRoomStatus } from "./server/room-status";
import { fitSeat, loadModels, projectModels, type Models } from "./server/orchestration/models";
import { loadPolicy, type RuntimePolicy } from "./server/policy";
import { findProject, findRoomMarker, lawSkills, loadRegistry, projectBlock } from "./server/orchestration/registry";
import { Recovery, resumeDue, retryNote } from "./server/orchestration/recovery";
import { isReviewer, ReviewGate } from "./server/orchestration/review-gate";
import {
  briefInForce,
  handoffRequest,
  nextTitle,
  parseHandoff,
  successorPrompt,
  type Handoff,
} from "./server/orchestration/rotation";
import { FRESH_EYES, ownerNote, Rounds } from "./server/orchestration/rounds";
import { describeSeats, type SeatRow } from "./server/orchestration/seats-view";
import { namesCaller, roomTool } from "./server/room-tools";
import {
  claudeRoleDir,
  describeIsolation,
  ensureRuntime,
  envFor,
  roleSkillNames,
  sharedClaudeFiles,
} from "./server/orchestration/runtimes";
import {
  enabledSeats,
  HARNESSES,
  maySpawn,
  parseSeat,
  rolePrompt,
  specFromTitle,
  type Role,
} from "./server/orchestration/seats";
import { catalogFrom, harnessStates } from "./server/orchestration/setup/catalog";
import { piProblem } from "./server/orchestration/setup/checks";
import { addSeats, setUpRoom, sourceOf } from "./server/orchestration/setup/init";
import {
  applyWithSdk,
  readSwitches,
  removeWithSdk,
  turnBundledSkillsOff,
} from "./server/orchestration/setup/paseo-config";
import { clearOldRoom } from "./server/orchestration/setup/old-room";
import { roomModels, type Setup } from "./server/orchestration/setup/plan";
import { keptAt, roomFolders, takeRoomFiles, type ProjectFiles } from "./server/orchestration/setup/project-files";
import { isSetUp, KEEP_REMOVED_DAYS, moveRoomHomeAside, readSetup } from "./server/orchestration/setup/room-home";
import { CLOSES_WORK, SUBJECT_SIGNALS, asksOwner, signalOf, subjectOpening, subjectSignal } from "./server/signals";
import { noteUsage, roomStats, type SeatUsage } from "./server/stats";
import { Budget } from "./server/watch/budget";
import { calibrate, renderCalibration, type MailLine } from "./server/watch/calibrate";
import { prompts } from "./server/watch/events";
import { snapshot } from "./server/watch/git";
import { JevEngine } from "./server/watch/jev";
import { REVISION } from "./server/watch/questions";
import { ScanLog } from "./server/watch/scanlog";
import { usageReport } from "./server/watch/usage";
import { merge } from "./shared/model-choices";
import { roomStatus, roomWaiting } from "./shared/room";
import { roomSettings, setupInit, setupProject, setupRemove, setupState, setupWatcherKey } from "./shared/setup";
import { Watcher, type SeatView, type TimelineView } from "./server/watch/watcher";

type CreateRequest = PluginBeforeRequests["agent.create"];

const VERSION = "0.23.0";
const PLUGIN_ID = "seatwork";
const MAIL_DIR = join(ROOM_HOME, "mail");
const MCP_TOKEN_FILE = join(MAIL_DIR, "token");
const NONCES_FILE = join(MAIL_DIR, "nonces.json");

/** Seatwork: a daemon that only downloaded the plugin gets the setup screen; the room starts once it is set up. */
export default function contribute(server: PluginServerContext) {
  server.registerSettings(roomSettings);
  let room: Room | null = isSetUp(ROOM_HOME) ? startRoom(server) : null;
  if (!room)
    console.log(`seatwork ${VERSION}: no room is set up on this daemon; its setup screen is Seatwork, in the sidebar`);
  // GC's file sweep also runs when no room is set up
  const sweepFiles = () => {
    try {
      for (const line of collectFiles(ROOM_HOME, PASEO_HOME)) console.log(`seatwork: gc: ${line}`);
    } catch (error) {
      console.error("seatwork: gc: the file sweep failed", error);
    }
  };
  sweepFiles();
  const fileSweep = setInterval(sweepFiles, 6 * 3_600_000);
  /** Setting up, removing and re-keying the room happen one at a time. */
  let busy: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = busy.then(work, work);
    busy = next.catch(() => undefined);
    return next;
  };

  /** Sets the room up for these choices; `daemon` also sets the daemon's own switches. */
  const settle = async (paseo: PaseoApi, setup: Setup, daemon: boolean) => {
    const pluginDir = await ownFolder(paseo);
    const catalog = catalogFrom(await harnessStates(paseo, HARNESSES));
    let removed: string[] = [];
    const source = { pluginDir, roomHome: ROOM_HOME, catalog, version: VERSION };
    const plan = await setUpRoom(source, setup, async (planned) => {
      ({ removed } = await applyWithSdk(paseo, planned, { daemonPolicy: daemon }));
    });
    return { plan, removed, pluginDir };
  };
  const restart = async (paseo: PaseoApi) => {
    await room?.stop();
    // a room that fails to start leaves none: its seats are refused
    room = null;
    room = startRoom(server);
    await ensureHqProject(paseo, (message) => console.log(`seatwork: ${message}`));
  };

  let behind: { why: string; at: number } | null = null;
  /** Why a room on another version's files refuses something new. */
  const whyRefused = () =>
    `the room's files were set up by ${room?.filesFrom ? `version ${room.filesFrom}` : "an earlier version"} of the plugin and this is ${VERSION}${behind ? `; the plugin could not bring them to ${VERSION}: ${behind.why}` : ""}`;
  /** Brings the room's files to this version after an update, on its saved choices. */
  const bringUp = (paseo: PaseoApi, asked: boolean): Promise<void> => {
    if (!room || room.filesFrom === VERSION) return Promise.resolve();
    // a failed try is repeated when the room is asked for, not at each poll
    if (!asked && behind && Date.now() - behind.at < 60_000) return Promise.resolve();
    return oneAtATime(async () => {
      if (!room || room.filesFrom === VERSION) return;
      const from = room.filesFrom ?? "an earlier version";
      try {
        await settle(paseo, readSetup(ROOM_HOME), false);
        await restart(paseo);
        behind = null;
        console.log(`seatwork: the room's files were brought from ${from} to ${VERSION}`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (behind?.why !== why) console.error(`seatwork: the room's files stay at ${from}: ${why}`);
        behind = { why, at: Date.now() };
      }
    });
  };

  // a room seat starts on this version's files or does not start
  const offCreate = server.before("agent.create", async ({ request }, { paseo }) => {
    const provider = request.config.provider;
    if (!parseSeat(provider)) return;
    await bringUp(paseo, true);
    if (!room)
      throw new Error(
        `seatwork: ${provider} is a room seat and no room is set up on this daemon; set it up on the Seatwork screen (in the sidebar)`,
      );
    if (room.filesFrom !== VERSION)
      throw new Error(
        `seatwork: ${provider} refused: ${whyRefused()}. Press Apply on the Seatwork screen (in the sidebar) or run install.sh, then create the seat again`,
      );
    return room.seat(request);
  });

  // what the decision model cost this month, for Paseo's Usage screen
  const watching = room?.policy.watcher;
  if (watching && watching.mode !== "off") {
    server.registerUsageSource({
      id: "seatwork-watcher",
      label: "Room watcher",
      input: z.object({}),
      discover: async (scope) =>
        scope.kind === "global" && room ? [{ key: "decision-model", label: watching.engine.model, input: {} }] : [],
      fetch: async () => (room ? room.usage() : { status: "error", error: "no room is set up on this daemon" }),
    });
  }

  server.handle(roomWaiting, async (_input, { paseo }) => {
    await bringUp(paseo, false);
    return room ? room.waiting(paseo) : { chime: false, waiting: [] };
  });
  server.handle(roomStatus, async (_input, { paseo }) => (room ? room.status(paseo) : { waiting: [], projects: [] }));

  server.handle(setupState, async (_input, { paseo }) => {
    await bringUp(paseo, true);
    const pluginDir = await ownFolder(paseo);
    const setup = isSetUp(ROOM_HOME) ? readSetup(ROOM_HOME) : null;
    const seats = setup ? enabledSeats().map((seat) => seat.provider) : [];
    // the provider list and the checks run side by side
    const [states, checks] = await Promise.all([
      harnessStates(paseo, HARNESSES),
      setupChecks(paseo, pluginDir, setup, seats, room, behind?.why),
    ]);
    const harnesses = states.map((h) => ({
      ...h,
      models: Object.entries(h.models).map(([id, m]) => ({
        id,
        label: m.label,
        thinking: m.thinking,
        defaultThinking: m.defaultThinking ?? "",
      })),
    }));
    return {
      version: VERSION,
      home: ROOM_HOME,
      applied: setup && {
        models: appliedModels(setup),
        watcher: setup.watcher ?? "off",
        chime: setup.chime ?? room?.policy.owner.chime ?? true,
        version: setup.version ?? "",
        seats,
      },
      table: roomModels(pluginDir) as never,
      harnesses,
      watcherKey: room !== null && watchKey(room.policy.watcher.engine) !== undefined,
      projects: (setup ? projectTables() : []) as never,
      // a watcher that is off asks nothing and spends nothing
      spend: room && room.policy.watcher.mode !== "off" ? room.spend() : null,
      checks,
    };
  });

  server.handle(setupInit, (choices, { paseo }) =>
    oneAtATime(async () => {
      const before = readSetup(ROOM_HOME);
      // what the screen does not show stays: seats HQ added for a project's table, this machine's mail port
      const setup: Setup = {
        ...(before.seats?.length ? { seats: before.seats } : {}),
        ...(before.mailPort !== undefined ? { mailPort: before.mailPort } : {}),
        models: choices.models,
        watcher: choices.watcher,
        chime: choices.chime,
      };
      const { plan, removed, pluginDir } = await settle(paseo, setup, true);
      behind = null;
      const notes = [...plan.warnings];
      const old = await clearOldRoom();
      if (old)
        notes.push(
          `A room from before 0.19.0 was on this machine: its folder is kept at ${old} for ${KEEP_REMOVED_DAYS} days.`,
        );
      // the one switch the SDK has no call for: written into config.json, then reloaded
      if ((plan.policy.daemon?.bundledSkills ?? "none") === "none" && turnBundledSkillsOff(PASEO_HOME, pluginDir)) {
        await paseoCli(["daemon", "reload"]).then(
          () =>
            notes.push("Paseo's bundled skills are now kept out of agents (config.json; the old file is beside it)."),
          () =>
            notes.push(
              "Paseo's bundled skills are switched off in config.json; `paseo daemon reload` makes it take effect.",
            ),
        );
      }
      const firstWatch = !watching || watching.mode === "off";
      if (firstWatch && choices.watcher !== "off")
        notes.push("The watcher's spending shows in Paseo's Usage once the plugin is reloaded.");
      await restart(paseo);
      return { seats: Object.keys(plan.providers), removed, notes };
    }),
  );

  server.handle(setupRemove, (_input, { paseo }) =>
    oneAtATime(async () => {
      if (!isSetUp(ROOM_HOME)) throw new Error("no room is set up on this daemon");
      const open = [...(await liveAgents(paseo)).values()].filter((agent) => parseSeat(agent.provider));
      if (open.length)
        throw new Error(
          `${open.length} room seat${open.length === 1 ? " is" : "s are"} still open (${open
            .slice(0, 3)
            .map((agent) => agent.title ?? agent.id)
            .join(", ")}${open.length > 3 ? ", …" : ""}); archive them first`,
        );
      const folders = roomFolders(); // read from the room home, before it moves
      await room?.stop();
      room = null;
      const { removed } = await removeWithSdk(paseo);
      const notes = (await removeHqProject(paseo))
        ? []
        : [
            `The ${HQ_PROJECT} project is still in Paseo's list, empty: the paseo CLI could not delete it. Delete it there.`,
          ];
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
    }),
  );

  server.handle(setupProject, async ({ name, models }, { paseo }) => {
    await bringUp(paseo, true);
    return oneAtATime(async () => {
      if (!room) throw new Error("no room is set up on this daemon");
      if (room.filesFrom !== VERSION) throw new Error(`seatwork: ${whyRefused()}. Press Apply first`);
      const pluginDir = await ownFolder(paseo);
      // a table may put a role on an agent CLI the room has no seat for yet: that seat is set up first
      return writeProjectModels(name, models, async (providers) => {
        const plan = await addSeats(
          {
            pluginDir,
            roomHome: ROOM_HOME,
            catalog: catalogFrom(await harnessStates(paseo, HARNESSES)),
            version: VERSION,
          },
          providers,
        );
        await applyWithSdk(paseo, plan, { daemonPolicy: false });
      });
    });
  });

  server.handle(setupWatcherKey, ({ key }) =>
    oneAtATime(async () => {
      if (!room) throw new Error("set the room up first: the key is kept in its home");
      const file = join(ROOM_HOME, room.policy.watcher.engine.keyFile);
      if (key.trim()) {
        mkdirSync(WATCH_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
        chmodSync(file, 0o600);
      } else rmSync(file, { force: true });
      // the watcher reads its key when it starts
      await room.stop();
      room = startRoom(server);
      return { set: key.trim().length > 0 };
    }),
  );

  return async () => {
    clearInterval(fileSweep);
    offCreate();
    await busy;
    await room?.stop();
  };
}

/** The plugin's own folder, where the room files ship: Paseo lists it under the plugin's id. */
async function ownFolder(paseo: PaseoApi): Promise<string> {
  const { config } = await paseo.config.get();
  const listed = ((config.plugins ?? {}) as Record<string, { path?: unknown }>)[PLUGIN_ID]?.path;
  const found =
    typeof listed === "string" && existsSync(join(listed, "room", "models.json")) ? listed : sourceOf(ROOM_HOME);
  if (!found) throw new Error("seatwork: Paseo's plugin list does not say where this plugin's folder is");
  // mid-update Paseo still lists the folder of the version before
  const shipped = existsSync(join(found, "package.json"))
    ? (JSON.parse(readFileSync(join(found, "package.json"), "utf8")) as { version?: string }).version
    : undefined;
  if (shipped !== VERSION)
    throw new Error(
      `seatwork: the plugin's folder holds version ${shipped} and the plugin running is ${VERSION}; reload the plugin (paseo plugin reload seatwork)`,
    );
  return found;
}

/** The model choices a room was set up with, in the screen's shape (an HQ seat from install.sh included). */
function appliedModels(setup: Setup): Record<string, never> {
  const hq = typeof setup.hq === "object" ? { seats: { hq: { thinking: "default", ...setup.hq } } } : {};
  return merge(hq, setup.models ?? {}) as Record<string, never>;
}

/** What the Owner should know before trusting the room on this machine; `ok: null` is "cannot tell". */
async function setupChecks(
  paseo: PaseoApi,
  pluginDir: string,
  setup: Setup | null,
  seats: string[],
  room: Room | null,
  behind: string | undefined,
): Promise<{ id: string; label: string; ok: boolean | null; detail: string }[]> {
  const { config } = await paseo.config.get();
  const switches = readSwitches(PASEO_HOME, pluginDir);
  const tools = (config.mcp as { enabled?: boolean } | undefined)?.enabled ?? switches.paseoTools;
  const checks = [
    {
      id: "paseo-tools",
      label: "Paseo's tools for agents",
      ok: tools ?? null,
      detail:
        tools === false
          ? "Off: seats cannot create or reach each other. Turn it on in Paseo's settings."
          : "Seats create and reach each other through them.",
    },
  ];
  if (setup && setup.version !== VERSION) {
    checks.push({
      id: "version",
      label: "Room files",
      ok: false,
      detail: `Set up by ${setup.version ? `version ${setup.version}` : "an earlier version"}; Apply brings them to ${VERSION}.${behind ? ` The plugin tried by itself and could not: ${behind}` : ""}`,
    });
  }
  const olderSeats = room ? await room.olderSeats(paseo) : [];
  if (olderSeats.length) {
    const many = olderSeats.length > 1;
    checks.push({
      id: "older-seats",
      label: "Seats from before the update",
      ok: false,
      detail: `${olderSeats.length} open seat${many ? "s" : ""} got ${many ? "their" : "its"} prompt from an earlier version of the plugin and ${many ? "keep" : "keeps"} it: ${olderSeats.slice(0, 5).join(", ")}${olderSeats.length > 5 ? ", …" : ""}. Archive a seat and create it again to have it on ${VERSION}.`,
    });
  }
  if (seats.some((seat) => seat.startsWith("pi-"))) {
    const problem = await piProblem();
    checks.push({
      id: "pi",
      label: "Pi",
      ok: !problem,
      detail: problem ?? "Recent enough to give a Pi seat the room's tools.",
    });
  }
  // until 0.18.0 the plugin's id was slp-seat: both ids installed are two copies running one room
  const ids = Object.keys((config.plugins ?? {}) as object);
  if (ids.includes("slp-seat") && ids.includes(PLUGIN_ID)) {
    checks.push({
      id: "two-copies",
      label: "Two copies of this plugin",
      ok: false,
      detail:
        "slp-seat is this plugin under its old name, still installed beside it. Remove it: paseo plugin remove slp-seat.",
    });
  }
  for (const [id, label, on] of [
    ["dictation", "Dictation", switches.dictation],
    ["voice", "Voice mode", switches.voiceMode],
  ] as const) {
    if (on)
      checks.push({
        id,
        label,
        ok: false,
        detail: "On for every agent on this host; the room keeps it off. Turn it off in Paseo's settings.",
      });
  }
  return checks;
}

/** A room that is set up on this daemon and running in this plugin process. */
interface Room {
  policy: RuntimePolicy;
  /** The plugin version that wrote the room's files: prompts and code are one release. */
  filesFrom: string | undefined;
  /** A room seat's request with its role, project, isolation and mail server laid in. */
  seat(request: CreateRequest): Promise<CreateRequest>;
  /** The titles of open seats that got their prompt from another plugin version. */
  olderSeats(paseo: PaseoApi): Promise<string[]>;
  /** The turns that left something for the Owner; the app asks while it is open. */
  waiting(paseo: PaseoApi): Promise<{ chime: boolean; waiting: Awaited<ReturnType<OwedList["current"]>> }>;
  status(paseo: PaseoApi): ReturnType<typeof readRoomStatus>;
  usage(): ReturnType<typeof usageReport>;
  /** What the watcher's decision model cost this month, against its plan and its cap. */
  spend(): { usd: number; planUsd: number; capUsd: number };
  stop(): Promise<void>;
}

/** The room's hooks into Paseo: a seat gets its prompt, project block and mail server; turn ends become mail. */
function startRoom(server: Pick<PluginServerContext, "on" | "before">): Room {
  // the room home holds mail bodies and copies of the user's harness config: its owner only
  chmodSync(ROOM_HOME, 0o700);
  mkdirSync(MAIL_DIR, { recursive: true });
  mkdirSync(hqDir(), { recursive: true });
  const policy = loadPolicy();
  const filesFrom = readSetup(ROOM_HOME).version;
  /** The hooks this room registered, taken back when it stops. */
  const off: (() => void)[] = [];
  try {
    const seats = enabledSeats();
    for (const seat of seats) ensureRuntime(seat, policy);
    console.log(
      `seatwork ${VERSION}: ${seats.length} seats enabled (${seats.map((s) => s.provider).join(", ")}); runtimes under ${ROOM_HOME}/runtimes`,
    );
    console.log(`seatwork: isolation: ${describeIsolation()}`);
  } catch (error) {
    console.error("seatwork: building runtimes failed; they will be retried per seat", error);
  }

  // ---- mail engine + MCP server (one per daemon, fixed port so URLs survive reloads)
  let engine: MailEngine | null = null;
  /** The Paseo client of the last hook or app call; the room is handed one only there. */
  let client: PaseoApi | null = null;
  const token = loadOrCreateToken();
  const mcp = new McpHttpServer(token, "seatwork", VERSION);
  let port = policy.mail.port;
  const nonces = loadNonces();
  const log = (m: string) => console.log(`seatwork: ${m}`);
  const getEngine = (paseo: PaseoApi) => {
    client = paseo;
    if (!engine) {
      engine = new MailEngine(paseo, policy.mail, policy.room, log);
      // the first Paseo client the room is handed: the HQ project gets its place in Paseo
      void ensureHqProject(paseo, log).catch((error) =>
        console.error("seatwork: the hq-seatwork project could not be opened", error),
      );
    }
    return engine;
  };
  /** Sets up seats the room does not have yet, for a project whose own model table names them. */
  const setUpSeats = async (providers: string[]) => {
    const paseo = client;
    if (!paseo || filesFrom !== VERSION)
      throw new Error(
        "seatwork: the room cannot set a seat up right now; apply the room's setup screen once, then repeat",
      );
    const pluginDir = await ownFolder(paseo);
    const plan = await addSeats(
      { pluginDir, roomHome: ROOM_HOME, catalog: catalogFrom(await harnessStates(paseo, HARNESSES)), version: VERSION },
      providers,
    );
    await applyWithSdk(paseo, plan, { daemonPolicy: false });
  };
  /** seat → the signals it mailed its parent in the turn it is in; read when that turn ends. */
  const mailedUp = new Map<string, Set<string>>();
  /** seat → the signal its last turn ended with. */
  const lastSignal = new Map<string, string>();
  const rounds = new Rounds();
  const gate = new ReviewGate();
  const rotations = new Map<string, { by: string; mailId: string }>();
  const rotateAt = policy.room.params.rotateAtTokens ?? Infinity;
  const lastUsage = new Map<string, SeatUsage>();
  /** What the last turn of a seat nobody above reads by mail left for the Owner to answer. */
  const owed = new OwedList(join(ROOM_HOME, "owed.json"));
  const recovery = new Recovery(join(ROOM_HOME, "recovery.json"), policy.room.recovery);
  let gc: Collector | null = null;
  const getGc = (paseo: Parameters<typeof getEngine>[0]) => {
    if (!gc) gc = new Collector(paseo, getEngine(paseo), policy.gc, log, forgetAgent);
    return gc;
  };
  const budget = new Budget(join(WATCH_DIR, "usage-{month}.json"), policy.watcher.budget);
  const scans = new ScanLog(join(WATCH_DIR, "scans.jsonl"));
  let watcher: Watcher | null = null;
  const getWatcher = (paseo: Parameters<typeof getEngine>[0]) => {
    watcher ??= new Watcher({
      policy: policy.watcher,
      params: policy.room.params,
      engine: new JevEngine({ ...policy.watcher.engine, apiKey: watchKey(policy.watcher.engine) }),
      budget,
      scans,
      timeline: (agentId) => readTimeline(paseo, agentId, policy.watcher.historyEntries),
      snapshot,
      lawSkills: (seat) => {
        const registry = loadRegistry();
        const project = registry ? findProject(registry, seat.cwd) : findRoomMarker(seat.cwd);
        return lawSkills(project?.law ?? null, roleSkillNames(seat.role));
      },
      notify: async (notice) => {
        const mail = await getEngine(paseo).post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: notice.to,
          priority: "action",
          subject: notice.subject,
          body: notice.body,
          needs: "nothing",
          whyNow: "the room noticed something in a seat you launched; its own report does not say it",
          // a notice about a finished turn rides with that turn's report
          ...(notice.withReport ? { quiet: true as const } : {}),
        });
        return mail.id;
      },
      now: Date.now,
      log,
    });
    return watcher;
  };
  /** A seat as the watcher sees it; null for an agent that is not a room seat. */
  const viewOf = (
    paseo: Parameters<typeof getEngine>[0],
    agent: { id: string; provider: string; cwd: string; title: string | null; parentAgentId: string | null },
  ): SeatView | null => {
    const seat = parseSeat(agent.provider);
    if (!seat) return null;
    const parent = getEngine(paseo).parentOf(agent.id) ?? agent.parentAgentId;
    return {
      agentId: agent.id,
      role: seat.role,
      title: agent.title,
      cwd: agent.cwd,
      parent,
      parentRole: (parent && getEngine(paseo).seat(parent)?.role) || null,
    };
  };

  const toolVars = {
    signals: SUBJECT_SIGNALS.join(", "),
    keep_log_days: String(KEEP_LOG_DAYS),
    rotate_k: String(Math.round(rotateAt / 1000)),
  };
  mcp.register(roomTool("seatwork_mail", toolVars), async (args, context) => {
    if (!engine) throw new Error("mail engine not ready (no room seat has been created on this daemon yet)");
    const from = resolveCaller(context.nonce);
    if (!from) throw new Error("seatwork_mail: this session is not a registered room seat (unknown caller)");
    const replyTo = String(args.reply_to ?? "")
      .trim()
      .replace(/^#/, "");
    let to: string;
    let viaReply = false;
    if (replyTo) {
      const ref = engine.lookupMail(replyTo);
      if (!ref) throw new Error(`seatwork_mail: no mail #${replyTo} is known; copy the id from the mail header`);
      if (ref.to !== from)
        throw new Error(`seatwork_mail: mail #${replyTo} was not addressed to you; you can only answer your own mail`);
      if (ref.from === "room")
        throw new Error(`seatwork_mail: #${replyTo} is a notice from the room; nobody waits for an answer`);
      to = ref.from;
      viaReply = true;
    } else {
      const rawTo = String(args.to ?? "")
        .trim()
        .replace(/^(hq|supervisor|lead|peer):/i, "");
      to = /^(owner|parent|human)$/i.test(rawTo) ? (engine.parentOf(from) ?? "") : rawTo;
      if (!to)
        throw new Error(
          `seatwork_mail: ${rawTo === "" ? "give `to` (owner, or a seat you launched) or reply_to" : "you have no parent seat; the Owner reads your final message, no mail is needed"}`,
        );
    }
    const check = engine.canWrite(from, to, viaReply);
    if (!check.ok) throw new Error(`seatwork_mail refused: ${check.reason}`);
    const found = await engine.recipientStatus(to);
    if (found === "gone") throw new Error(`seatwork_mail refused: ${to} is archived or gone; nothing was sent`);
    const sender = engine.seat(from)!;
    const recipient = engine.seat(to)!;
    const subject = String(args.subject ?? "").trim() || "(no subject)";
    const body = String(args.body ?? "");
    const opening = subjectOpening(subject);
    if (!opening)
      throw new Error(
        `seatwork_mail: the subject opens with none of the room's signals (${SUBJECT_SIGNALS.join(", ")}); a change to what a seat must do is a REVISED BRIEF, a fact it should know is an FYI. Nothing was sent.`,
      );
    // a stop order ends running turns: it travels down only
    const stops = opening === "STOP";
    if (stops && !engine.isAncestor(from, to))
      throw new Error(
        "seatwork_mail: STOP goes down, to a seat you launched or one below it; to your Owner, write what must stop and why under BLOCKED or QUESTION. Nothing was sent.",
      );
    const limit = policy.room.params.mailChars;
    if (body.length > limit)
      throw new Error(
        `seatwork_mail: the body is ${body.length} characters and a mail takes ${limit}. Put the long part in a file (.seatwork/reviews/ for a review, .seatwork/plans/ for a plan or a handoff) and send the verdict or the ask, one line per finding, and the file's path. Nothing was sent.`,
      );
    const needs = (["reply", "decision", "nothing"].includes(String(args.needs)) ? args.needs : "nothing") as Needs;
    const suggested = (["blocking", "action", "fyi"].includes(String(args.priority)) ? args.priority : undefined) as
      Priority | undefined;
    const priority = classifyAgentMail({
      senderRole: sender.role,
      recipientRole: recipient.role,
      subject,
      needs,
      suggested,
    });
    const signal = subjectSignal(subject);
    if (signal && engine.parentOf(from) === to) {
      mailedUp.set(from, (mailedUp.get(from) ?? new Set()).add(signal));
      // "my work is finished" is true only once the turn has ended: the report is kept until then
      if (CLOSES_WORK.has(signal)) {
        const kept = engine.keepReport({
          from: { agentId: from, role: sender.role },
          to,
          priority,
          subject,
          body,
          needs: needs === "nothing" ? "reply" : needs,
          whyNow: `the seat ended its turn with ${signal}`,
        });
        return `kept #${kept.id} as your report to owner: it is delivered once, when your turn ends. End your turn with ${signal} on the first line; do not send it again.`;
      }
    }
    // an ACK, or a receipt for a candidate under review, asks nothing of anyone: neither starts a turn
    const waits =
      signal === "ACK" ||
      isReceipt({
        recipientRole: recipient.role,
        subject,
        needs: args.needs,
        fromAbove: engine.isAncestor(from, to),
        recipientEndedWith: lastSignal.get(to),
      });
    const mail = await engine.post({
      from: { agentId: from, role: sender.role },
      to,
      priority: stops ? "blocking" : waits ? "fyi" : priority,
      subject,
      body,
      needs,
      whyNow: stops
        ? "the seat above you stopped this work; the turn you were in was ended to bring you this"
        : whyNowFor(engine.isAncestor(from, to) ? "owner" : sender.role, needs),
      ...(waits ? { quiet: true as const } : {}),
      ...(stops ? { urgent: true as const } : {}),
    });
    if (stops) {
      // every seat at work under the stopped one is stopped with it
      const live = client ? await liveAgents(client) : new Map<string, LiveAgent>();
      const busy = engine
        .allSeats()
        .filter((under) => engine!.isAncestor(to, under.agentId))
        .filter((under) => {
          const now = live.get(under.agentId);
          return now !== undefined && (now.status === "running" || waitsOnSomeone(now));
        });
      for (const under of busy)
        await engine.post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: under.agentId,
          priority: "blocking",
          subject: "STOP: the work above you was stopped",
          body: `The seat above your Owner stopped this work with: "${subject}". Stop where you are: leave the tree as it is, start nothing new, and end your turn with what is finished, what is half-done and where it lies. Your Owner writes next.`,
          needs: "nothing",
          whyNow: "the work you are part of was stopped; the turn you were in was ended to bring you this",
          urgent: true,
        });
      const ended = found === "running" || found === "permission" ? "its running turn was ended" : "it was at rest";
      const also =
        busy.length > 0
          ? ` Ended with it: the turns of ${busy.map((under) => `${under.role} ${under.title ?? under.agentId}`).join("; ")}.`
          : "";
      return `sent #${mail.id} to ${recipient.role} ${to} as a stop order; ${ended} and your text opens its next turn.${also}`;
    }
    const held = engine.held(to).some((m) => m.id === mail.id);
    // the skill allows two rounds of repair: the third is said where the Lead sends it
    let round = "";
    if (sender.role === "lead" && recipient.role === "peer") {
      const before = rounds.rejected(to);
      const count = rounds.answered(to, opening);
      if (count > before && count >= 3)
        round = ` This is rejection ${count} of this Peer's task since its last ACCEPT: a round past the second is your Owner's call (accept-candidate, step 5). Unless the Owner gave you this round, report DECISION_NEEDED with what each round found and what one more costs; the task holds meanwhile.`;
    }
    return `sent #${mail.id} to ${engine.isAncestor(to, from) ? "owner" : `${recipient.role} ${to}`} as ${mail.priority}; ${waits ? "it is read with the recipient's next mail" : held ? "held until the recipient can take it" : "delivered"}. Continue your work; do not wait for a reply unless needs=decision blocks you.${round}`;
  });

  mcp.register(roomTool("seatwork_inbox", toolVars), async (_args, context) => {
    if (!engine) throw new Error("mail engine not ready");
    const me = resolveCaller(context.nonce);
    if (!me) throw new Error("seatwork_inbox: unknown caller");
    const mails = engine.takeHeld(me);
    if (mails.length === 0) return "inbox empty";
    return mails.map((m) => formatForInbox(m)).join("\n\n");
  });

  // the registry is the top seat's; tool descriptions stay neutral because every seat can read them
  const registryOwner = (nonce: string, tool: string): PaseoApi => {
    const me = resolveCaller(nonce);
    if (!me || !client || !namesCaller(tool, engine?.seat(me)?.role))
      throw new Error(`${tool} refused: your seat does not keep the project registry`);
    return client;
  };

  mcp.register(roomTool("seatwork_projects", toolVars), async (_args, context) => {
    return describeProjects(registryOwner(context.nonce, "seatwork_projects"));
  });

  mcp.register(roomTool("seatwork_register_project", toolVars), async (args, context) => {
    return registerProject(
      registryOwner(context.nonce, "seatwork_register_project"),
      {
        path: String(args.path ?? ""),
        name: args.name ? String(args.name) : undefined,
        mission: args.mission ? String(args.mission) : undefined,
        models: args.models ?? undefined,
      },
      setUpSeats,
    );
  });

  mcp.register(roomTool("seatwork_unregister_project", toolVars), async (args, context) => {
    const paseo = registryOwner(context.nonce, "seatwork_unregister_project");
    return unregisterProject(String(args.project ?? ""), async () =>
      [...(await liveAgents(paseo)).values()]
        .filter((agent) => parseSeat(agent.provider) && agent.cwd)
        .map((agent) => ({ title: agent.title ?? agent.id, cwd: agent.cwd as string })),
    );
  });

  mcp.register(roomTool("seatwork_room_stats", toolVars), async (args, context) => {
    registryOwner(context.nonce, "seatwork_room_stats");
    return roomStats(Number(args.days) > 0 ? Number(args.days) : KEEP_LOG_DAYS);
  });

  mcp.register(roomTool("seatwork_watch_stats", toolVars), async (_args, context) => {
    registryOwner(context.nonce, "seatwork_watch_stats");
    const spend = budget.summary();
    const mailLog = join(MAIL_DIR, "log.jsonl");
    const mail = existsSync(mailLog)
      ? readFileSync(mailLog, "utf8")
          .split("\n")
          .flatMap((line) => {
            try {
              return line.trim() ? [JSON.parse(line) as MailLine] : [];
            } catch {
              return [];
            }
          })
      : [];
    const lines = [
      `watcher mode ${policy.watcher.mode}; ${spend.month}: ${spend.total.calls} calls, ${spend.total.tokens} tokens, $${spend.total.usd.toFixed(4)} of a $${spend.planUsd} plan (cap $${spend.capUsd}); today $${spend.today.usd.toFixed(4)}; asking is ${spend.pace}`,
      renderCalibration(
        calibrate(scans.read(), mail, policy.watcher.calibration, Date.now(), REVISION),
        policy.watcher.calibration,
      ),
    ];
    return lines.join("\n");
  });

  mcp.register(roomTool("seatwork_seats", toolVars), async (_args, context) => {
    if (!engine || !client) throw new Error("seatwork_seats: the room is not ready (no seat was created yet)");
    const me = resolveCaller(context.nonce);
    if (!me) throw new Error("seatwork_seats: unknown caller");
    const eng = engine;
    const live = await liveAgents(client);
    const open = eng.allSeats().filter((seat) => live.has(seat.agentId));
    const rows: SeatRow[] = [];
    // each seat under its Owner, the Owner first
    const under = (owner: string, depth: number) => {
      for (const seat of open) {
        if (eng.parentOf(seat.agentId) !== owner || depth > 16) continue;
        const now = live.get(seat.agentId) as LiveAgent & {
          lastUsage?: SeatUsage;
          lastError?: string;
          activeTurn?: { startedAt: string | null } | null;
        };
        const usage = now.lastUsage ?? lastUsage.get(seat.agentId);
        const retry = recovery.pending(seat.agentId);
        rows.push({
          agentId: seat.agentId,
          role: seat.role,
          title: seat.title,
          depth,
          status: now.status,
          waiting: waitsOnSomeone(now),
          updatedAt: now.updatedAt ?? null,
          turnStartedAt: now.activeTurn?.startedAt ?? null,
          heldMail: eng.held(seat.agentId).length,
          retry: retry ? retryNote(retry) : null,
          error: now.status === "error" ? (now.lastError ?? "").slice(0, 160) || null : null,
          contextTokens: usage?.contextWindowUsedTokens ?? null,
          costUsd: usage?.totalCostUsd ?? null,
          lastSignal: lastSignal.get(seat.agentId) ?? null,
          rejected: rounds.rejected(seat.agentId),
        });
        under(seat.agentId, depth + 1);
      }
    };
    under(me, 0);
    return describeSeats(rows, rotateAt, Date.now());
  });

  mcp.register(roomTool("seatwork_rotate", toolVars), async (args, context) => {
    if (!engine) throw new Error("seatwork_rotate: the room is not ready (no seat was created yet)");
    const me = resolveCaller(context.nonce);
    if (!me) throw new Error("seatwork_rotate: unknown caller");
    const target = String(args.agent_id ?? "")
      .trim()
      .replace(/^(hq|supervisor|lead|peer|lens):/i, "");
    const seat = engine.seat(target);
    if (!seat)
      throw new Error("seatwork_rotate: give agent_id, the id of a seat under you (seatwork_seats lists them)");
    if (!engine.isAncestor(me, target)) throw new Error("seatwork_rotate refused: you replace only a seat under you");
    const status = await engine.recipientStatus(target);
    if (status === "gone") throw new Error(`seatwork_rotate refused: ${target} is archived or gone`);
    if (rotations.has(target))
      return `${seat.role} ${target} was already asked for its handoff; the notice comes when it answers.`;
    const asked = await engine.post({
      from: { agentId: "room", role: "system" },
      fromLabel: "room",
      to: target,
      priority: "action",
      subject: "HANDOFF: write your handoff; a fresh seat continues your work",
      body: handoffRequest(String(args.why ?? "").trim()),
      needs: "reply",
      whyNow: "the seat above you is replacing this seat with a fresh one, for the size of its context",
    });
    rotations.set(target, { by: me, mailId: asked.id });
    return `asked ${seat.role} ${target} for its handoff${status === "running" ? "; it reads the request when its turn ends" : ""}. When it answers, the room starts its successor, hands its open seats over and archives it. You get one notice with the new seat's id.`;
  });

  mcp.register(roomTool("seatwork_adopt", toolVars), async (args, context) => {
    if (!engine) throw new Error("mail engine not ready");
    const me = resolveCaller(context.nonce);
    if (!me) throw new Error("seatwork_adopt: unknown caller");
    const child = String(args.agent_id ?? "")
      .trim()
      .replace(/^(hq|supervisor|lead|peer|lens):/i, "");
    if (!child) throw new Error("seatwork_adopt: give agent_id");
    const result = await engine.adopt(me, child);
    if (!result.ok) throw new Error(`seatwork_adopt refused: ${result.reason}`);
    const seat = engine.seat(child)!;
    if (result.previous !== me) {
      await engine.post({
        from: { agentId: "room", role: "system" },
        fromLabel: "room",
        to: child,
        priority: "fyi",
        subject: "OWNER CHANGED: you were handed over",
        body: "Your Owner seat changed. Mail addressed `to: owner`, your final messages and your permission requests now reach the new Owner; answer its mail with reply_to as usual. Your brief stands until the new Owner writes; continue your current work.",
        needs: "nothing",
        whyNow: "a handoff moved you under a new Owner",
      });
    }
    return `adopted ${seat.role} ${child} (${seat.title ?? ""}); it now reports to you. Mail it its brief and your disposition of its last signal.`;
  });

  const starting = mcp
    .listen(port)
    .then((bound) => {
      port = bound;
      log(`mail MCP server on 127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error(`seatwork: mail MCP server failed to listen on ${port}; seatwork_mail unavailable`, error);
    });

  /** Starts the successor of a seat on its brief and handoff, moves what was the seat's to it, archives the seat. */
  const rotate = async (paseo: PaseoApi, old: SeatRecord, handoff: Handoff): Promise<{ id: string; file: string }> => {
    const eng = getEngine(paseo);
    const handle = paseo.agents.ref(old.agentId);
    await handle.refresh();
    const now = handle.current();
    if (!now) throw new Error("the daemon no longer has the seat");
    const view = await readTimeline(paseo, old.agentId, 4000);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const dir = join(now.cwd, ".seatwork", "handoffs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${stamp}_${old.agentId.slice(0, 8)}.md`);
    writeFileSync(file, `# Handoff of ${old.title ?? old.agentId}\n\n${handoff.text}\n`);
    const owner = eng.parentOf(old.agentId);
    const thinking = now.thinkingOptionId ?? now.effectiveThinkingOptionId;
    const title = nextTitle(old.title);
    const successor = await paseo.agents.create({
      config: {
        provider: now.model ? `${now.provider}/${now.model}` : now.provider,
        ...(now.currentModeId ? { modeId: now.currentModeId } : {}),
        ...(thinking ? { thinkingOptionId: thinking } : {}),
      },
      cwd: now.cwd,
      ...(owner ? { parent: owner } : {}),
      title,
      prompt: successorPrompt({
        brief: view ? briefInForce(prompts(view.entries), now.cwd) : null,
        handoff: handoff.text,
        file,
      }),
    });
    // the successor must be a seat of the room before anything is handed to it
    eng.rememberSeat({ ...old, agentId: successor.id, parentAgentId: owner, title, version: VERSION });
    for (const child of eng.allSeats().filter((seat) => eng.parentOf(seat.agentId) === old.agentId)) {
      const adopted = await eng.adopt(successor.id, child.agentId);
      if (!adopted.ok) continue;
      await eng.post({
        from: { agentId: "room", role: "system" },
        fromLabel: "room",
        to: child.agentId,
        priority: "fyi",
        subject: "OWNER CHANGED: your Owner continues in a fresh seat",
        body: "Your Owner was replaced by a fresh seat that holds its brief and its handoff. Mail addressed `to: owner`, your final messages and your permission requests reach the new seat; your brief stands. Continue your work.",
        needs: "nothing",
        whyNow: "the seat that launched you was rotated out",
      });
    }
    for (const mail of eng.takeHeld(old.agentId)) await eng.post({ ...mail, to: successor.id });
    rounds.move(old.agentId, successor.id);
    await handle.archive();
    return { id: successor.id, file };
  };

  // ---- hooks
  // session_open is the first hook that knows the agent id: the nonce from agent.create is tied to it here
  off.push(
    server.before("agent.session_open", ({ request }) => {
      const nonce = request.env?.SEATWORK_NONCE;
      if (nonce && request.reason === "create" && nonces[nonce] !== request.agentId) {
        nonces[nonce] = request.agentId;
        saveNonces(nonces);
      }
      const seat = parseSeat(request.provider);
      if (!seat) return request;
      // Paseo saves no env with an agent: a reopened seat would start on the user's own home
      ensureRuntime(seat);
      // a temporary directory per seat: one seat's cleanup cannot take another seat's files
      const tmp = join(SEAT_TMP_DIR, request.agentId.slice(0, 8));
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      return { ...request, env: { ...request.env, ...envFor(seat, policy), TMPDIR: tmp } };
    }),
  );

  off.push(
    server.on("agent.created", async (event, { paseo }) => {
      const seat = parseSeat(event.agent.provider);
      // spawn rules: a seat may create only the roles policy.room.spawn allows
      const parentId = event.agent.parentAgentId;
      const parent = parentId ? getEngine(paseo).seat(parentId) : undefined;
      if (parent) {
        const allowed = policy.room.spawn[parent.role] ?? [];
        const childRole = seat?.role;
        if (!childRole || !maySpawn(policy.room.spawn, parent.role, childRole, event.agent.title)) {
          const what = seat ? `a ${seat.role} seat` : `a non-room agent (provider ${event.agent.provider})`;
          log(`spawn refused: ${parent.role} ${parentId} created ${what} ${event.agent.id}; archiving it`);
          // Paseo sends a new agent its first prompt without waiting for this hook: the seat may be at work already
          let outcome =
            "The room archived it. If you gave it a first prompt, that turn may have started before the archive: check what it changed.";
          try {
            await paseo.agents.ref(event.agent.id).archive();
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            log(`spawn refused: could not archive ${event.agent.id}: ${reason}`);
            outcome = `The room could not archive it (${reason}), so it is still there: archive ${event.agent.id} yourself, then check what it changed.`;
          }
          await getEngine(paseo).post({
            from: { agentId: "room", role: "system" },
            fromLabel: "room",
            to: parentId!,
            priority: "blocking",
            subject: `SPAWN REFUSED: a ${parent.role} may create only ${allowed.length ? allowed.join(", ") : "nothing"}`,
            body: `You created ${what} titled "${event.agent.title ?? ""}". ${outcome} Create only the roles your role allows (${allowed.length ? allowed.join(", ") : "none"}), on the room's providers, and continue.`,
            needs: "nothing",
            whyNow: "a seat you created was outside the room's spawn rules",
          });
          return;
        }
      }
      if (!seat) return;
      getEngine(paseo).rememberSeat({
        agentId: event.agent.id,
        parentAgentId: event.agent.parentAgentId,
        role: seat.role,
        provider: seat.provider,
        title: event.agent.title,
        cwd: event.agent.cwd,
        version: VERSION,
      });
      if (parent && policy.mail.gatherReviews && isReviewer(seat.role, event.agent.title))
        gate.launched(parent.agentId, event.agent.id);
      const line = JSON.stringify({
        at: new Date().toISOString(),
        agentId: event.agent.id,
        parentAgentId: event.agent.parentAgentId,
        provider: seat.provider,
        role: seat.role,
        cwd: event.agent.cwd,
        title: event.agent.title,
        version: VERSION,
      });
      try {
        appendFileSync(REGISTRY_LOG, `${line}\n`);
      } catch (error) {
        console.error("seatwork: cannot append registry log", error);
      }
    }),
  );

  // any turn start wakes the engine and the collector: Paseo's client is handed out only inside hooks
  off.push(
    server.on("agent.turn_started", (event, { paseo }) => {
      owed.clear(event.agent.id);
      gate.turnStarted(event.agent.id);
      getGc(paseo);
      const view = viewOf(paseo, event.agent);
      if (view) getWatcher(paseo).turnStarted(view, event.turnId);
    }),
  );

  off.push(
    server.on("agent.archived", async (event, { paseo }) => {
      owed.clear(event.agent.id);
      mailedUp.delete(event.agent.id);
      lastSignal.delete(event.agent.id);
      rounds.forget(event.agent.id);
      lastUsage.delete(event.agent.id);
      recovery.forget(event.agent.id);
      rotations.delete(event.agent.id);
      watcher?.forget(event.agent.id);
      // a reviewer archived before its report holds its round back no longer
      const round = gate.gone(event.agent.id);
      const owner = round ? getEngine(paseo).parentOf(event.agent.id) : null;
      if (round && owner) await getEngine(paseo).release(owner, round);
      await getGc(paseo).onArchived(event.agent.id);
    }),
  );

  // a runtime that closes takes its turn with it and Paseo sends no end: what the room kept for the turn goes
  off.push(
    server.on("agent.closed", (event) => {
      watcher?.cut(event.agent.id);
      mailedUp.delete(event.agent.id);
      engine?.takeWake(event.agent.id);
    }),
  );

  off.push(
    server.on("agent.turn_ended", async (event, { paseo }) => {
      const eng = getEngine(paseo);
      const id = event.agent.id;
      const seat = parseSeat(event.agent.provider);
      const usage = seat ? await noteUsage(paseo, event.agent, seat.role).catch(() => null) : null;
      if (usage) lastUsage.set(id, usage);
      // what started this turn and what the seat mailed during it; read before the next delivery
      const wake = eng.takeWake(id);
      let kept = eng.takeReport(id);
      const mailed = mailedUp.get(id) ?? new Set<string>();
      mailedUp.delete(id);
      const parentId = eng.parentOf(id) ?? event.agent.parentAgentId;
      const parent = parentId ? eng.seat(parentId) : undefined;
      // nothing travels up to hq: it reads the Supervisor's final message and status.md when it looks
      const reportsTo = seat && parentId && parent && parent.role !== "hq" ? parentId : null;
      const canceled = event.outcome.kind === "canceled";
      // a failed turn is the room's to mend first: a quota is waited out, a service error tried again
      const failure =
        seat && event.outcome.kind === "failed" ? recovery.failed(id, event.outcome.error.message, Date.now()) : null;
      const retried = failure !== null && "retry" in failure;
      if (retried) log(`turn of ${id} failed (${failure.retry.kind}); the room resumes it, nobody is told`);
      if (seat && event.outcome.kind === "completed") recovery.forget(id);
      // a seat nobody above reads by mail: the Owner reads its final message, and the app is told
      if (seat && !reportsTo && !canceled && !retried) {
        const what = event.outcome.kind === "failed" ? "FAILED" : asksOwner(lastAssistantText(event.timeline));
        if (what)
          owed.set({
            key: `${id}:${Date.now()}`,
            agentId: id,
            title: event.agent.title,
            what,
            at: new Date().toISOString(),
          });
      }
      // the turn's own report; it stays null when the parent has this turn's signal from the seat's own mail
      let report: Parameters<MailEngine["post"]>[0] | null = null;
      if (seat && reportsTo && !canceled) {
        const text = lastAssistantText(event.timeline);
        const signal = signalOf(text);
        const repeats = signal !== undefined && lastSignal.get(id) === signal;
        // a Lead's first report carries its plan; a STATUS after it asks nothing of the seat above
        let progress = signal === "STATUS" && seat.role === "lead" && lastSignal.has(id);
        if (signal) lastSignal.set(id, signal);
        let priority: Priority = "fyi";
        let subject = `${signal ?? "turn ended"}: ${seat.role} ${event.agent.title ?? event.agent.id}`;
        let needs: Needs = "nothing";
        let quiet = signal === "ACK" || progress;
        let send = true;
        if (event.outcome.kind === "failed") {
          priority = "blocking";
          subject = `FAILED: ${event.outcome.error.message.slice(0, 120)}`;
          needs = "decision";
          quiet = progress = false;
          send = !retried;
        } else if (signal ? mailed.has(signal) : kept) {
          // one report per turn
          log(`turn end of ${id} not mailed again: the seat mailed ${signal ?? "its report"} to its parent itself`);
          send = false;
        } else if (signal && signal !== "STATUS" && signal !== "ACK") {
          priority = "action";
          subject = `${signal} from ${seat.role} ${event.agent.title ?? event.agent.id}`;
          needs = ["QUESTION", "BLOCKED", "DECISION_NEEDED", "REOPEN_REQUEST", "DEPENDENCY_REQUEST"].includes(signal)
            ? "decision"
            : "reply";
          // DONE again, in a turn started only by mail that asked nothing: the parent has it already
          if (signal === "DONE" && repeats && askedNothing(wake)) {
            priority = "fyi";
            needs = "nothing";
            quiet = true;
          }
        }
        if (send) {
          report = {
            from: { agentId: id, role: seat.role },
            to: reportsTo,
            priority,
            subject,
            body: text || `(no final message; outcome ${event.outcome.kind})`,
            needs,
            whyNow:
              event.outcome.kind === "failed"
                ? `the seat's turn failed${failure && "gaveUpAfter" in failure && failure.gaveUpAfter > 0 ? `, and again after the room's ${failure.gaveUpAfter} tries` : ""}; its work is stopped`
                : progress
                  ? "progress only: the seat ended its turn with STATUS and asks nothing of you"
                  : quiet
                    ? `nothing new: the seat ended its turn with ${signal === "ACK" ? "an acknowledgement" : "DONE again, after mail that asked nothing"}`
                    : `the seat ended its turn with ${signal ?? "a progress message"}`,
            ...(quiet ? { quiet: true as const } : {}),
            ...(progress ? { progress: true as const } : {}),
          };
        }
      }
      // a writing Peer's candidate goes back to it once, for a pass with fresh eyes, before its Owner reads it
      const handIn = kept ?? report;
      const rereads =
        seat?.role === "peer" &&
        event.outcome.kind === "completed" &&
        policy.room.handin?.freshEyes === true &&
        !!handIn &&
        subjectSignal(handIn.subject) === "CANDIDATE" &&
        rounds.owesFreshEyes(id);
      if (rereads) kept = report = null;
      // under what goes up, the room's own line: the task's round, and a context past the rotation line
      const up = kept ?? report;
      if (seat && up) {
        const candidate = seat.role === "peer" && subjectSignal(up.subject) === "CANDIDATE";
        const note = ownerNote({
          role: seat.role,
          candidate,
          rejected: candidate ? rounds.handedIn(id) : 0,
          contextTokens: usage?.contextWindowUsedTokens ?? null,
          rotateAtTokens: rotateAt,
        });
        if (note) up.body = `${up.body.trimEnd()}\n\n${note}`;
      }
      // a reviewer's report waits for the others of its round: the Owner reads the round in one turn
      if (up && subjectSignal(up.subject) === "REVIEW") {
        const round = gate.reported(id);
        if (round) up.round = round.round;
        if (round && round.awaited > 0) {
          up.heldUntil = new Date(Date.now() + policy.room.params.reviewStallMinutes * 60_000).toISOString();
          up.whyNow = `${up.whyNow}; held for the ${round.awaited} other${round.awaited === 1 ? "" : "s"} of its review round`;
        }
      }
      // the reply to a handoff request: the room starts the successor, or says why it did not
      const rotation = rotations.get(id);
      const record = eng.seat(id);
      if (rotation && record && wake.some((mail) => mail.id === rotation.mailId)) {
        rotations.delete(id);
        const handoff = event.outcome.kind === "completed" ? parseHandoff(lastAssistantText(event.timeline)) : null;
        let problem = "its reply was no handoff (CURRENT TASK and PROGRESS are needed)";
        if (handoff) {
          try {
            const next = await rotate(paseo, record, handoff);
            watcher?.forget(id);
            if (kept && reportsTo) await eng.post({ ...kept, to: reportsTo });
            for (const told of new Set([rotation.by, ...(reportsTo ? [reportsTo] : [])]))
              await eng.post({
                from: { agentId: "room", role: "system" },
                fromLabel: "room",
                to: told,
                priority: "fyi",
                subject: `ROTATED: ${record.role} ${record.title ?? id} continues in a fresh seat`,
                body: `The room started ${nextTitle(record.title)} (${next.id}) on the brief in force and the handoff at ${next.file}. The seats the old one launched report to it now. The old seat ${id} is archived: write to ${next.id} from here on.`,
                needs: "nothing",
                whyNow: "a seat under you was replaced by a fresh one",
                quiet: true,
              });
            // the handoff is the old seat's last word: nothing more goes up from it
            return;
          } catch (error) {
            problem = `its successor could not be started (${error instanceof Error ? error.message : String(error)})`;
          }
        }
        await eng.post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: rotation.by,
          priority: "action",
          subject: `ROTATION FAILED: ${record.role} ${record.title ?? id} stays as it is`,
          body: `The room did not replace this seat: ${problem}. It is as it was. Ask again with seatwork_rotate, or brief a new seat yourself and archive this one.`,
          needs: "nothing",
          whyNow: "the rotation you asked for did not happen",
        });
      }
      // the watcher reads the turn before anything goes up: its notice rides with the report, or goes alone
      const view = canceled ? null : viewOf(paseo, event.agent);
      // what the watcher saw in a hand-in that went back rides with the hand-in that follows
      const carried = rereads || [kept, report].some((mail) => mail && !mail.quiet);
      if (view) await getWatcher(paseo).turnEnded(view, event.turnId, carried);
      else watcher?.forget(id);
      if (rereads)
        await eng.post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: id,
          priority: "action",
          subject: "HAND-IN RETURNED: one pass with fresh eyes, then hand in again",
          body: FRESH_EYES,
          needs: "reply",
          whyNow: "the room returns a first hand-in once before the Owner reads it",
        });
      // the watcher has read the turn: held mail may now start the next one
      await eng.deliver(id);
      if (!reportsTo) return;
      // a newer report takes the place of this seat's progress report that still waits unread
      if (kept || report) eng.dropProgress(id, reportsTo);
      // the report the seat mailed before its turn ended goes out now, however the turn ended
      if (kept) await eng.post({ ...kept, to: reportsTo });
      if (report) await eng.post(report);
    }),
  );

  off.push(
    server.on("agent.permission_requested", async (event, { paseo }) => {
      const eng = getEngine(paseo);
      const seat = parseSeat(event.agent.provider);
      const parentId = eng.parentOf(event.agent.id) ?? event.agent.parentAgentId;
      if (!seat || !parentId || !eng.seat(parentId) || eng.seat(parentId)?.role === "hq") return;
      await eng.post({
        from: { agentId: event.agent.id, role: seat.role },
        to: parentId,
        priority: "blocking",
        subject: `PERMISSION: ${seat.role} ${event.agent.title ?? event.agent.id} is waiting for approval`,
        body: JSON.stringify(event.request).slice(0, 2000),
        needs: "decision",
        whyNow: "the seat is stopped until someone answers with respond_to_permission",
      });
    }),
  );

  // safety net: anything still held gets another delivery attempt every minute
  const sweep = setInterval(() => {
    void engine?.sweep();
    if (engine)
      void resumeDue(recovery, engine, Date.now()).catch((error) =>
        console.error("seatwork: resuming a failed seat did not work", error),
      );
  }, 60_000);
  // garbage collection: idle seats and orphan heartbeats
  const collect = setInterval(
    () => {
      void gc?.run();
    },
    Math.max(1, policy.gc.everyMinutes) * 60_000,
  );
  // the watcher's look at turns that are still running
  const watch = setInterval(
    () => {
      void watcher?.tick();
    },
    Math.max(5, policy.watcher.pollSeconds) * 1000,
  );

  return {
    policy,
    filesFrom,
    async seat(request) {
      await starting;
      return applySeat(request);
    },
    async olderSeats(paseo) {
      const eng = getEngine(paseo);
      return [...(await liveAgents(paseo)).values()]
        .filter((agent) => parseSeat(agent.provider) && eng.seat(agent.id)?.version !== VERSION)
        .map((agent) => agent.title ?? agent.id);
    },
    // after a daemon start the app's question is the first to hand the room a Paseo client: held mail moves
    async waiting(paseo) {
      if (!engine) void getEngine(paseo).sweep();
      getGc(paseo);
      return { chime: policy.owner.chime, waiting: await owed.current(paseo) };
    },
    status: (paseo) => readRoomStatus(paseo, getEngine(paseo), owed),
    usage: () => usageReport(budget.summary()),
    spend: () => (({ total, planUsd, capUsd }) => ({ usd: total.usd, planUsd, capUsd }))(budget.summary()),
    async stop() {
      for (const remove of off) remove();
      clearInterval(sweep);
      clearInterval(collect);
      clearInterval(watch);
      // a mail server still binding would stay open behind a close that came first
      await starting;
      await mcp.close();
    },
  };

  /* ---------- helpers bound to this plugin instance ---------- */

  function applySeat(request: CreateRequest): CreateRequest {
    const seat = parseSeat(request.config.provider);
    if (!seat) return request;
    if (!enabledSeats().some((s) => s.provider === seat.provider)) {
      throw new Error(
        `seatwork: ${seat.provider} is not a seat the room has set up (the room's setup screen gives a role its seats; HQ sets one up when a project's model table names it)`,
      );
    }

    const registry = loadRegistry();
    const cwd = request.config.cwd;
    let project: {
      name: string;
      root: string;
      room: Record<string, unknown>;
      mission: string | null;
      law: string | null;
    } | null = null;

    checkHqPlacement(seat.role, seat.provider, cwd);
    if (registry) {
      if (seat.role !== "hq") {
        const match = findProject(registry, cwd);
        if (!match) {
          const names = registry.projects.map((p) => `${p.name} (${p.cwd})`).join(", ") || "none";
          throw new Error(
            `seatwork: ${seat.provider} refused: ${cwd} is not a registered Seatwork project. Registered: ${names}`,
          );
        }
        project = {
          name: match.entry.name,
          root: match.root,
          room: match.room,
          mission: match.mission,
          law: match.law,
        };
      }
    } else if (seat.role !== "hq") {
      const marker = findRoomMarker(cwd);
      if (marker)
        project = {
          name: marker.root.split("/").pop() ?? marker.root,
          root: marker.root,
          room: marker.room,
          mission: marker.mission,
          law: marker.law,
        };
    }

    // the table in force here: the room's, with the project's own differences laid over it
    const own = project?.room.models !== undefined ? `${project.root}/.seatwork/room.json` : null;
    const models: Models = own
      ? projectModels(
          project!.room.models,
          enabledSeats().map((s) => s.provider),
          `seatwork: ${own}`,
        )
      : loadModels();
    const fit = fitSeat(models, seat.role, seat.provider, request.config.model ?? undefined);
    if (!fit.ok) {
      const table = own ? `project ${project!.name} lists` : "the room's table lists";
      throw new Error(
        `seatwork: ${seat.provider}/${request.config.model ?? "(default model)"} refused: ${table} for ${seat.role} only ${fit.listed.join(", ")} (${own ?? "the Seatwork screen sets it"}). Create the seat again on one of these.`,
      );
    }
    // a seat asked for on a model the table has since replaced starts on the table's
    const onTable: Partial<CreateRequest["config"]> = {};
    if (fit.model) {
      onTable.model = fit.model;
      if (fit.thinking) onTable.thinkingOptionId = fit.thinking === "default" ? undefined : fit.thinking;
      log(
        `${seat.provider}: asked for ${request.config.model ?? "its default model"}, starts on ${fit.model} as the model table says`,
      );
    }

    // without its own home a seat would start on the user's, with the user's MCP servers and plugins
    try {
      ensureRuntime(seat);
    } catch (error) {
      throw new Error(
        `seatwork: ${seat.provider} refused: its runtime could not be built (${error instanceof Error ? error.message : String(error)}). Fix that and create the seat again.`,
      );
    }

    // the room's MCP server; agent.session_open ties this nonce to the agent id
    const nonce = randomBytes(9).toString("base64url");
    const env: Record<string, string> = { ...(request.env ?? {}), SEATWORK_NONCE: nonce };
    const mcpServers = {
      ...(request.config.mcpServers ?? {}),
      seatwork: { type: "http" as const, url: mcp.urlFor(port, nonce), alwaysLoad: true },
    };

    const featureSpec = (request.config.featureValues as { seatworkSpec?: unknown } | undefined)?.seatworkSpec;
    const spec = specFromTitle(request.config.title) ?? (typeof featureSpec === "string" ? featureSpec : undefined);
    const parts = [
      rolePrompt(seat.role, { harness: seat.harness, spec, params: policy.room.params, models }),
      project
        ? projectBlock(project.name, project.root, project.mission, project.law, roleSkillNames(seat.role))
        : null,
      seat.harness === "claude" ? sharedClaudeFiles(policy) : null,
      request.config.systemPrompt,
    ];
    const systemPrompt = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
    // a Claude seat runs on ~/.claude: customizations off by flags, its role's skills as an added directory
    let providerOptions = request.config.providerOptions;
    if (seat.harness === "claude") {
      const current = (providerOptions ?? {}) as {
        additionalDirectories?: unknown;
        extraArgs?: Record<string, string | null>;
      };
      const dirs = Array.isArray(current.additionalDirectories)
        ? current.additionalDirectories.filter((d): d is string => typeof d === "string")
        : [];
      providerOptions = {
        ...current,
        additionalDirectories: [...new Set([...dirs, claudeRoleDir(seat.role)])],
        extraArgs: { ...(current.extraArgs ?? {}), ...policy.launch.claude.extraArgs },
      };
    }
    return {
      ...request,
      env,
      config: {
        ...request.config,
        ...onTable,
        systemPrompt,
        mcpServers,
        ...(providerOptions ? { providerOptions } : {}),
      },
    };
  }

  function resolveCaller(nonce: string): string | null {
    return nonces[nonce] ?? null;
  }

  /** An archived seat can never call seatwork_mail again: drop its nonce. */
  function forgetAgent(agentId: string): void {
    rounds.forget(agentId);
    lastUsage.delete(agentId);
    const stale = Object.keys(nonces).filter((nonce) => nonces[nonce] === agentId);
    if (stale.length === 0) return;
    for (const nonce of stale) delete nonces[nonce];
    saveNonces(nonces);
  }
}

/* ---------- classification ---------- */

/** True when a turn was started by mail and none of it asked the seat for anything. */
function askedNothing(wake: readonly Mail[]): boolean {
  return (
    wake.length > 0 &&
    wake.every((mail) => mail.needs === "nothing" && (mail.priority === "fyi" || mail.from.role === "system"))
  );
}

/** A receipt: HOLD or NOTED from above that needs nothing, to a Peer whose last turn handed its work over. */
function isReceipt(input: {
  recipientRole: Role;
  subject: string;
  needs: unknown;
  fromAbove: boolean;
  recipientEndedWith: string | undefined;
}): boolean {
  if (input.recipientRole !== "peer" || !input.fromAbove || input.needs !== "nothing") return false;
  return (
    /^\W*(?:HOLD|NOTED)\b/.test(input.subject) &&
    input.recipientEndedWith !== undefined &&
    CLOSES_WORK.has(input.recipientEndedWith)
  );
}

function classifyAgentMail(input: {
  senderRole: Role;
  recipientRole: Role;
  subject: string;
  needs: Needs;
  suggested?: Priority;
}): Priority {
  const s = input.subject.toUpperCase();
  // a Lead answering a Peer that is stuck must reach it at once
  if (/\b(ANSWER|REVISED BRIEF|HOLD|REJECT)\b/.test(s) && input.recipientRole === "peer") return "blocking";
  if (/\b(ACCEPT|DEFER)\b/.test(s) && input.recipientRole === "peer") return "action";
  if (/\b(PERMISSION|FAILED|BLOCKED)\b/.test(s)) return "blocking";
  if (input.needs === "decision") return "action";
  if (/\b(QUESTION|CANDIDATE|REVIEW|REOPEN_REQUEST|DEPENDENCY_REQUEST|DECISION_NEEDED|DONE)\b/.test(s)) return "action";
  if (input.suggested) return input.suggested === "blocking" ? "action" : input.suggested; // a seat cannot demand blocking
  return input.needs === "reply" ? "action" : "fyi";
}

function whyNowFor(sender: Role | "owner", needs: Needs): string {
  if (needs === "decision") return `${sender} cannot proceed on this point without your decision`;
  if (needs === "reply")
    return `${sender} is waiting for your answer to continue; it keeps working on other parts meanwhile`;
  return `${sender} is informing you; nothing is waiting on you`;
}

function lastAssistantText(timeline: readonly unknown[]): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i] as Record<string, unknown>;
    const type = String(item.type ?? "");
    const role = String(item.role ?? "assistant");
    if (!/assistant|message|text/i.test(type) || role !== "assistant") continue;
    const text = item.text ?? item.content ?? item.message;
    if (typeof text === "string" && text.trim()) return text.trim();
    if (Array.isArray(text)) {
      const joined = text
        .map((p) =>
          typeof p === "string"
            ? p
            : typeof (p as { text?: unknown })?.text === "string"
              ? (p as { text: string }).text
              : "",
        )
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

function formatForInbox(mail: Mail): string {
  return `#${mail.id} ${mail.priority.toUpperCase()} from ${mail.fromLabel ?? `${mail.from.role}:${mail.from.agentId}`} re: ${mail.subject}\nneeds: ${mail.needs}\n${mail.body.trim()}`;
}

/* ---------- the watcher's view of Paseo ---------- */

/** The key of the watcher's decision model: from the environment, else from its file under the room home. */
function watchKey(engine: { keyEnv: string; keyFile: string }): string | undefined {
  const fromEnv = process.env[engine.keyEnv]?.trim();
  if (fromEnv) return fromEnv;
  const file = join(ROOM_HOME, engine.keyFile);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

/** A seat's recent timeline with tool calls and messages merged, as Paseo projects it. */
async function readTimeline(paseo: PaseoApi, agentId: string, limit: number): Promise<TimelineView | null> {
  try {
    const page = await paseo.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", projection: "projected", limit });
    return {
      entries: page.entries.map((entry) => ({ item: entry.item, timestamp: entry.timestamp, turnId: entry.turnId })),
      pendingPermission: (page.agent?.pendingPermissions?.length ?? 0) > 0,
    };
  } catch {
    return null;
  }
}

/* ---------- small persistence helpers ---------- */

function loadOrCreateToken(): string {
  if (existsSync(MCP_TOKEN_FILE)) {
    const existing = readFileSync(MCP_TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(18).toString("base64url");
  writeFileSync(MCP_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

function loadNonces(): Record<string, string> {
  if (!existsSync(NONCES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(NONCES_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveNonces(nonces: Record<string, string>): void {
  writeFileSync(NONCES_FILE, `${JSON.stringify(nonces, null, 2)}\n`, { mode: 0o600 });
}
