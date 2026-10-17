import { MailEngine, type EngineOptions, type SeatRecord } from "../../server/coordination/engine";
import type { LiveSeat } from "../../server/host";
import type { RoomContext } from "../../server/room/context";
import { hostOf, MAIL_POLICY } from "./room";

/** The mail tests' stand-ins: the app's handles of seats, the seats the engine keeps, an engine over them, and a room as the mail tools read it. */

export const IDLE = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async () => {} };
export const GONE = { refresh: async () => null, current: () => null };

let cases = 0;

/** Seat ids `<role>-<tag>-<n>` no other case of this process uses: the engines of one file share the room home's store. */
export function namesOf<T extends string>(tag: string, ...roles: T[]): Record<T, string> {
  cases += 1;
  return Object.fromEntries(roles.map((role) => [role, `${role}-${tag}-${cases}`])) as Record<T, string>;
}

/** A seat as the engine keeps it, its provider and title made from its role. */
export function seatRecord(
  agentId: string,
  role: string,
  parentAgentId: string | null = null,
  more: Partial<SeatRecord> = {},
): SeatRecord {
  return { agentId, parentAgentId, role, provider: `claude-${role}`, title: `[${role}] ${agentId}`, ...more };
}

/** An engine over these handles of the app; any other id is a seat the daemon no longer has. */
export function engineOver(
  handles: Record<string, object>,
  options: EngineOptions = {},
  policy: ConstructorParameters<typeof MailEngine>[1] = MAIL_POLICY,
): MailEngine {
  const paseo = { agents: { ref: (id: string) => handles[id] ?? GONE } };
  return new MailEngine(hostOf(paseo), policy, () => {}, options);
}

/** The app's list of open seats: these, each at rest. */
export const openList = (ids: Iterable<string>) => async () =>
  new Map([...ids].map((id) => [id, { id, status: "idle", waiting: false } as LiveSeat]));

/** A room as the mail tools read it: `engine`, the app's list of open seats, and no task, round or decision of its own; `over` sets any part. */
export function mailRoom(engine: MailEngine, over: Record<string, unknown> = {}): RoomContext {
  return {
    engine,
    host: { live: openList([]) },
    mailedUp: new Map(),
    lastSignal: new Map(),
    rounds: { rejected: () => 0, answered: () => 0 },
    works: { existing: () => null },
    taskKeys: { of: (seat: string) => seat },
    forks: { take: async () => "something" },
    ...over,
  } as unknown as RoomContext;
}
