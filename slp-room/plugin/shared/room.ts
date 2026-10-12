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

/** What the Room screen shows: what waits on the Owner, and the seats that exist, project by project. */
export const roomStatus = defineRpc({
  name: "room.status",
  input: z.object({}),
  output: z.object({
    waiting: z.array(z.object({ key: z.string(), agentId: z.string(), title: z.string().nullable(), what: z.string(), at: z.string(), project: z.string() })),
    /** HQ first, then the registered projects, then any other. A registered project with no seat open has an empty list. */
    projects: z.array(
      z.object({
        name: z.string(),
        /** In tree order; `depth` is the number of seats above it inside the project. */
        seats: z.array(z.object({ agentId: z.string(), role: z.string(), title: z.string().nullable(), status: z.string(), held: z.number(), depth: z.number() })),
      }),
    ),
  }),
});
