import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What the open app asks the room: which turns wait on the Owner and whether to chime, and the seats of each project. */

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

export const roomStatus = defineRpc({
  name: "room.status",
  input: z.object({}),
  output: z.object({
    waiting: z.array(
      z.object({
        key: z.string(),
        agentId: z.string(),
        title: z.string().nullable(),
        what: z.string(),
        at: z.string(),
        project: z.string(),
      }),
    ),
    projects: z.array(
      z.object({
        name: z.string(),
        seats: z.array(
          z.object({
            agentId: z.string(),
            role: z.string(),
            title: z.string().nullable(),
            status: z.string(),
            held: z.number(),
            depth: z.number(),
          }),
        ),
      }),
    ),
  }),
});
