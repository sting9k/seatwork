import catalog from "../../shared/forks.json";
import { inRoom, routeOpen } from "../../shared/workflow";
import type { MailEngine, NewMail, SeatRecord } from "../coordination/engine";
import { clip, meanings, type Forks } from "./forks";

/** A mail that asks its Owner for an answer may go on to the seat that must give it, the Owner copied. */

const SIGNALS: readonly string[] = catalog.forks.escalate.signals;
const CHAIN_MOST = 8;

const WHY = {
  above: "the decision model read this as one you must answer, not only the sender's Owner; the Owner is copied",
  room: "the decision model read this as a fault of the room itself; the Owner is copied",
  person: "the decision model read this as one only a person can decide: bring it to the person",
} as const;

/** What the sender's mail becomes, and what its receipt says of it. */
export interface Rerouted {
  draft: NewMail;
  note: string;
}

/** The seat above a mail's sender that must answer it, among those the workflow lets the sender mail: the mail goes to it with the Owner copied. Null keeps the mail as sent. */
export async function routeUp(
  room: {
    engine: Pick<MailEngine, "seat" | "parentOf" | "folderOf" | "recipientStatus">;
    forks: Pick<Forks, "take">;
  },
  from: string,
  draft: NewMail,
  signal: string | undefined,
): Promise<Rerouted | null> {
  const { engine } = room;
  const sender = engine.seat(from);
  const owner = engine.parentOf(from);
  const to = [draft.to].flat();
  if (!signal || !SIGNALS.includes(signal) || !sender || !owner) return null;
  if (to.length !== 1 || to[0] !== owner || draft.replyTo) return null;
  const above: SeatRecord[] = [];
  for (let id: string | null = owner; id && above.length < CHAIN_MOST; id = engine.parentOf(id)) {
    const seat = engine.seat(id);
    if (!seat) break;
    above.push(seat);
  }
  if (above.length === 0) return null;
  // a route the workflow closes, or a seat in another project, is never opened here
  const folder = engine.folderOf(owner);
  const open = above.filter((seat) => routeOpen(sender.role, seat.role) && engine.folderOf(seat.agentId) === folder);
  const targets = new Map<string, SeatRecord>([["owner", above[0]]]);
  if (above[1] && open.includes(above[1]) && !inRoom(above[1].role)) targets.set("above", above[1]);
  const home = open.find((seat) => inRoom(seat.role));
  if (home) targets.set("room", home);
  targets.set("person", open.at(-1) ?? above[0]);

  const words = meanings("escalate");
  const picked = await room.forks.take(
    "escalate",
    { message: { signal, subject: clip(draft.subject, 200), body: clip(draft.body, 1500) } },
    Object.fromEntries([...targets.keys()].map((label) => [label, words[label]])),
  );
  const target = picked && picked !== "owner" ? targets.get(picked) : undefined;
  if (!picked || !target) return null;
  const why = WHY[picked as keyof typeof WHY];
  const note = `the decision model reads this as ${picked === "person" ? "one only a person can decide" : "one for a seat above your Owner"}`;
  if (target.agentId === owner) return { draft: { ...draft, why: [draft.why, why].filter(Boolean).join("; ") }, note };
  if ((await engine.recipientStatus(target.agentId)) === "gone") return null;
  const copy = [...new Set([owner, ...(draft.cc ?? [])])].filter((seat) => seat !== target.agentId);
  return {
    draft: { ...draft, to: [target.agentId], cc: copy, why: [draft.why, why].filter(Boolean).join("; ") },
    note: `${note}: it went to ${target.role} ${target.agentId} with your Owner copied`,
  };
}
