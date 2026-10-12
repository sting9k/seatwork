import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSeat } from "../seats";
import { planRoom, type Catalog, type RoomPlan, type Setup } from "./plan";
import { readSetup, writeRoomHome } from "./room-home";

export interface RoomSource {
  pluginDir: string;
  roomHome: string;
  catalog: Catalog;
  version: string;
}

/** Sets the room up in a room home for these choices, or again after they changed. Paseo is told separately. */
export async function setUpRoom(
  source: RoomSource,
  setup: Setup,
  options: { seatsOnly?: boolean } = {},
): Promise<RoomPlan> {
  const plan = await planRoom({ ...source, setup });
  writeRoomHome({ ...source, plan, setup, seatsOnly: options.seatsOnly });
  return plan;
}

/** The plugin folder a room home was last set up from. */
export function sourceOf(roomHome: string): string | null {
  const file = join(roomHome, "seats.json");
  if (!existsSync(file)) return null;
  const { source } = JSON.parse(readFileSync(file, "utf8")) as { source?: string };
  return source && existsSync(join(source, "room", "models.json")) ? source : null;
}

/** Adds seats to a room that is set up; they are kept in setup.json, so every later setup keeps them. */
export async function addSeats(source: RoomSource, providers: string[]): Promise<RoomPlan> {
  for (const provider of providers)
    if (!parseSeat(provider)) throw new Error(`"${provider}" is not a seat: a seat is <harness>-<role>`);
  const setup = readSetup(source.roomHome);
  const seats = [...new Set([...(setup.seats ?? []), ...providers])];
  return setUpRoom(source, { ...setup, seats }, { seatsOnly: true });
}
