import { execFile } from "node:child_process";
import { PASEO_HOME } from "../../paths";
import type { PaseoApi } from "../api";
import { readSwitches } from "./paseo-config";
import type { Setup } from "./plan";

/** Whether a dotted version (a suffix after `-` ignored) is at least `wanted`. */
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
    execFile("pi", ["--version"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? "" : stdout.split("\n")[0].trim()),
    );
  });
}

/** What is wrong with this machine's Pi, or null: a Pi seat needs Pi's built-in MCP, there from 0.99. */
export async function piProblem(): Promise<string | null> {
  const found = await piVersion();
  return atLeast(found, [0, 99])
    ? null
    : `a Pi seat needs Pi 0.99 or later to get the room's tools; found ${found || "no pi on PATH"}`;
}

/** What the Owner should know before trusting the room on this machine; `ok: null` is "cannot tell". */
export async function setupChecks(
  paseo: PaseoApi,
  room: {
    pluginDir: string;
    setup: Setup | null;
    seats: string[];
    version: string;
    olderSeats: string[];
    behind: string | undefined;
    ownSeat: { label: string; ok: boolean | null; detail: string } | null;
  },
): Promise<{ id: string; label: string; ok: boolean | null; detail: string }[]> {
  const { pluginDir, setup, seats, version, olderSeats, behind, ownSeat } = room;
  const { config } = await paseo.config.get();
  const switches = readSwitches(PASEO_HOME, pluginDir);
  const tools = (config.mcp as { enabled?: boolean } | undefined)?.enabled ?? switches.paseoTools;
  const checks = [
    {
      id: "paseo-tools",
      label: "Paseo's tools for agents",
      ok: tools ?? null,
      detail:
        tools === false
          ? "Off: seats cannot create or reach each other. Turn it on in Paseo's settings."
          : "Seats create and reach each other through them.",
    },
  ];
  if (ownSeat) checks.push({ id: "own-seat", ...ownSeat });
  if (setup && setup.version !== version) {
    checks.push({
      id: "version",
      label: "Room files",
      ok: false,
      detail: `Set up by ${setup.version ? `version ${setup.version}` : "an earlier version"}; Apply brings them to ${version}.${behind ? ` The plugin tried by itself and could not: ${behind}` : ""}`,
    });
  }
  if (olderSeats.length) {
    const many = olderSeats.length > 1;
    checks.push({
      id: "older-seats",
      label: "Seats from before the update",
      ok: false,
      detail: `${olderSeats.length} open seat${many ? "s" : ""} got ${many ? "their" : "its"} prompt from an earlier version of the plugin and ${many ? "keep" : "keeps"} it: ${olderSeats.slice(0, 5).join(", ")}${olderSeats.length > 5 ? ", …" : ""}. Archive a seat and create it again to have it on ${version}.`,
    });
  }
  if (seats.some((seat) => seat.startsWith("pi-"))) {
    const problem = await piProblem();
    checks.push({
      id: "pi",
      label: "Pi",
      ok: !problem,
      detail: problem ?? "Recent enough to give a Pi seat the room's tools.",
    });
  }
  for (const [id, label, on] of [
    ["dictation", "Dictation", switches.dictation],
    ["voice", "Voice mode", switches.voiceMode],
  ] as const) {
    if (on)
      checks.push({
        id,
        label,
        ok: false,
        detail: "On for every agent on this host; the room keeps it off. Turn it off in Paseo's settings.",
      });
  }
  return checks;
}
