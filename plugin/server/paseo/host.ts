import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import callLimits from "../../shared/host.json";
import type { Host, LiveSeat, NewSeat, SeatState, SeatUsage, TurnEvent } from "../host";
import { latestTurn } from "./timeline";
import { PASEO_SCHEDULES } from "../paths";
import type { PaseoApi } from "./api";
import { paseoCli } from "./cli";

/** The room's Host on Paseo: the SDK client of the last hook or app call, else the paseo CLI. */

interface Agent {
  id: string;
  provider?: string;
  title?: string | null;
  cwd?: string;
  parentAgentId?: string | null;
  status?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  pendingPermissions?: unknown[] | null;
  activeTurn?: { startedAt?: string | null } | null;
  lastError?: string | null;
  lastUsage?: SeatUsage | null;
  model?: string | null;
  currentModeId?: string | null;
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
}

const LIST_PAGE_SIZE = 200;
const LIST_PAGES = 20;

/** How long each kind of call to the app may take, in seconds. */
type HostLimits = Pick<typeof callLimits, "readSeconds" | "historySeconds" | "writeSeconds">;

/** Waits for `call` at most `seconds`; past that the call fails like an app that cannot be reached, and its late answer is dropped. */
async function within<T>(seconds: number, what: string, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Paseo did not answer ${what} within ${seconds} seconds`)),
      seconds * 1000,
    );
  });
  try {
    return await Promise.race([call(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A Paseo agent as the room reads a seat. */
function liveSeat(agent: Agent): LiveSeat {
  const waiting = Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0;
  return {
    id: agent.id,
    provider: agent.provider ?? "",
    title: agent.title ?? null,
    cwd: agent.cwd ?? "",
    parentId: agent.parentAgentId ?? null,
    status: agent.status ?? "unknown",
    state: stateOf({ status: agent.status, archived: false, waiting }),
    waiting,
    updatedAt: agent.updatedAt ?? "",
    turnStartedAt: agent.activeTurn?.startedAt ?? null,
    error: agent.lastError ?? null,
    usage: agent.lastUsage ?? null,
    model: agent.model ?? null,
    mode: agent.currentModeId ?? null,
    thinking: agent.thinkingOptionId ?? agent.effectiveThinkingOptionId ?? null,
  };
}

/** A seat's state from what the daemon says of it; null is an agent the daemon answered it does not have. */
function stateOf(agent: { status?: string; archived?: boolean; waiting: boolean } | null): SeatState {
  if (!agent || agent.archived) return "gone";
  if (agent.waiting) return "permission";
  if (agent.status === "running") return "running";
  if (agent.status === "idle" || agent.status === "closed" || agent.status === "error") return "idle";
  // initializing: its session is still opening
  return "unknown";
}

interface Schedule {
  id: string;
  name?: string | null;
  status?: string;
  target?: { type?: string; agentId?: string };
}

/** Every schedule in the daemon's store, read from disk by file name: `paseo schedule ls` hides heartbeats. */
function storedSchedules(): Schedule[] {
  if (!existsSync(PASEO_SCHEDULES)) return [];
  const out: Schedule[] = [];
  for (const name of readdirSync(PASEO_SCHEDULES).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(PASEO_SCHEDULES, name), "utf8")) as Schedule;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // a file the daemon is writing or another version wrote is left alone
    }
  }
  return out;
}

/** The Host the room runs on: Paseo hands a client only inside hooks and app calls, so the latest one is kept. */
export class PaseoHost implements Host {
  private client: PaseoApi | null = null;
  private wakerLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly limits: HostLimits = callLimits) {}

  use(paseo: PaseoApi): void {
    this.client = paseo;
  }

  /** The client Paseo last handed over; null before the first hook or app call. */
  get ready(): PaseoApi | null {
    return this.client;
  }

  private sdk(): PaseoApi {
    if (!this.client) throw new Error("Paseo has handed the room no client yet");
    return this.client;
  }

  async state(agentId: string): Promise<SeatState> {
    if (!this.client) return this.stateByCli(agentId);
    const handle = this.client.agents.ref(agentId);
    try {
      await within(this.limits.readSeconds, `the state request for ${agentId}`, () => handle.refresh());
    } catch {
      // a lost connection or a timeout proves nothing about the seat
      return "unknown";
    }
    const agent = handle.current() as Agent | null;
    return stateOf(agent && { ...liveSeat(agent), archived: !!agent.archivedAt });
  }

  /** The state of a seat read through the CLI, for the time before Paseo has handed a client. */
  private async stateByCli(agentId: string): Promise<SeatState> {
    let raw: string;
    try {
      raw = await paseoCli(["agent", "inspect", agentId, "--json"]);
    } catch (error) {
      return /not found|no agent/i.test(String(error)) ? "gone" : "unknown";
    }
    let agent: { Status?: string; Archived?: boolean; PendingPermissions?: unknown[] | null };
    try {
      agent = JSON.parse(raw);
    } catch {
      // an answer that is no JSON proves nothing about the seat
      return "unknown";
    }
    return stateOf({
      status: agent.Status,
      archived: agent.Archived === true,
      waiting: (agent.PendingPermissions?.length ?? 0) > 0,
    });
  }

  async send(agentId: string, text: string, interrupt: boolean): Promise<void> {
    if (this.client) {
      const handle = this.client.agents.ref(agentId);
      // the SDK interrupts a running agent by default; the room does so for a stop order only
      await within(this.limits.writeSeconds, `the message to ${agentId}`, () =>
        handle.send(text, { activeTurnBehavior: interrupt ? "interrupt" : "steer" } as never),
      );
      return;
    }
    // the CLI has no steer: without a client only a seat at rest, or a stop order, is written to
    if (!interrupt && (await this.stateByCli(agentId)) !== "idle")
      throw new Error("no Paseo client to steer a running seat");
    const dir = mkdtempSync(join(tmpdir(), "seatwork-send-"));
    try {
      writeFileSync(join(dir, "prompt.txt"), text, { mode: 0o600 });
      await paseoCli(["send", agentId, "--prompt-file", join(dir, "prompt.txt"), "--no-wait"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async reparent(child: string, parent: string): Promise<void> {
    // Paseo's parent link is a label; moving it keeps the parent's archive from cascading to the adopted child
    await paseoCli(["agent", "update", child, "--label", `paseo.parent-agent-id=${parent}`]);
  }

  async live(): Promise<Map<string, LiveSeat>> {
    const paseo = this.sdk();
    return within(this.limits.readSeconds, "the list of open seats", () => this.listOpen(paseo));
  }

  /** Every open agent, page by page. */
  private async listOpen(paseo: PaseoApi): Promise<Map<string, LiveSeat>> {
    const out = new Map<string, LiveSeat>();
    let cursor: string | undefined;
    for (let page = 0; page < LIST_PAGES; page += 1) {
      const result = await paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: LIST_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of result.entries) {
        const agent = (entry as { agent: Agent }).agent;
        out.set(agent.id, liveSeat(agent));
      }
      const info = (result as { pageInfo?: { nextCursor?: string | null; hasMore?: boolean } }).pageInfo;
      cursor = info?.hasMore && info.nextCursor ? info.nextCursor : undefined;
      if (!cursor) return out;
    }
    // a seat missing from a cut list would read as gone, and its heartbeats would be deleted
    throw new Error(`Paseo lists more than ${LIST_PAGES * LIST_PAGE_SIZE} open agents`);
  }

  async seat(agentId: string): Promise<LiveSeat | null> {
    const handle = this.sdk().agents.ref(agentId);
    await within(this.limits.readSeconds, `the seat request for ${agentId}`, () => handle.refresh());
    const agent = handle.current() as Agent | null;
    return agent && !agent.archivedAt ? liveSeat(agent) : null;
  }

  // no limit: a start cut off may still have happened, and the caller would start a second
  async create(seat: NewSeat): Promise<string> {
    const created = await this.sdk().agents.create({
      config: {
        provider: seat.model ? `${seat.provider}/${seat.model}` : seat.provider,
        ...(seat.mode ? { modeId: seat.mode } : {}),
        ...(seat.thinking ? { thinkingOptionId: seat.thinking } : {}),
      },
      cwd: seat.cwd,
      ...(seat.parent ? { parent: seat.parent } : {}),
      title: seat.title,
      prompt: seat.prompt,
    });
    return created.id;
  }

  async archive(agentId: string): Promise<void> {
    if (this.client) {
      const handle = this.client.agents.ref(agentId);
      await within(this.limits.writeSeconds, `the archive of ${agentId}`, () => handle.archive());
    } else await paseoCli(["agent", "archive", agentId]);
  }

  async turn(agentId: string, limit: number): Promise<TurnEvent[] | null> {
    try {
      const page = await this.timeline(agentId, limit);
      return latestTurn(page.entries);
    } catch {
      return null;
    }
  }

  async prompts(agentId: string, limit: number): Promise<string[] | null> {
    try {
      const page = await this.timeline(agentId, limit);
      return page.entries.flatMap(({ item }) => {
        const entry = item as { type?: unknown; text?: unknown };
        return entry.type === "user_message" && typeof entry.text === "string" ? [entry.text] : [];
      });
    } catch {
      return null;
    }
  }

  /** The last `limit` entries of a seat's history. */
  private timeline(agentId: string, limit: number) {
    const handle = this.sdk().agents.ref(agentId);
    return within(this.limits.historySeconds, `the history request for ${agentId}`, () =>
      handle.timeline.refetch({ direction: "tail", projection: "projected", limit }),
    );
  }

  async projects(): Promise<{ name: string; path: string }[]> {
    const paseo = this.sdk();
    const { projects } = await within(this.limits.readSeconds, "the list of projects", () => paseo.projects.list());
    return projects.map((project) => ({ name: project.projectDisplayName, path: project.projectRootPath }));
  }

  /** A heartbeat is a Paseo schedule aimed at a seat; one pass at a time, and one that cannot be deleted does not stop the rest. */
  dropWakers(seat: (agentId: string) => "gone" | "live" | null): Promise<{ deleted: string[]; failed: string[] }> {
    const run = this.wakerLock.then(async () => {
      const deleted: string[] = [];
      const failed: string[] = [];
      for (const schedule of storedSchedules()) {
        const target = schedule.target?.type === "agent" ? schedule.target.agentId : undefined;
        const state = target ? seat(target) : null;
        // a schedule aimed at an agent that is not the room's is the user's own, finished or not
        if (!target || state === null || (state === "live" && schedule.status !== "completed")) continue;
        const what = `heartbeat ${schedule.id} (${schedule.name ?? ""}) of ${target}`;
        try {
          await paseoCli(["schedule", "delete", schedule.id]);
          deleted.push(what);
        } catch (error) {
          failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { deleted, failed };
    });
    this.wakerLock = run.catch(() => undefined);
    return run;
  }
}
