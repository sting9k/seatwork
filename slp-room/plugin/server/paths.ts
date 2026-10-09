import { homedir } from "node:os";
import { join } from "node:path";

/** Everything the room owns lives under one directory; SLP_ROOM_HOME overrides it. */
export const USER_HOME = homedir();
export const ROOM_HOME = process.env.SLP_ROOM_HOME?.trim() || join(USER_HOME, ".config", "slp-room");

/** The room files install.sh copies here: models.json, roles/, specs/, harness/, skills/. */
export const ROOM_DIR = join(ROOM_HOME, "room");

/** Isolated runtimes, one per harness and role: runtimes/<harness>/<role>. */
export const RUNTIMES_DIR = join(ROOM_HOME, "runtimes");

/** Claude role skills, one directory per role, handed to a seat as an additional directory (runtimes.ts). */
export const ROLE_SKILLS_DIR = join(ROOM_HOME, "role-skills");

/** Seats enabled in paseo/seats.yml, as generated seats.json: { seats, providers }. */
export const SEATS_FILE = join(ROOM_HOME, "seats.json");

/** Registry of SLP projects the room may work in (see registry.ts). */
export const REGISTRY_FILE = join(ROOM_HOME, "projects.json");

/** The default project every install has: the home of the HQ Supervisor (see hq.ts). */
export const HQ_PROJECT = "hq-seatwork";
export const HQ_DIR = join(ROOM_HOME, HQ_PROJECT);

/** Append-only log of seats created, read by the HQ Supervisor. */
export const REGISTRY_LOG = join(ROOM_HOME, "registry-log.jsonl");

/** The daemon's home, for the schedule store GC reads. */
export const PASEO_HOME = process.env.PASEO_HOME?.trim() || join(USER_HOME, ".paseo");
export const PASEO_SCHEDULES = join(PASEO_HOME, "schedules");

/** The user's own harness homes. Runtimes share credentials and skills from these by symlink. */
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR?.trim() || join(USER_HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(USER_HOME, ".codex");
export const PI_HOME = process.env.PI_CODING_AGENT_DIR?.trim() || join(USER_HOME, ".pi", "agent");
export const OPENCODE_CONFIG_HOME = process.env.OPENCODE_CONFIG_DIR?.trim() || join(USER_HOME, ".config", "opencode");
