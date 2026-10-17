import { ROOM_ROLE, traits } from "../../shared/workflow";
import type { Host } from "../host";
import { parseSeat } from "./seats";

/** The room's own seat, kept: when none is open, one is started again on the provider set up for it. */

const WAIT_MS = 10 * 60_000;
const START =
  "The room started you because its own seat was gone. You run the room: read seatwork_room do=health and the incidents, and act only on what you measured.";

/** What keeping the seat needs: the app, the provider set up for the room's role, the room's folder, a log. */
interface OperatorDeps {
  host: Pick<Host, "live" | "create">;
  provider(): string | undefined;
  folder: string;
  log(line: string): void;
}

/** What keeping the seat knows: when it last started one, and why that start failed. */
export interface Keeping {
  at: number;
  failed: string | null;
}

/** Notes which of the room's own seats are open, and starts one when none is and none was started in the last minutes (a start can take minutes to show in the app's list). */
export async function keepOperator(deps: OperatorDeps, open: Set<string>, starting: Keeping): Promise<string | null> {
  if (!ROOM_ROLE) return null;
  const seats = [...(await deps.host.live()).values()].filter((seat) => parseSeat(seat.provider)?.role === ROOM_ROLE);
  open.clear();
  for (const seat of seats) open.add(seat.id);
  if (seats.length > 0) starting.failed = null;
  if (seats.length > 0 || Date.now() - starting.at < WAIT_MS) return null;
  const provider = deps.provider();
  if (!provider) return null;
  starting.at = Date.now();
  try {
    const id = await deps.host.create({
      key: `operator:${starting.at}`,
      provider,
      cwd: deps.folder,
      title: `[${traits(ROOM_ROLE).label}] the room's operator`,
      prompt: START,
    });
    starting.failed = null;
    deps.log(`room: its own seat was gone, ${id} started on ${provider}`);
    return id;
  } catch (error) {
    starting.failed = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/** Whether the room's own seat runs, as the person's screen says it: yes, just started (null), or why not. */
export async function operatorState(
  deps: Pick<OperatorDeps, "host" | "provider">,
  starting: Keeping,
): Promise<{ label: string; ok: boolean | null; detail: string } | null> {
  if (!ROOM_ROLE) return null;
  const label = traits(ROOM_ROLE).label || ROOM_ROLE;
  const open = [...(await deps.host.live()).values()].find((seat) => parseSeat(seat.provider)?.role === ROOM_ROLE);
  if (open) return { label, ok: true, detail: `${open.title ?? open.id} runs the room.` };
  if (!deps.provider())
    return { label, ok: false, detail: `No ${label} seat is set up, so nobody runs the room: Apply sets one up.` };
  if (starting.failed)
    return { label, ok: false, detail: `${label} is not running, and the room could not start it: ${starting.failed}` };
  if (Date.now() - starting.at < WAIT_MS)
    return { label, ok: null, detail: `${label} was started again and can take a few minutes to show.` };
  return {
    label,
    ok: false,
    detail: `${label} is not running; the room starts it again within minutes while the app is open.`,
  };
}
