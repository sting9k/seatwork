import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/** Paseo's API as a plugin gets it. Taken from the plugin SDK: Paseo supplies that to a plugin installed from Git, and not @getpaseo/client. */
export type PaseoApi = PluginHandlerContext["paseo"];
