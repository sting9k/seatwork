/** What the room needs from the app that runs its seats; server/paseo/ is the one implementation. */

/** What a seat is doing; `idle` is any seat a message starts a turn in: at rest, closed, or after a failed turn. */
export type SeatState = "idle" | "running" | "permission" | "gone" | "unknown";

/** What a seat's agent CLI reports after a turn: dollars so far, context held now. */
export interface SeatUsage {
  totalCostUsd?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
}

/** An open seat as the app shows it: `status` as the app names it (idle, running, initializing, error, closed), `waiting` for a permission, and `state` what the two come to. */
export interface LiveSeat {
  id: string;
  provider: string;
  title: string | null;
  cwd: string;
  status: string;
  state: SeatState;
  waiting: boolean;
  updatedAt: string;
  turnStartedAt: string | null;
  error: string | null;
  usage: SeatUsage | null;
  model: string | null;
  mode: string | null;
  thinking: string | null;
}

/** A seat to start; `key` names the start, so one asked again under it makes no second seat. */
export interface NewSeat {
  key: string;
  provider: string;
  model?: string;
  mode?: string;
  thinking?: string;
  cwd: string;
  parent?: string;
  title: string;
  prompt: string;
}

/** How a tool call ended, as the app records it. */
export type ToolStatus = "running" | "completed" | "failed" | "canceled";

/** One step of a seat's turn, read from the app's history; `at` only where the app dates it. */
export type TurnEvent =
  | { kind: "prompt"; text: string; at?: string }
  | { kind: "say"; text: string; at?: string }
  | { kind: "think"; text: string; at?: string }
  | { kind: "shell"; command: string; exitCode: number | null; output: string; status: ToolStatus; at?: string }
  | { kind: "change"; path: string; status: ToolStatus; at?: string }
  | { kind: "read"; path: string; at?: string }
  | { kind: "tool"; name: string; label?: string; status: ToolStatus; at?: string }
  | { kind: "compaction"; at?: string };

/** How a turn ended. */
export type TurnOutcome = { kind: "completed" } | { kind: "canceled" } | { kind: "failed"; error: string };

/** A call the app cannot answer yet: it has not handed the room its client, as at the room's first minute. */
export class HostNotReady extends Error {}

export interface Host {
  state(agentId: string): Promise<SeatState>;
  /** Hands text to a seat (`interrupt` ends a running turn first, else it steers); asked again with the same `id`, text and `interrupt`, it hands over once. */
  send(agentId: string, text: string, interrupt: boolean, id?: string): Promise<void>;
  /** Moves the app's own record of a seat's parent. */
  reparent(child: string, parent: string): Promise<void>;
  /** Every open seat, by id. */
  live(): Promise<Map<string, LiveSeat>>;
  /** A fresh read of one seat; null when it is archived or gone; throws when the app does not answer. */
  seat(agentId: string): Promise<LiveSeat | null>;
  create(seat: NewSeat): Promise<string>;
  archive(agentId: string): Promise<void>;
  /** The steps of a seat's latest turn among its last `limit` history entries; null when unread. */
  turn(agentId: string, limit: number): Promise<TurnEvent[] | null>;
  /** The prompts a seat was given among its last `limit` history entries, oldest first; null when unread. */
  prompts(agentId: string, limit: number): Promise<string[] | null>;
  /** The projects the app knows, by folder. */
  projects(): Promise<{ name: string; path: string }[]>;
  /** Deletes the app's timers that wake a seat `seat` calls gone, or a live one's the app finished (null: not the room's agent); names what went and what could not. */
  dropWakers(seat: (agentId: string) => "gone" | "live" | null): Promise<{ deleted: string[]; failed: string[] }>;
  /** Where the app listens for programs on this machine: `host:port`, a port, or a socket path. */
  address(): string;
}
