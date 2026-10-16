import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** The setup screen's settings and questions to the plugin; model choices are differences from the room's table, in its own shape. */

const modelChoices = z.record(z.string(), z.json());

export const roomSettings = defineSettings({
  id: "room",
  scope: "host",
  version: 1,
  schema: z.object({
    models: modelChoices.default({}),
    chime: z.boolean().default(true),
  }),
});
export type RoomChoices = z.infer<typeof roomSettings.schema>;

const choices = z.object({ models: modelChoices, chime: z.boolean() });

const harness = z.object({
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  why: z.string(),
  models: z.array(
    z.object({ id: z.string(), label: z.string(), thinking: z.array(z.string()), defaultThinking: z.string() }),
  ),
});

const project = z.object({
  name: z.string(),
  root: z.string(),
  own: z.boolean(),
  models: modelChoices,
  error: z.string().nullable(),
});

export const setupState = defineRpc({
  name: "setup.state",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    home: z.string(),
    applied: choices.extend({ version: z.string(), seats: z.array(z.string()) }).nullable(),
    table: z.json(),
    harnesses: z.array(harness),
    projects: z.array(project),
    checks: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
  }),
});

export const setupInit = defineRpc({
  name: "setup.init",
  input: choices,
  output: z.object({ seats: z.array(z.string()), removed: z.array(z.string()), notes: z.array(z.string()) }),
});

export const setupRemove = defineRpc({
  name: "setup.remove",
  input: z.object({}),
  output: z.object({
    removed: z.array(z.string()),
    movedTo: z.string(),
    projects: z.array(z.object({ root: z.string(), moved: z.array(z.string()), left: z.array(z.string()) })),
    notes: z.array(z.string()),
  }),
});

export const setupProject = defineRpc({
  name: "setup.project",
  input: z.object({ name: z.string(), models: modelChoices.nullable() }),
  output: z.object({ own: z.boolean(), seats: z.array(z.string()) }),
});

const jevCheck = z.object({ at: z.string(), ok: z.boolean(), ms: z.number().nullable(), why: z.string().nullable() });

export const jevState = defineRpc({
  name: "jev.state",
  input: z.object({}),
  output: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    key: z.enum(["file", "env", "none", "keyless"]),
    why: z.string().nullable(),
    calls: z.number(),
    failed: z.number(),
    monthUsd: z.number(),
    check: jevCheck.nullable(),
  }),
});

export const jevKey = defineRpc({
  name: "jev.key",
  input: z.object({ key: z.string().min(1).max(512) }),
  output: jevCheck,
});

export const jevTry = defineRpc({
  name: "jev.check",
  input: z.object({}),
  output: jevCheck,
});
