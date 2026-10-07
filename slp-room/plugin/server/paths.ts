import { homedir } from "node:os";
import { join } from "node:path";

/** Everything the room owns lives under one directory; SLP_ROOM_HOME overrides it. */
export const USER_HOME = homedir();
export const ROOM_HOME = process.env.SLP_ROOM_HOME?.trim() || join(USER_HOME, ".config", "slp-room");

/** The room files install.sh copies here: models.json, roles/, specs/, harness/, law/, skills/. */
export const ROOM_DIR = join(ROOM_HOME, "room");

/** Isolated runtimes, one per harness and role: runtimes/<harness>/<role>. */
export const RUNTIMES_DIR = join(ROOM_HOME, "runtimes");

/** Seats enabled in paseo/seats.yml, as generated seats.json: { seats, providers }. */
export const SEATS_FILE = join(ROOM_HOME, "seats.json");

/** Registry of SLP projects the room may work in (see registry.ts). */
export const REGISTRY_FILE = join(ROOM_HOME, "projects.json");

/** Append-only log of seats created, read by the HQ Supervisor. */
export const REGISTRY_LOG = join(ROOM_HOME, "registry-log.jsonl");

/** Optional `claude setup-token` token shared by the Claude seats (mode 600). */
export const TOKEN_FILE = join(ROOM_HOME, "oauth-token");

/** The daemon's home: config.json (fallback for the Claude token) and the schedule store GC reads. */
export const PASEO_HOME = process.env.PASEO_HOME?.trim() || join(USER_HOME, ".paseo");
export const PASEO_CONFIG = join(PASEO_HOME, "config.json");
export const PASEO_SCHEDULES = join(PASEO_HOME, "schedules");

/** The user's own harness homes. Runtimes share credentials and skills from these by symlink. */
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR?.trim() || join(USER_HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(USER_HOME, ".codex");
export const PI_HOME = process.env.PI_CODING_AGENT_DIR?.trim() || join(USER_HOME, ".pi", "agent");
export const OPENCODE_CONFIG_HOME = process.env.OPENCODE_CONFIG_DIR?.trim() || join(USER_HOME, ".config", "opencode");
