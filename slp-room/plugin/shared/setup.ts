import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const watcher = z.enum(["off", "shadow", "on"]);
/** Differences from the room's model table, in the table's own shape: objects merge, lists and values replace. */
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
  /** Why it cannot be chosen, in Paseo's words. */
  why: z.string(),
  models: z.array(z.object({ id: z.string(), label: z.string(), thinking: z.array(z.string()), defaultThinking: z.string() })),
});

const project = z.object({
  name: z.string(),
  root: z.string(),
  /** Whether `.slp/room.json` carries a table of the project's own. */
  own: z.boolean(),
  /** Its differences from the room's table, in the table's shape; {} when it has none. */
  models: modelChoices,
  /** Why its table cannot be used as written, in the room's words. */
  error: z.string().nullable(),
});

/** What the setup screen needs to draw itself: whether a room is set up here, what it runs on, and what this machine offers. */
export const setupState = defineRpc({
  name: "setup.state",
  input: z.object({}),
  output: z.object({
    /** This plugin's version. */
    version: z.string(),
    home: z.string(),
    /** What the room was last set up with; null on a daemon that only downloaded the plugin. */
    applied: choices.extend({ version: z.string(), seats: z.array(z.string()) }).nullable(),
    /** The room's own model table, the choices' starting point. */
    table: z.json(),
    harnesses: z.array(harness),
    watcherKey: z.boolean(),
    /** The registered projects: each runs on the room's table, with its own differences laid over it when it has any. */
    projects: z.array(project),
    /** ok: true fine, false needs the Owner, null unknown. */
    checks: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
  }),
});

/** Sets the room up for these choices, or again after they changed: the room home, the seats and profiles in Paseo, the HQ project. */
export const setupInit = defineRpc({
  name: "setup.init",
  input: choices,
  output: z.object({ seats: z.array(z.string()), removed: z.array(z.string()), notes: z.array(z.string()) }),
});

/** Takes the room off this daemon: its seats and profiles leave Paseo, its home is moved aside and kept. */
export const setupRemove = defineRpc({
  name: "setup.remove",
  input: z.object({}),
  output: z.object({ removed: z.array(z.string()), movedTo: z.string() }),
});

/** Stores the watcher's key in the room home. It is written, never read back to the app. */
export const setupWatcherKey = defineRpc({
  name: "setup.watcher-key",
  input: z.object({ key: z.string() }),
  output: z.object({ set: z.boolean() }),
});

/** Writes a registered project's own model table into its `.slp/room.json`; null or {} puts it back on the room's table. */
export const setupProject = defineRpc({
  name: "setup.project",
  input: z.object({ name: z.string(), models: modelChoices.nullable() }),
  /** The seats that were set up because the table names them. */
  output: z.object({ own: z.boolean(), seats: z.array(z.string()) }),
});
