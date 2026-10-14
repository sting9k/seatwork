/** What the room needs from the app that runs its seats; server/paseo/ is the one implementation. */

/** `idle` is any seat a message starts a turn in: at rest, closed, or after a failed turn. */
export type SeatState = "idle" | "running" | "permission" | "gone" | "unknown";

/** What a seat's agent CLI reports after a turn: dollars so far, context held now. */
export interface SeatUsage {
  totalCostUsd?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
}

/** An open seat as the app shows it. */
export interface LiveSeat {
  id: string;
  provider: string;
  title: string | null;
  cwd: string;
  parentId: string | null;
  /** idle, running, initializing, error or closed */
  status: string;
  /** a permission request waits on someone */
  waiting: boolean;
  updatedAt: string;
  turnStartedAt: string | null;
  error: string | null;
  usage: SeatUsage | null;
  model: string | null;
  mode: string | null;
  thinking: string | null;
}

/** A seat to start: on a provider and model, under a parent, with its first prompt. */
export interface NewSeat {
  provider: string;
  model?: string;
  mode?: string;
  thinking?: string;
  cwd: string;
  parent?: string;
  title: string;
  prompt: string;
}

/** A seat's recent history, entries as the app records them. */
export interface TimelineView {
  entries: { item: unknown; timestamp?: string; turnId?: string }[];
  pendingPermission: boolean;
}

/** How a turn ended. */
export type TurnOutcome = { kind: "completed" } | { kind: "canceled" } | { kind: "failed"; error: string };

export interface Host {
  state(agentId: string): Promise<SeatState>;
  /** Hands text to a seat; `interrupt` ends a running turn first, else it steers. */
  send(agentId: string, text: string, interrupt: boolean): Promise<void>;
  /** Moves the app's own record of a seat's parent. */
  reparent(child: string, parent: string): Promise<void>;
  /** Every open seat, by id. */
  live(): Promise<Map<string, LiveSeat>>;
  /** A fresh read of one seat; null when it is archived or gone; throws when the app does not answer. */
  seat(agentId: string): Promise<LiveSeat | null>;
  create(seat: NewSeat): Promise<string>;
  archive(agentId: string): Promise<void>;
  timeline(agentId: string, limit: number): Promise<TimelineView | null>;
  /** The projects the app knows, by folder. */
  projects(): Promise<{ name: string; path: string }[]>;
  /** Deletes the app's timers that wake a seat for which `orphan` holds; returns what went. */
  dropWakers(orphan: (agentId: string) => boolean): Promise<string[]>;
}
