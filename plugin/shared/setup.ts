import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const watcher = z.enum(["off", "shadow", "on"]);
/** Differences from the room's model table, in the table's own shape. */
const modelChoices = z.record(z.string(), z.json());

/** The Owner's choices on the setup screen. Paseo keeps them; the room changes only when they are applied. */
export const roomSettings = defineSettings({
  id: "room",
  scope: "host",
  version: 1,
  schema: z.object({
    models: modelChoices.default({}),
    watcher: watcher.default("off"),
    chime: z.boolean().default(true),
  }),
});
export type RoomChoices = z.infer<typeof roomSettings.schema>;

const choices = z.object({ models: modelChoices, watcher, chime: z.boolean() });

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

/** What the setup screen draws from: whether a room is set up here, what it runs on, what this machine offers. */
export const setupState = defineRpc({
  name: "setup.state",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    home: z.string(),
    applied: choices.extend({ version: z.string(), seats: z.array(z.string()) }).nullable(),
    table: z.json(),
    harnesses: z.array(harness),
    watcherKey: z.boolean(),
    projects: z.array(project),
    spend: z.object({ usd: z.number(), planUsd: z.number(), capUsd: z.number() }).nullable(),
    checks: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
  }),
});

/** Sets the room up for these choices, or again after they changed. */
export const setupInit = defineRpc({
  name: "setup.init",
  input: choices,
  output: z.object({ seats: z.array(z.string()), removed: z.array(z.string()), notes: z.array(z.string()) }),
});

/** Takes the room off this daemon; its home and its files in each project are moved aside and kept. */
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

/** Stores the watcher's key in the room home. It is written, never read back to the app. */
export const setupWatcherKey = defineRpc({
  name: "setup.watcher-key",
  input: z.object({ key: z.string() }),
  output: z.object({ set: z.boolean() }),
});

/** Writes a project's own model table into its `.seatwork/room.json`; null or {} puts it back on the room's. */
export const setupProject = defineRpc({
  name: "setup.project",
  input: z.object({ name: z.string(), models: modelChoices.nullable() }),
  output: z.object({ own: z.boolean(), seats: z.array(z.string()) }),
});
