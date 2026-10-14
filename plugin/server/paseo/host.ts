import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host, LiveSeat, NewSeat, SeatState, SeatUsage } from "../host";
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

/** A Paseo agent as the room reads a seat. */
function liveSeat(agent: Agent): LiveSeat {
  return {
    id: agent.id,
    provider: agent.provider ?? "",
    title: agent.title ?? null,
    cwd: agent.cwd ?? "",
    parentId: agent.parentAgentId ?? null,
    status: agent.status ?? "unknown",
    waiting: Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0,
    updatedAt: agent.updatedAt ?? "",
    turnStartedAt: agent.activeTurn?.startedAt ?? null,
    error: agent.lastError ?? null,
    usage: agent.lastUsage ?? null,
    model: agent.model ?? null,
    mode: agent.currentModeId ?? null,
    thinking: agent.thinkingOptionId ?? agent.effectiveThinkingOptionId ?? null,
  };
}

function stateOf(agent: { status?: string; archived?: boolean; waiting: boolean } | null): SeatState {
  // the daemon answered: it has no such agent (deleted), or the agent is archived
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

/** Every schedule in the daemon's store, read from disk: `paseo schedule ls` hides heartbeats. */
function storedSchedules(): Schedule[] {
  if (!existsSync(PASEO_SCHEDULES)) return [];
  const out: Schedule[] = [];
  for (const name of readdirSync(PASEO_SCHEDULES)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(PASEO_SCHEDULES, name), "utf8")) as Schedule;
      if (parsed && typeof parsed.id === "string") out.push(parsed);
    } catch {
      // not ours to judge
    }
  }
  return out;
}

export class PaseoHost implements Host {
  private client: PaseoApi | null = null;
  private wakerLock: Promise<unknown> = Promise.resolve();

  /** Paseo hands a client only inside hooks and app calls: the latest is kept. */
  use(paseo: PaseoApi): void {
    this.client = paseo;
  }

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
      await handle.refresh();
    } catch {
      // a lost connection or a timeout proves nothing about the seat
      return "unknown";
    }
    const agent = handle.current() as Agent | null;
    return stateOf(agent && { ...liveSeat(agent), archived: !!agent.archivedAt });
  }

  private async stateByCli(agentId: string): Promise<SeatState> {
    let raw: string;
    try {
      raw = await paseoCli(["agent", "inspect", agentId, "--json"]);
    } catch (error) {
      return /not found|no agent/i.test(String(error)) ? "gone" : "unknown";
    }
    const agent = JSON.parse(raw) as { Status?: string; Archived?: boolean; PendingPermissions?: unknown[] | null };
    return stateOf({
      status: agent.Status,
      archived: agent.Archived === true,
      waiting: (agent.PendingPermissions?.length ?? 0) > 0,
    });
  }

  async send(agentId: string, text: string, interrupt: boolean): Promise<void> {
    if (this.client) {
      // the SDK interrupts a running agent by default; the room does so for a stop order only
      await this.client.agents
        .ref(agentId)
        .send(text, { activeTurnBehavior: interrupt ? "interrupt" : "steer" } as never);
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
    // Paseo's parent link is a label; moving it keeps its archive cascade off the adopted child
    await paseoCli(["agent", "update", child, "--label", `paseo.parent-agent-id=${parent}`]);
  }

  async live(): Promise<Map<string, LiveSeat>> {
    const paseo = this.sdk();
    const out = new Map<string, LiveSeat>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of result.entries) {
        const agent = (entry as { agent: Agent }).agent;
        out.set(agent.id, liveSeat(agent));
      }
      const info = (result as { pageInfo?: { nextCursor?: string | null; hasMore?: boolean } }).pageInfo;
      cursor = info?.hasMore && info.nextCursor ? info.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async seat(agentId: string): Promise<LiveSeat | null> {
    const handle = this.sdk().agents.ref(agentId);
    await handle.refresh();
    const agent = handle.current() as Agent | null;
    return agent && !agent.archivedAt ? liveSeat(agent) : null;
  }

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
    if (this.client) await this.client.agents.ref(agentId).archive();
    else await paseoCli(["agent", "archive", agentId]);
  }

  async prompts(agentId: string, limit: number): Promise<string[] | null> {
    try {
      const page = await this.sdk()
        .agents.ref(agentId)
        .timeline.refetch({ direction: "tail", projection: "projected", limit });
      return page.entries.flatMap(({ item }) => {
        const entry = item as { type?: unknown; text?: unknown };
        return entry.type === "user_message" && typeof entry.text === "string" ? [entry.text] : [];
      });
    } catch {
      return null;
    }
  }

  async projects(): Promise<{ name: string; path: string }[]> {
    const { projects } = await this.sdk().projects.list();
    return projects.map((project) => ({ name: project.projectDisplayName, path: project.projectRootPath }));
  }

  /** A heartbeat is a Paseo schedule aimed at a seat; one pass at a time. */
  dropWakers(orphan: (agentId: string) => boolean): Promise<string[]> {
    const run = this.wakerLock.then(async () => {
      const gone: string[] = [];
      for (const schedule of storedSchedules()) {
        const target = schedule.target?.type === "agent" ? schedule.target.agentId : undefined;
        if (!target || (!orphan(target) && schedule.status !== "completed")) continue;
        await paseoCli(["schedule", "delete", schedule.id]);
        gone.push(`heartbeat ${schedule.id} (${schedule.name ?? ""}) of ${target}`);
      }
      return gone;
    });
    this.wakerLock = run.catch(() => undefined);
    return run;
  }
}
