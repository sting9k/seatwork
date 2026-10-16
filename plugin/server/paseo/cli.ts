import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The paseo CLI, for daemon operations the plugin SDK lacks; SEATWORK_PASEO_BIN overrides the lookup. */
function paseoBin(): string {
  const fromPath = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "paseo"));
  const candidates = [process.env.SEATWORK_PASEO_BIN, ...fromPath, "/opt/homebrew/bin/paseo", "/usr/local/bin/paseo"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("paseo CLI not found on PATH; set SEATWORK_PASEO_BIN");
}

/** Runs `paseo <args>` and resolves its stdout; rejects with stderr on failure. */
export function paseoCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(paseoBin(), args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`paseo ${args.join(" ")}: ${stderr.trim() || error.message}`));
      else resolve(stdout);
    });
  });
}
