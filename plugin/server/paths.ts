import { homedir } from "node:os";
import { join } from "node:path";
import { ROOM_PROJECT } from "../shared/workflow";

/** Where the room keeps its files: under one room home (SEATWORK_ROOM_HOME overrides it), beside the harness homes it shares from. */

export const USER_HOME = homedir();
export const ROOM_HOME = process.env.SEATWORK_ROOM_HOME?.trim() || join(USER_HOME, ".config", "seatwork");

export const ROOM_DIR = join(ROOM_HOME, "room");
export const SQL_DIR = join(ROOM_DIR, "sql");
export const RUNTIMES_DIR = join(ROOM_HOME, "runtimes");
export const ROLE_SKILLS_DIR = join(ROOM_HOME, "role-skills");
export const SEATS_FILE = join(ROOM_HOME, "seats.json");
export const REGISTRY_FILE = join(ROOM_HOME, "projects.json");
export const ROOM_PROJECT_DIR = join(ROOM_HOME, ROOM_PROJECT);
export const REGISTRY_LOG = join(ROOM_HOME, "registry-log.jsonl");
export const SEAT_TMP_DIR = join(ROOM_HOME, "tmp");
export const USAGE_LOG = join(ROOM_HOME, "usage-log.jsonl");

export const PASEO_HOME = process.env.PASEO_HOME?.trim() || join(USER_HOME, ".paseo");
export const PASEO_SCHEDULES = join(PASEO_HOME, "schedules");

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR?.trim() || join(USER_HOME, ".claude");
export const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(USER_HOME, ".codex");
export const PI_HOME = process.env.PI_CODING_AGENT_DIR?.trim() || join(USER_HOME, ".pi", "agent");
export const OPENCODE_CONFIG_HOME = process.env.OPENCODE_CONFIG_DIR?.trim() || join(USER_HOME, ".config", "opencode");

export const SAFETY_DIR = join(ROOM_HOME, "safety");
export const JEV_DIR = join(ROOM_HOME, "jev");
export const KNOWLEDGE_DIR = join(ROOM_HOME, "knowledge");
