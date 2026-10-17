import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { collectFiles } from "./server/gc";
import { projectTables, writeProjectModels } from "./server/orchestration/onboard";
import { enabledSeats, HARNESSES, parseSeat } from "./server/orchestration/seats";
import type { PaseoApi } from "./server/paseo/api";
import { paseoCli } from "./server/paseo/cli";
import { connect, seatRequest } from "./server/paseo/hooks";
import { PaseoHost } from "./server/paseo/host";
import { ensureRoomProject } from "./server/paseo/room-project";
import { catalogFrom, harnessStates } from "./server/paseo/setup/catalog";
import { setupChecks } from "./server/paseo/setup/checks";
import { addSeats, setUpRoom, sourceOf } from "./server/paseo/setup/init";
import { keepSwitches, leaveAtUninstall, takeRoomOut } from "./server/paseo/setup/leave";
import { applyWithSdk, turnBundledSkillsOff } from "./server/paseo/setup/paseo-config";
import { roomModels, type Setup } from "./server/paseo/setup/plan";
import { isSetUp, readSetup } from "./server/paseo/setup/room-home";
import { PASEO_HOME, ROOM_HOME } from "./server/paths";
import { startRoom, type Room } from "./server/room/room";
import { roomClean, roomDecisions, roomStatus, roomWaiting } from "./shared/room";
import {
  jevKey,
  jevPlaceSet,
  jevPlaces,
  jevState,
  jevTry,
  roomSettings,
  setupInit,
  setupProject,
  setupRemove,
  setupState,
} from "./shared/setup";

const VERSION = "0.41.0";
const PLUGIN_ID = "seatwork";

