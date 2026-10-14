import { homedir } from "node:os";
import { join } from "node:path";
import { ROOM_PROJECT } from "../shared/workflow";

/** Everything the room owns lives under one directory; SEATWORK_ROOM_HOME overrides it. */
export const USER_HOME = homedir();
export const ROOM_HOME = process.env.SEATWORK_ROOM_HOME?.trim() || join(USER_HOME, ".config", "seatwork");

/** The room files copied here when the room is set up: models.json, roles/, specs/, harness/, skills/. */
export const ROOM_DIR = join(ROOM_HOME, "room");
/** The layout scripts of the room's SQLite stores, a folder per store. */
export const SQL_DIR = join(ROOM_DIR, "sql");

/** Isolated runtimes, one per harness and role: runtimes/<harness>/<role>. */
export const RUNTIMES_DIR = join(ROOM_HOME, "runtimes");

/** Claude role skills, one directory per role, handed to a seat as an additional directory (runtimes.ts). */
export const ROLE_SKILLS_DIR = join(ROOM_HOME, "role-skills");

/** The seats the room has on this machine: { seats, providers, source }, written when it is set up. */
export const SEATS_FILE = join(ROOM_HOME, "seats.json");

/** Registry of Seatwork projects the room may work in (see registry.ts). */
export const REGISTRY_FILE = join(ROOM_HOME, "projects.json");

/** The default project every install has: where the seats at home in the room sit (registry.ts). */
export const ROOM_PROJECT_DIR = join(ROOM_HOME, ROOM_PROJECT);

/** Append-only log of seats created. */
export const REGISTRY_LOG = join(ROOM_HOME, "registry-log.jsonl");

/** One temporary directory per seat, `tmp/<first 8 of the agent id>`: a seat's `TMPDIR`. */
export const SEAT_TMP_DIR = join(ROOM_HOME, "tmp");

/** What each seat used, noted at turn end: Paseo forgets it once the seat closes. */
export const USAGE_LOG = join(ROOM_HOME, "usage-log.jsonl");

/** The daemon's home, for the schedule store GC reads. */
export const PASEO_HOME = process.env.PASEO_HOME?.trim() || join(USER_HOME, ".paseo");
export const PASEO_SCHEDULES = join(PASEO_HOME, "schedules");

/** The user's own harness homes. Runtimes share credentials and skills from these by symlink. */
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR?.trim() || join(USER_HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(USER_HOME, ".codex");
export const PI_HOME = process.env.PI_CODING_AGENT_DIR?.trim() || join(USER_HOME, ".pi", "agent");
export const OPENCODE_CONFIG_HOME = process.env.OPENCODE_CONFIG_DIR?.trim() || join(USER_HOME, ".config", "opencode");

/** The watcher's own files: its key, its spending ledger and its scan log. */
export const WATCH_DIR = join(ROOM_HOME, "watch");
