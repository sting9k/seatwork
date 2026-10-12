import { execFile } from "node:child_process";

const atLeast = (version: string, wanted: number[]): boolean => {
  const parts = version.split("-")[0].split(".").map(Number);
  if (parts.some(Number.isNaN)) return false;
  for (let i = 0; i < wanted.length; i += 1) {
    if ((parts[i] ?? 0) !== wanted[i]) return (parts[i] ?? 0) > wanted[i];
  }
  return true;
};

/** What `pi --version` prints, or "" when there is no pi to run. */
function piVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile("pi", ["--version"], { timeout: 10_000 }, (error, stdout) => resolve(error ? "" : stdout.split("\n")[0].trim()));
  });
}

/**
 * A Pi seat gets the room's tools through Pi's built-in MCP, which Pi has from 0.99. Returns what
 * is wrong with this machine's Pi, or null.
 */
export async function piProblem(version: Promise<string> = piVersion()): Promise<string | null> {
  const found = await version;
  return atLeast(found, [0, 99]) ? null : `a Pi seat needs Pi 0.99 or later to get the room's tools; found ${found || "no pi on PATH"}`;
}
