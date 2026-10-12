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
