import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The paseo CLI, for the few daemon operations the plugin SDK does not expose
 * (schedules, agent labels). The daemon's plugin process carries the user's
 * PATH; SLP_PASEO_BIN overrides the lookup.
 */
export function paseoBin(): string {
  const fromPath = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "paseo"));
  for (const candidate of [process.env.SLP_PASEO_BIN, ...fromPath, "/opt/homebrew/bin/paseo", "/usr/local/bin/paseo"]) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  throw new Error("paseo CLI not found on PATH; set SLP_PASEO_BIN");
}

/** Runs `paseo <args>` and resolves its stdout; rejects with stderr on failure. */
export function paseoCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(paseoBin(), args, { env: process.env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`paseo ${args.join(" ")}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}