/** Seatwork on Paseo: the setup screen first; the room once it is set up, hooked to Paseo's events only while it runs. */
export default function contribute(server: PluginServerContext) {
  server.registerSettings(roomSettings);
  const host = new PaseoHost();
  const addRoomSeats = async (providers: string[]) => {
    const paseo = host.ready;
    if (!paseo || room?.filesFrom !== VERSION)
      throw new Error(
        "seatwork: the room cannot set a seat up right now; apply the room's setup screen once, then repeat",
      );
    const plan = await addSeats(await sourceFor(paseo), providers);
    await applyWithSdk(paseo, plan, { daemonPolicy: false });
  };
  let unhook = () => {};
  const start = (): Room => {
    const started = startRoom({
      host,
      version: VERSION,
      filesFrom: readSetup(ROOM_HOME).version,
      addSeats: addRoomSeats,
    });
    unhook = connect(server, started, host);
    return started;
  };
  const stop = async () => {
    unhook();
    unhook = () => {};
    await room?.stop();
    room = null;
  };
  let room: Room | null = isSetUp(ROOM_HOME) ? start() : null;
  if (!room)
    console.log(`seatwork ${VERSION}: no room is set up on this daemon; its setup screen is Seatwork, in the sidebar`);
  // the file sweep runs with no room set up too; it trims the seat records only once the daemon says which seats are open
  const sweepFiles = async (): Promise<string[]> => {
    try {
      const open = await host.live().then(
        (seats) => new Set(seats.keys()),
        () => undefined,
      );
      const backups = [{ dir: PASEO_HOME, prefixes: ["config.json.bak-"], spare: 1 }];
      const done = collectFiles(ROOM_HOME, backups, new Date(), open);
      for (const line of done) console.log(`seatwork: gc: ${line}`);
      return done;
    } catch (error) {
      console.error("seatwork: gc: the file sweep failed", error);
      return [`the file sweep failed: ${error instanceof Error ? error.message : String(error)}`];
    }
  };
  void sweepFiles();
  const fileSweep = setInterval(() => void sweepFiles(), 6 * 3_600_000);
  let busy: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = busy.then(work, work);
    busy = next.catch(() => undefined);
    return next;
  };

  /** Where setup reads the room's files from, and the harnesses' live catalogs. */
  const sourceFor = async (paseo: PaseoApi) => ({
    pluginDir: await ownFolder(paseo),
    roomHome: ROOM_HOME,
    catalog: catalogFrom(await harnessStates(paseo, HARNESSES)),
    version: VERSION,
  });
  /** Sets the room up for these choices; `daemon` also sets the daemon's own switches. */
  const settle = async (paseo: PaseoApi, setup: Setup, daemon: boolean) => {
    const source = await sourceFor(paseo);
    let removed: string[] = [];
    const plan = await setUpRoom(source, setup, async (planned) => {
      ({ removed } = await applyWithSdk(paseo, planned, { daemonPolicy: daemon }));
    });
    return { plan, removed, pluginDir: source.pluginDir };
  };
  /** A room on new files or choices; with Paseo's client at hand its own project is opened too. */
  const restart = async (paseo?: PaseoApi) => {
    // a room that fails to start leaves none: its seats are refused
    await stop();
    room = start();
    if (paseo) await ensureRoomProject(paseo, (message) => console.log(`seatwork: ${message}`));
  };

  let behind: { why: string; at: number } | null = null;
  /** The reason a room set up by another version refuses a new seat or project: whose files it holds and why they could not be brought up. */
  const whyRefused = () =>
    `the room's files were set up by ${room?.filesFrom ? `version ${room.filesFrom}` : "an earlier version"} of the plugin and this is ${VERSION}${behind ? `; the plugin could not bring them to ${VERSION}: ${behind.why}` : ""}`;
  /** Brings the room's files to this version after an update, on its saved choices. */
  const bringUp = (paseo: PaseoApi, asked: boolean): Promise<void> => {
    host.use(paseo);
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
        `seatwork: ${provider} refused: ${whyRefused()}. Press Apply on the Seatwork screen (in the sidebar), then create the seat again`,
      );
    return seatRequest(room, request);
  });

  server.handle(roomWaiting, async (_input, { paseo }) => {
    await bringUp(paseo, false);
    return room ? room.waiting() : { chime: false, waiting: [], seats: [] };
  });
  server.handle(roomDecisions, async ({ folder, earlier }, { paseo }) => {
    await bringUp(paseo, false);
    return room ? room.decisions(folder, earlier) : { project: null, inForce: [], pending: [], earlier: 0, closed: [] };
  });
  /** The running room for a screen's question about it, brought up to this version first. */
  const roomFor = async (paseo: PaseoApi): Promise<Room> => {
    await bringUp(paseo, false);
    if (!room) throw new Error("No room is set up on this daemon.");
    return room;
  };
  server.handle(jevState, async (_input, { paseo }) => (await roomFor(paseo)).jev());
  server.handle(jevKey, async ({ key }, { paseo }) => (await roomFor(paseo)).jevKey(key));
  server.handle(jevPlaces, async (_input, { paseo }) => (await roomFor(paseo)).jevPlaces());
  server.handle(jevPlaceSet, async ({ id, on }, { paseo }) => (await roomFor(paseo)).jevPlace(id, on));
  server.handle(jevTry, async (_input, { paseo }) => (await roomFor(paseo)).jevCheck());
  server.handle(roomClean, async (_input, { paseo }) => {
    host.use(paseo);
    const pass = room ? await room.clean() : [];
    const files = await sweepFiles();
    return { lines: [...(pass ?? []).map((line) => line.replace(/^gc: /, "")), ...files], running: pass === null };
  });
  server.handle(roomStatus, async (_input, { paseo }) => {
    host.use(paseo);
    return room ? room.status() : { waiting: [], projects: [] };
  });

  server.handle(setupState, async (_input, { paseo }) => {
    await bringUp(paseo, true);
    const pluginDir = await ownFolder(paseo);
    const setup = isSetUp(ROOM_HOME) ? readSetup(ROOM_HOME) : null;
    const seats = setup ? enabledSeats().map((seat) => seat.provider) : [];
    const [states, checks] = await Promise.all([
      harnessStates(paseo, HARNESSES),
      setupChecks(paseo, {
        pluginDir,
        setup,
        seats,
        version: VERSION,
        olderSeats: room ? await room.olderSeats() : [],
        behind: behind?.why,
        ownSeat: room ? await room.ownSeat() : null,
      }),
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
        models: (setup.models ?? {}) as Record<string, never>,
        chime: setup.chime ?? room?.policy.owner.chime ?? true,
        version: setup.version ?? "",
        seats,
      },
      table: roomModels(pluginDir) as never,
      harnesses,
      projects: (setup ? projectTables() : []) as never,
      checks,
    };
  });

  server.handle(setupInit, (choices, { paseo }) =>
    oneAtATime(async () => {
      host.use(paseo);
      const before = readSetup(ROOM_HOME);
      // what the screen does not show stays: seats added for a project's table, this machine's mail port
      const setup: Setup = {
        ...(before.seats?.length ? { seats: before.seats } : {}),
        ...(before.mailPort !== undefined ? { mailPort: before.mailPort } : {}),
        models: choices.models,
        chime: choices.chime,
      };
      await keepSwitches(paseo, await ownFolder(paseo));
      const { plan, removed, pluginDir } = await settle(paseo, setup, true);
      behind = null;
      const notes = [...plan.warnings];
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
      await restart(paseo);
      return { seats: Object.keys(plan.providers), removed, notes };
    }),
  );

  server.handle(setupRemove, (_input, { paseo }) =>
    oneAtATime(async () => {
      host.use(paseo);
      if (!isSetUp(ROOM_HOME)) throw new Error("no room is set up on this daemon");
      const open = [...(await host.live()).values()].filter((seat) => parseSeat(seat.provider));
      if (open.length)
        throw new Error(
          `${open.length} room seat${open.length === 1 ? " is" : "s are"} still open (${open
            .slice(0, 3)
            .map((seat) => seat.title ?? seat.id)
            .join(", ")}${open.length > 3 ? ", …" : ""}); archive them first`,
        );
      await stop();
      return takeRoomOut(paseo, true);
    }),
  );

  server.handle(setupProject, async ({ name, models }, { paseo }) => {
    await bringUp(paseo, true);
    return oneAtATime(async () => {
      if (!room) throw new Error("no room is set up on this daemon");
      if (room.filesFrom !== VERSION) throw new Error(`seatwork: ${whyRefused()}. Press Apply first`);
      // a table may put a role on an agent CLI the room has no seat for yet: that seat is set up first
      return writeProjectModels(name, models, addRoomSeats);
    });
  });

  /** Paseo stops the plugin to reload, update or disable it too; only a removal first takes the plugin out of its config. */
  const leaveIfRemoved = async () => {
    const paseo = host.ready;
    if (!paseo) return;
    try {
      const { plugins } = (await paseo.config.get()).config as { plugins?: Record<string, unknown> };
      if (!plugins || PLUGIN_ID in plugins) return;
      for (const line of await leaveAtUninstall(paseo)) console.log(`seatwork: ${line}`);
    } catch (error) {
      console.error("seatwork: the room could not leave Paseo as the plugin was removed", error);
    }
  };

  return async () => {
    clearInterval(fileSweep);
    offCreate();
    await busy;
    await stop();
    await leaveIfRemoved();
  };
}

/** The plugin's own folder, where the room files ship: Paseo lists it under the plugin's id. */
async function ownFolder(paseo: PaseoApi): Promise<string> {
  const { config } = await paseo.config.get();
  const listed = ((config.plugins ?? {}) as Record<string, { path?: unknown }>)[PLUGIN_ID]?.path;
  const found =
    typeof listed === "string" && existsSync(join(listed, "room", "models.json")) ? listed : sourceOf(ROOM_HOME);
  if (!found) throw new Error("seatwork: Paseo's plugin list does not say where this plugin's folder is");
  // during an update Paseo may still list the folder of the earlier version
  const shipped = existsSync(join(found, "package.json"))
    ? (JSON.parse(readFileSync(join(found, "package.json"), "utf8")) as { version?: string }).version
    : undefined;
  if (shipped !== VERSION)
    throw new Error(
      `seatwork: the plugin's folder holds version ${shipped} and the plugin running is ${VERSION}; reload the plugin (paseo plugin reload seatwork)`,
    );
  return found;
}
