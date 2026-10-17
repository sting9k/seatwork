import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { collectFiles } from "../gc";
import { projectTables, writeProjectModels } from "../orchestration/onboard";
import { enabledSeats, HARNESSES, parseSeat } from "../orchestration/seats";
import { PASEO_HOME, ROOM_HOME } from "../paths";
import { startRoom, type Room } from "../room/room";
import type { PaseoApi } from "./api";
import { paseoCli } from "./cli";
import { connect, seatRequest } from "./hooks";
import { PaseoHost } from "./host";
import { ensureRoomProject } from "./room-project";
import { catalogFrom, harnessStates } from "./setup/catalog";
import { setupChecks } from "./setup/checks";
import { addSeats, setUpRoom, sourceOf } from "./setup/init";
import { keepSwitches, leaveAtUninstall, takeRoomOut } from "./setup/leave";
import { applyWithSdk, writeFileSwitches } from "./setup/paseo-config";
import { roomModels, type Setup } from "./setup/plan";
import { isSetUp, readSetup } from "./setup/room-home";

/** The room's life on one daemon: started once it is set up and hooked to Paseo's events only while it runs, its files brought to the plugin's version after an update, set up and taken out from the screen, and Paseo left as it was found when the plugin is uninstalled. */

const PLUGIN_ID = "seatwork";
const FILE_SWEEP_MS = 6 * 3_600_000;
const RETRY_BEHIND_MS = 60_000;

type CreateRequest = PluginBeforeRequests["agent.create"];

/** The room on this daemon, from the plugin's start to its stop. */
export class Lifecycle {
  readonly host = new PaseoHost();
  private room: Room | null = null;
  private unhook = () => {};
  private behind: { why: string; at: number } | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private readonly fileSweep: ReturnType<typeof setInterval>;

  constructor(
    private readonly server: PluginServerContext,
    private readonly version: string,
  ) {
    this.room = isSetUp(ROOM_HOME) ? this.start() : null;
    if (!this.room)
      console.log(
        `seatwork ${version}: no room is set up on this daemon; its setup screen is Seatwork, in the sidebar`,
      );
    void this.sweepFiles();
    this.fileSweep = setInterval(() => void this.sweepFiles(), FILE_SWEEP_MS);
  }

  /** The room with Paseo's client at hand, brought to this version first; null when none is set up. */
  async current(paseo: PaseoApi): Promise<Room | null> {
    await this.bringUp(paseo, false);
    return this.room;
  }

  /** The running room for a screen's question about it, brought to this version first. */
  async running(paseo: PaseoApi): Promise<Room> {
    const room = await this.current(paseo);
    if (!room) throw new Error("No room is set up on this daemon.");
    return room;
  }

  /** The room as it stands, with Paseo's client handed to it. */
  use(paseo: PaseoApi): Room | null {
    this.host.use(paseo);
    return this.room;
  }

  /** An agent the app creates: a room seat is set up by the room, which must be set up and on this version; any other agent passes, in the room's mode for its harness where the policy says so. */
  async seatCreated(paseo: PaseoApi, request: CreateRequest): Promise<CreateRequest | undefined> {
    const provider = request.config.provider;
    if (!parseSeat(provider)) {
      const mode = this.room?.ownMode(provider);
      return mode ? { ...request, config: { ...request.config, modeId: mode } } : undefined;
    }
    await this.bringUp(paseo, true);
    if (!this.room)
      throw new Error(
        `seatwork: ${provider} is a room seat and no room is set up on this daemon; set it up on the Seatwork screen (in the sidebar)`,
      );
    if (this.room.filesFrom !== this.version)
      throw new Error(
        `seatwork: ${provider} refused: ${this.whyRefused()}. Press Apply on the Seatwork screen (in the sidebar), then create the seat again`,
      );
    return seatRequest(this.room, request);
  }

  /** The screen's clean-up: the room's own pass, then the file sweep; `running` when a pass was already under way. */
  async clean(paseo: PaseoApi): Promise<{ lines: string[]; running: boolean }> {
    const room = this.use(paseo);
    const pass = room ? await room.clean() : [];
    const files = await this.sweepFiles();
    return { lines: [...(pass ?? []).map((line) => line.replace(/^gc: /, "")), ...files], running: pass === null };
  }

