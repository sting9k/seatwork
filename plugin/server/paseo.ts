import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** Paseo's API as a plugin gets it, from the plugin SDK: a plugin installed from Git has no @getpaseo/client. */
export type PaseoApi = PluginHandlerContext["paseo"];
