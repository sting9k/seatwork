import { ROOM_ROLE, traits } from "../../shared/workflow";
import type { Host } from "../host";
import { parseSeat } from "./seats";

/** The room's own seat, kept: when none is open, one is started again on the provider set up for it. */

const WAIT_MS = 10 * 60_000;
const START =
  "The room started you because its own seat was gone. You run the room: read seatwork_room do=health and the incidents, and act only on what you measured.";

/** What keeping the seat needs: the app, the provider set up for the room's role, the room's folder, a log. */
export interface OperatorDeps {
  host: Pick<Host, "live" | "create">;
  provider(): string | undefined;
  folder: string;
  log(line: string): void;
}

/** Notes which of the room's own seats are open, and starts one when none is and none was started in the last minutes. */
export async function keepOperator(
  deps: OperatorDeps,
  open: Set<string>,
  starting: { at: number },
): Promise<string | null> {
  if (!ROOM_ROLE) return null;
  const seats = [...(await deps.host.live()).values()].filter((seat) => parseSeat(seat.provider)?.role === ROOM_ROLE);
  open.clear();
  for (const seat of seats) open.add(seat.id);
  // a start may take minutes to show in the app's list: one start, then a wait
  if (seats.length > 0 || Date.now() - starting.at < WAIT_MS) return null;
  const provider = deps.provider();
  if (!provider) return null;
  starting.at = Date.now();
  const id = await deps.host.create({
    key: `operator:${starting.at}`,
    provider,
    cwd: deps.folder,
    title: `[${traits(ROOM_ROLE).label}] the room's operator`,
    prompt: START,
  });
  deps.log(`room: its own seat was gone, ${id} started on ${provider}`);
  return id;
}
