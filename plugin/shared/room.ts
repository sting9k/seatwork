import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** What the open app asks the room: what waits on the Owner and whether to chime, the codes only the person may grant, the room's seats, its decisions, and the seats of each project. */

const personCode = z.object({
  code: z.string(),
  agentId: z.string(),
  title: z.string().nullable(),
  project: z.string().nullable(),
  rule: z.string(),
  reason: z.string(),
  command: z.string(),
  at: z.string(),
  expiresAt: z.string(),
});

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
    codes: z.array(personCode),
    seats: z.array(z.string()),
  }),
});

export const roomGrant = defineRpc({
  name: "room.grant",
  input: z.object({ code: z.string().regex(/^\d{6}$/) }),
  output: z.object({ message: z.string() }),
});

const decision = z.object({
  id: z.number(),
  scope: z.enum(["room", "project"]),
  topic: z.string(),
  statement: z.string(),
  version: z.number(),
  since: z.string(),
  until: z.string().nullable(),
  toldTo: z.string().nullable(),
  state: z.string(),
});

export const roomDecisions = defineRpc({
  name: "room.decisions",
  input: z.object({ folder: z.string().max(4096), earlier: z.boolean().default(false) }),
  output: z.object({
    project: z.string().nullable(),
    inForce: z.array(decision),
    pending: z.array(decision),
    earlier: z.number(),
    closed: z.array(decision),
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
