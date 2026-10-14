import config from "../../shared/mail.json";
import { note, ROLES, routeOpen } from "../../shared/workflow";
import { seatLabel } from "./envelope";

/** Whom a seat may write to, and which seat a word in `to` names. */

/** A seat the room registered: its parent, role and agent CLI, its title and the folder it works in. */
export interface SeatRecord {
  agentId: string;
  parentAgentId: string | null;
  role: string;
  provider: string;
  title: string | null;
  cwd?: string;
  version?: string;
}

/** The room's seats and who stands above whom, as the mail engine keeps them. */
export interface Directory {
  seat(agentId: string): SeatRecord | undefined;
  allSeats(): SeatRecord[];
  parentOf(agentId: string): string | null;
  isAncestor(ancestor: string, agentId: string): boolean;
}

export type MailErrorCode =
  | "NOT_A_SEAT"
  | "NO_RECIPIENT"
  | "NO_OWNER"
  | "UNKNOWN_RECIPIENT"
  | "AMBIGUOUS_RECIPIENT"
  | "ROUTE_REFUSED"
  | "RECIPIENT_GONE"
  | "UNKNOWN_MAIL"
  | "NOT_YOUR_MAIL"
  | "NO_SIGNAL"
  | "STOP_GOES_DOWN"
  | "TEAM_ASKS_NOTHING"
  | "MISSING_FILE"
  | "KEY_REUSED"
  | "WAKE_LIMIT"
  | "UNKNOWN_WAKE"
  | "INVALID_ARGUMENT"
  | "STORE_UNAVAILABLE";

/** A refusal a seat can act on: what went wrong, and what a right call looks like. */
export class MailError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly fix?: unknown,
  ) {
    super(message);
    this.name = "MailError";
    this.retryable = code === "STORE_UNAVAILABLE";
  }
}

const OWNER = new Set<string>(config.owner);
const TEAM = new Set<string>(config.team);
const ROLE_TAG = new RegExp(`^(?:${ROLES.join("|")}):`, "i");
/** A title without its role tag, lowercased: what two titles are compared by. */
const bare = (title: string | null) =>
  (title ?? "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim()
    .toLowerCase();

/** A word of `to` without a role tag before it. */
const plain = (word: string) => word.trim().replace(ROLE_TAG, "");

/** Whether a word of `to` names the sender's whole team. */
export const namesTeam = (word: string) => TEAM.has(word.trim().toLowerCase());

/** The seats a seat may start a mail to: its Owner, then every seat under it. */
export function reachable(directory: Directory, from: string): SeatRecord[] {
  const owner = directory.parentOf(from);
  const above = owner ? directory.seat(owner) : undefined;
  return [
    ...(above ? [above] : []),
    ...directory.allSeats().filter((seat) => directory.isAncestor(from, seat.agentId)),
  ];
}

/** What a refusal shows of the seats one may write to. */
export function shown(directory: Directory, from: string, seats: readonly SeatRecord[]): string[] {
  const owner = directory.parentOf(from);
  return seats.map((seat) =>
    seat.agentId === owner ? `owner (${seatLabel(seat)})` : `${seat.agentId} (${seatLabel(seat)})`,
  );
}

/** The seat a word names without the list of open seats: `owner` or a whole id; null for the start of an id or a title. */
export function exactSeat(directory: Directory, from: string, word: string): string | null {
  const name = plain(word);
  if (OWNER.has(name.toLowerCase())) {
    const owner = directory.parentOf(from);
    if (!owner)
      throw new MailError("NO_OWNER", "you have no Owner seat: the Owner reads your final message, no mail is needed");
    return owner;
  }
  return directory.seat(name) ? name : null;
}

/** The seat a word names for this sender: `owner`, an id, the start of one, or a title. */
export function resolve(directory: Directory, from: string, word: string, open: (agentId: string) => boolean): string {
  const exact = exactSeat(directory, from, word);
  if (exact) return exact;
  const name = plain(word);
  const near = reachable(directory, from).filter((seat) => open(seat.agentId));
  const lower = name.toLowerCase();
  const matches = near.filter(
    (seat) =>
      (name.length >= 4 && seat.agentId.startsWith(name)) || (lower.length > 0 && bare(seat.title) === bare(name)),
  );
  if (matches.length === 1) return matches[0].agentId;
  const fix = { to: shown(directory, from, matches.length > 1 ? matches : near) };
  if (matches.length > 1)
    throw new MailError("AMBIGUOUS_RECIPIENT", `\`${word}\` names ${matches.length} seats; give more of the id`, fix);
  throw new MailError("UNKNOWN_RECIPIENT", `\`${word}\` names no seat you can write to`, fix);
}

/** Two gates: the workflow's route table, and the tree read over effective parents. */
export function mayWrite(
  directory: Directory,
  from: string,
  to: string,
  viaReply = false,
): { ok: true } | { ok: false; reason: string } {
  const sender = directory.seat(from);
  const recipient = directory.seat(to);
  if (!sender) return { ok: false, reason: `sender ${from} is not a room seat` };
  if (!recipient) return { ok: false, reason: `recipient ${to} is not a room seat (not in the registry log)` };
  if (from === to) return { ok: false, reason: "a seat does not mail itself" };
  if (!routeOpen(sender.role, recipient.role)) {
    if (directory.parentOf(from) === to) return { ok: false, reason: note("upClosed", { role: sender.role }) };
    return { ok: false, reason: `route ${sender.role}>${recipient.role} is off in the room's workflow` };
  }
  if (directory.parentOf(from) === to || directory.parentOf(to) === from) return { ok: true };
  if (directory.isAncestor(from, to)) return { ok: true };
  if (viaReply && directory.isAncestor(to, from)) return { ok: true };
  return {
    ok: false,
    reason: `${sender.role} ${from} may write to its parent, to seats it launched, or down its own chain; ${recipient.role} ${to} is none of these${viaReply ? "" : " (to answer a mail from above, pass reply_to: its id)"}`,
  };
}
