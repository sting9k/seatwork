import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Lifecycle } from "./server/paseo/lifecycle";
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

const VERSION = "1.4.0";

/** Seatwork on Paseo: the setup screen first; the room once it is set up, hooked to Paseo's events only while it runs. */
export default function contribute(server: PluginServerContext) {
  server.registerSettings(roomSettings);
  const life = new Lifecycle(server, VERSION);
  const offCreate = server.before("agent.create", ({ request }, { paseo }) => life.seatCreated(paseo, request));

  server.handle(roomWaiting, async (_input, { paseo }) => {
    const room = await life.current(paseo);
    return room ? room.waiting() : { chime: false, waiting: [], seats: [] };
  });
  server.handle(roomDecisions, async ({ folder, earlier }, { paseo }) => {
    const room = await life.current(paseo);
    return room ? room.decisions(folder, earlier) : { project: null, inForce: [], pending: [], earlier: 0, closed: [] };
  });
  server.handle(roomStatus, async (_input, { paseo }) => {
    const room = life.use(paseo);
    return room ? room.status() : { waiting: [], projects: [] };
  });
  server.handle(roomClean, (_input, { paseo }) => life.clean(paseo));
  server.handle(jevState, async (_input, { paseo }) => (await life.running(paseo)).jev());
  server.handle(jevKey, async ({ key }, { paseo }) => (await life.running(paseo)).jevKey(key));
  server.handle(jevPlaces, async (_input, { paseo }) => (await life.running(paseo)).jevPlaces());
  server.handle(jevPlaceSet, async ({ id, on }, { paseo }) => (await life.running(paseo)).jevPlace(id, on));
  server.handle(jevTry, async (_input, { paseo }) => (await life.running(paseo)).jevCheck());
  server.handle(setupState, (_input, { paseo }) => life.state(paseo));
  server.handle(setupInit, (choices, { paseo }) => life.init(paseo, choices));
  server.handle(setupRemove, (_input, { paseo }) => life.remove(paseo));
  server.handle(setupProject, ({ name, models }, { paseo }) => life.project(paseo, name, models));

  return async () => {
    offCreate();
    await life.close();
  };
}
