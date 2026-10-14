import { execFile } from "node:child_process";

/** Flags and environment for git in a seat's work tree: no monitor, hook, external diff or user config may run here. */

export const GIT_SAFE_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
];

export const GIT_SAFE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** One git command in a work tree with the safe flags and env: its exit code, -1 when it could not run or ran out of time, and what it printed. */
export function runGit(
  cwd: string | null,
  args: readonly string[],
  limits: { timeoutMs: number; maxBytes: number },
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(
      "git",
      [...GIT_SAFE_ARGS, ...args],
      {
        cwd: cwd ?? undefined,
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxBytes,
        encoding: "utf8",
        env: GIT_SAFE_ENV,
      },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ code: !error ? 0 : typeof code === "number" ? code : -1, out: stdout ?? "" });
      },
    ),
  );
}