  /** What the setup screen shows: the choices applied, the harnesses and their models, the projects' tables and the checks. */
  async state(paseo: PaseoApi) {
    await this.bringUp(paseo, true);
    const pluginDir = await this.ownFolder(paseo);
    const setup = isSetUp(ROOM_HOME) ? readSetup(ROOM_HOME) : null;
    const seats = setup ? enabledSeats().map((seat) => seat.provider) : [];
    const room = this.room;
    const [states, checks] = await Promise.all([
      harnessStates(paseo, HARNESSES),
      setupChecks(paseo, {
        pluginDir,
        setup,
        seats,
        version: this.version,
        olderSeats: room ? await room.olderSeats() : [],
        behind: this.behind?.why,
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
      version: this.version,
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
  }

  /** Sets the room up on the screen's choices with the daemon's own switches, and starts it on them. */
  init(paseo: PaseoApi, choices: { models: Record<string, unknown>; chime: boolean }) {
    return this.oneAtATime(async () => {
      this.host.use(paseo);
      const before = readSetup(ROOM_HOME);
      // what the screen does not show stays: seats added for a project's table, this machine's mail port
      const setup: Setup = {
        ...(before.seats?.length ? { seats: before.seats } : {}),
        ...(before.mailPort !== undefined ? { mailPort: before.mailPort } : {}),
        models: choices.models,
        chime: choices.chime,
      };
      await keepSwitches(paseo, await this.ownFolder(paseo));
      const { plan, removed, pluginDir } = await this.settle(paseo, setup, true);
      this.behind = null;
      const notes = [...plan.warnings];
      // the switches the SDK has no call for: written into config.json, then reloaded
      const wrote = writeFileSwitches(PASEO_HOME, pluginDir, plan.policy.daemon ?? {});
      if (wrote.changed)
        await paseoCli(["daemon", "reload"]).then(
          () => notes.push("Paseo's config.json has the room's switches now; the old file is beside it."),
          () =>
            notes.push("Paseo's config.json has the room's switches; `paseo daemon reload` makes them take effect."),
        );
      if (wrote.voice) notes.push("Dictation and voice mode are off from the daemon's next restart.");
      await this.restart(paseo);
      return { seats: Object.keys(plan.providers), removed, notes };
    });
  }

  /** Stops the room and takes it out of Paseo, once every room seat is archived. */
  remove(paseo: PaseoApi) {
    return this.oneAtATime(async () => {
      this.host.use(paseo);
      if (!isSetUp(ROOM_HOME)) throw new Error("no room is set up on this daemon");
      const open = [...(await this.host.live()).values()].filter((seat) => parseSeat(seat.provider));
      if (open.length)
        throw new Error(
          `${open.length} room seat${open.length === 1 ? " is" : "s are"} still open (${open
            .slice(0, 3)
            .map((seat) => seat.title ?? seat.id)
            .join(", ")}${open.length > 3 ? ", …" : ""}); archive them first`,
        );
      await this.stop();
      return takeRoomOut(paseo, true);
    });
  }

  /** A project's own table of models; a role put on an agent CLI the room has no seat for sets that seat up first. */
  async project(paseo: PaseoApi, name: string, models: Record<string, unknown> | null) {
    await this.bringUp(paseo, true);
    return this.oneAtATime(async () => {
      if (!this.room) throw new Error("no room is set up on this daemon");
      if (this.room.filesFrom !== this.version) throw new Error(`seatwork: ${this.whyRefused()}. Press Apply first`);
      return writeProjectModels(name, models, (providers) => this.addSeats(providers));
    });
  }

  /** The plugin stops: the sweep ends, work under way finishes, the room stops, and an uninstall leaves Paseo as it was. */
  async close(): Promise<void> {
    clearInterval(this.fileSweep);
    await this.busy;
    await this.stop();
    await this.leaveIfRemoved();
  }

  /** Starts the room on the files set up, hooked to Paseo's events. */
  private start(): Room {
    const started = startRoom({
      host: this.host,
      version: this.version,
      filesFrom: readSetup(ROOM_HOME).version,
      addSeats: (providers) => this.addSeats(providers),
    });
    this.unhook = connect(this.server, started, this.host);
    return started;
  }

  /** Unhooks the room from Paseo's events and stops it. */
  private async stop(): Promise<void> {
    this.unhook();
    this.unhook = () => {};
    await this.room?.stop();
    this.room = null;
  }

  /** A room on new files or choices; with Paseo's client at hand its own project is opened too. A room that fails to start leaves none, and its seats are refused. */
  private async restart(paseo?: PaseoApi): Promise<void> {
    await this.stop();
    this.room = this.start();
    if (paseo) await ensureRoomProject(paseo, (message) => console.log(`seatwork: ${message}`));
  }

  /** Sets up seats for these agent CLIs on the room's files, which must be this version's. */
  private async addSeats(providers: string[]): Promise<void> {
    const paseo = this.host.ready;
    if (!paseo || this.room?.filesFrom !== this.version)
      throw new Error(
        "seatwork: the room cannot set a seat up right now; apply the room's setup screen once, then repeat",
      );
    const plan = await addSeats(await this.sourceFor(paseo), providers);
    await applyWithSdk(paseo, plan, { daemonPolicy: false });
  }

  /** The file sweep, which runs with no room set up too; it trims the seat records only once the daemon says which seats are open. */
  private async sweepFiles(): Promise<string[]> {
    try {
      const open = await this.host.live().then(
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
  }

  /** Runs `work` after the work queued before it, whether that failed or not. */
  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }

  /** Where setup reads the room's files from, and the harnesses' live catalogs. */
  private async sourceFor(paseo: PaseoApi) {
    return {
      pluginDir: await this.ownFolder(paseo),
      roomHome: ROOM_HOME,
      catalog: catalogFrom(await harnessStates(paseo, HARNESSES)),
      version: this.version,
    };
  }

  /** Sets the room up for these choices; `daemon` also sets the daemon's own switches. */
  private async settle(paseo: PaseoApi, setup: Setup, daemon: boolean) {
    const source = await this.sourceFor(paseo);
    let removed: string[] = [];
    const plan = await setUpRoom(source, setup, async (planned) => {
      ({ removed } = await applyWithSdk(paseo, planned, { daemonPolicy: daemon }));
    });
    return { plan, removed, pluginDir: source.pluginDir };
  }

  /** Why a room set up by another version refuses a new seat or project: whose files it holds and why they could not be brought up. */
  private whyRefused(): string {
    const from = this.room?.filesFrom ? `version ${this.room.filesFrom}` : "an earlier version";
    const behind = this.behind ? `; the plugin could not bring them to ${this.version}: ${this.behind.why}` : "";
    return `the room's files were set up by ${from} of the plugin and this is ${this.version}${behind}`;
  }

  /** Brings the room's files to this version after an update, on its saved choices; a failed try is repeated when the room is asked for, not at each poll. */
  private bringUp(paseo: PaseoApi, asked: boolean): Promise<void> {
    this.host.use(paseo);
    if (!this.room || this.room.filesFrom === this.version) return Promise.resolve();
    if (!asked && this.behind && Date.now() - this.behind.at < RETRY_BEHIND_MS) return Promise.resolve();
    return this.oneAtATime(async () => {
      if (!this.room || this.room.filesFrom === this.version) return;
      const from = this.room.filesFrom ?? "an earlier version";
      try {
        await this.settle(paseo, readSetup(ROOM_HOME), false);
        await this.restart(paseo);
        this.behind = null;
        console.log(`seatwork: the room's files were brought from ${from} to ${this.version}`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (this.behind?.why !== why) console.error(`seatwork: the room's files stay at ${from}: ${why}`);
        this.behind = { why, at: Date.now() };
      }
    });
  }

  /** Paseo stops the plugin to reload, update or disable it too; only a removal first takes the plugin out of its config. */
  private async leaveIfRemoved(): Promise<void> {
    const paseo = this.host.ready;
    if (!paseo) return;
    try {
      const { plugins } = (await paseo.config.get()).config as { plugins?: Record<string, unknown> };
      if (!plugins || PLUGIN_ID in plugins) return;
      for (const line of await leaveAtUninstall(paseo)) console.log(`seatwork: ${line}`);
    } catch (error) {
      console.error("seatwork: the room could not leave Paseo as the plugin was removed", error);
    }
  }

  /** The plugin's own folder, where the room files ship: Paseo lists it under the plugin's id. */
  private async ownFolder(paseo: PaseoApi): Promise<string> {
    const { config } = await paseo.config.get();
    const listed = ((config.plugins ?? {}) as Record<string, { path?: unknown }>)[PLUGIN_ID]?.path;
    const found =
      typeof listed === "string" && existsSync(join(listed, "room", "models.json")) ? listed : sourceOf(ROOM_HOME);
    if (!found) throw new Error("seatwork: Paseo's plugin list does not say where this plugin's folder is");
    // during an update Paseo may still list the folder of the earlier version
    const shipped = existsSync(join(found, "package.json"))
      ? (JSON.parse(readFileSync(join(found, "package.json"), "utf8")) as { version?: string }).version
      : undefined;
    if (shipped !== this.version)
      throw new Error(
        `seatwork: the plugin's folder holds version ${shipped} and the plugin running is ${this.version}; reload the plugin (paseo plugin reload seatwork)`,
      );
    return found;
  }
}
