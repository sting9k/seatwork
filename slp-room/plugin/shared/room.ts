import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What the app asks the room while it is open: the turns that left something for the Owner, and whether to chime for a new one. */
export const roomWaiting = defineRpc({
  name: "room.waiting",
  input: z.object({}),
  output: z.object({
    chime: z.boolean(),
    waiting: z.array(
      z.object({
        /** One per turn: a seat that asks again is a new entry. */
        key: z.string(),
        agentId: z.string(),
        title: z.string().nullable(),
        /** DECISION_NEEDED, BLOCKED, WAITING ON YOU or FAILED. */
        what: z.string(),
        at: z.string(),
      }),
    ),
  }),
});

/** What the Room screen shows: what waits on the Owner, the seats as a tree, the latest mail, what the watcher found. */
export const roomStatus = defineRpc({
  name: "room.status",
  input: z.object({}),
  output: z.object({
    waiting: z.array(z.object({ key: z.string(), agentId: z.string(), title: z.string().nullable(), what: z.string(), at: z.string() })),
    /** In tree order; `depth` is the number of seats above. */
    seats: z.array(z.object({ agentId: z.string(), role: z.string(), title: z.string().nullable(), status: z.string(), held: z.number(), depth: z.number() })),
    mail: z.array(z.object({ id: z.string(), at: z.string(), from: z.string(), to: z.string(), subject: z.string(), state: z.string() })),
    findings: z.array(z.object({ at: z.string(), seat: z.string(), rule: z.string(), evidence: z.string(), outcome: z.string() })),
  }),
});
