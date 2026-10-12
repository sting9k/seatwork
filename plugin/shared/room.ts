import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What the app asks the room while open: the turns that wait on the Owner, and whether to chime. */
export const roomWaiting = defineRpc({
  name: "room.waiting",
  input: z.object({}),
  output: z.object({
    chime: z.boolean(),
    waiting: z.array(
      z.object({
        key: z.string(),
        agentId: z.string(),
        title: z.string().nullable(),
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
    projects: z.array(
      z.object({
        name: z.string(),
        seats: z.array(z.object({ agentId: z.string(), role: z.string(), title: z.string().nullable(), status: z.string(), held: z.number(), depth: z.number() })),
      }),
    ),
  }),
});
