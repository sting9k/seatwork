import { execFile } from "node:child_process";

/** Flags and environment for git in a seat's work tree: no monitor, hook, external diff, user config, or filter and diff driver the repository names may run here. */

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MOST_DRIVERS = 100;
const DRIVERS_KEPT = 64;
const DRIVERS_FOR_MS = 5000;
const DRIVER_KEY = /^(filter|diff)\.(.+)\.(clean|smudge|process|required|textconv|command)$/;

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
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_CONFIG_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ATTR_SOURCE: EMPTY_TREE,
};

const drivers = new Map<string, { at: number; env: Promise<NodeJS.ProcessEnv | null> }>();

function execGit(
  cwd: string | null,
  args: readonly string[],
  limits: { timeoutMs: number; maxBytes: number },
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(
      "git",
      [...GIT_SAFE_ARGS, ...args],
      { cwd: cwd ?? undefined, timeout: limits.timeoutMs, maxBuffer: limits.maxBytes, encoding: "utf8", env },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({ code: !error ? 0 : typeof code === "number" ? code : -1, out: stdout ?? "" });
      },
    ),
  );
}

/** The environment that empties every program the repository's config gives a filter or a diff driver, which any attribute file may name; null when they cannot be listed or are too many. */
async function driverEnv(cwd: string | null, timeoutMs: number): Promise<NodeJS.ProcessEnv | null> {
  const listed = await execGit(cwd, ["config", "--list", "-z"], { timeoutMs, maxBytes: 1 << 20 }, GIT_SAFE_ENV);
  if (listed.code !== 0) return null;
  const names = new Set<string>();
  for (const entry of listed.out.split("\0")) {
    const found = DRIVER_KEY.exec(entry.split("\n", 1)[0]);
    if (found) names.add(`${found[1]}\0${found[2]}`);
  }
  if (names.size > MOST_DRIVERS) return null;
  const set: [string, string][] = [];
  for (const name of names) {
    const [kind, driver] = name.split("\0");
    if (kind === "filter")
      set.push(
        [`filter.${driver}.clean`, ""],
        [`filter.${driver}.smudge`, ""],
        [`filter.${driver}.process`, ""],
        [`filter.${driver}.required`, "false"],
      );
    else set.push([`diff.${driver}.textconv`, ""], [`diff.${driver}.command`, ""]);
  }
  const env: NodeJS.ProcessEnv = { ...GIT_SAFE_ENV, GIT_CONFIG_COUNT: String(set.length) };
  set.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** The environment for a folder, listed once for a few seconds. */
function envFor(cwd: string | null, timeoutMs: number): Promise<NodeJS.ProcessEnv | null> {
  const key = cwd ?? "";
  const kept = drivers.get(key);
  if (kept && Date.now() - kept.at < DRIVERS_FOR_MS) return kept.env;
  drivers.delete(key);
  if (drivers.size >= DRIVERS_KEPT) drivers.delete(drivers.keys().next().value!);
  const env = driverEnv(cwd, timeoutMs);
  const entry = { at: Date.now(), env };
  drivers.set(key, entry);
  // a listing that failed is tried again by the next call
  void env.then((found) => {
    if (!found && drivers.get(key) === entry) drivers.delete(key);
  });
  return env;
}

/** One git command in a work tree with the safe flags and env: its exit code, -1 when it could not run or ran out of time, and what it printed. */
export async function runGit(
  cwd: string | null,
  args: readonly string[],
  limits: { timeoutMs: number; maxBytes: number },
): Promise<{ code: number; out: string }> {
  const env = await envFor(cwd, limits.timeoutMs);
  return env ? execGit(cwd, args, limits, env) : { code: -1, out: "" };
}
