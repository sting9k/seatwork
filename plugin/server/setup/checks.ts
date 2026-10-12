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

/** What is wrong with this machine's Pi, or null: a Pi seat needs Pi's built-in MCP, there from 0.99. */
export async function piProblem(version: Promise<string> = piVersion()): Promise<string | null> {
  const found = await version;
  return atLeast(found, [0, 99]) ? null : `a Pi seat needs Pi 0.99 or later to get the room's tools; found ${found || "no pi on PATH"}`;
}
