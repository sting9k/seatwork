import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "../../server/paseo/api";
import { PASEO_SCHEDULES } from "../../server/paths";

/** A stand-in Paseo app on the SDK's own types, with a paseo CLI over the same agents: it keeps receipts and starts by key as the app does, and a call can hang, answer late, or lose a message (`forget` counts the next new ids it loses). */

type Agents = PaseoApi["agents"];
type Handle = ReturnType<Agents["ref"]>;
type Agent = NonNullable<ReturnType<Handle["current"]>>;

/** An agent as the stand-in keeps it: any of the SDK's fields. */
export type StandInAgent = Partial<Agent> & { id: string };

/** A call of the SDK the stand-in can make hang or answer late. */
export type Call = "refresh" | "send" | "list" | "create" | "archive" | "timeline" | "projects";

/** A message as it reached an agent: through the SDK with its behaviour and id, or through the CLI. */
export interface Arrival {
  agentId: string;
  text: string;
  behaviour: string | null;
  id: string | null;
}

/** A schedule in the app's store; `stuck` is one the CLI fails to delete. */
export interface StandInSchedule {
  id: string;
  agentId: string | null;
  status: string;
  stuck?: boolean;
}

const never = () => new Promise<never>(() => {});
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

export class StandInApp {
  readonly hang = new Set<Call>();
  readonly late = new Map<Call, number[]>();
  readonly cli: string;
  endless = false;
  forget = 0;
  private readonly agents = new Map<string, StandInAgent>();
  private readonly history = new Map<string, { item: unknown; timestamp?: string; turnId?: string }[]>();
  private readonly arrivals: Arrival[] = [];
  private readonly receipts = new Map<string, string>();
  private readonly starts = new Map<string, { request: string; id: string }>();
  private projectList: { name: string; path: string }[] = [];
  private pages = 0;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, "agents"), { recursive: true });
    rmSync(PASEO_SCHEDULES, { recursive: true, force: true });
    mkdirSync(PASEO_SCHEDULES, { recursive: true });
    this.cli = join(dir, "paseo");
    writeFileSync(join(dir, "stuck"), "");
    writeFileSync(
      this.cli,
      [
        "#!/bin/sh",
        `d="${dir}"`,
        'echo "$*" >> "$d/calls"',
        'case "$1" in',
        '  send) echo "$2" >> "$d/cli-sent"; cat "$4" > "$d/cli-text-$2" ;;',
        '  agent) case "$2" in',
        '    inspect) if [ -f "$d/agents/$3.json" ]; then cat "$d/agents/$3.json";',
        '      else echo \'{"error":{"code":"AGENT_NOT_FOUND","message":"Agent not found"}}\' >&2; exit 1; fi ;;',
        "    update|archive) ;;",
        "    *) exit 1 ;;",
        "  esac ;;",
        '  schedule) if grep -qx "$3" "$d/stuck"; then echo "no such schedule" >&2; exit 1; fi',
        `    rm -f "${PASEO_SCHEDULES}/$3.json" ;;`,
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  /** Puts an agent in the app, or changes the one there; the CLI answers for it too. */
  put(agent: StandInAgent): this {
    const now = { ...this.agents.get(agent.id), ...agent };
    this.agents.set(agent.id, now);
    this.inspected(now);
    return this;
  }

  /** What the CLI's `agent inspect` prints for an agent. */
  private inspected(agent: StandInAgent): void {
    const answer = {
      Status: agent.status ?? "idle",
      Archived: !!agent.archivedAt,
      PendingPermissions: agent.pendingPermissions ?? [],
    };
    writeFileSync(join(this.dir, "agents", `${agent.id}.json`), JSON.stringify(answer));
  }

  /** Makes the CLI answer for an agent with text that is no JSON. */
  garble(id: string): this {
    writeFileSync(join(this.dir, "agents", `${id}.json`), "the daemon is restarting");
    return this;
  }

  agent(id: string): StandInAgent | undefined {
    return this.agents.get(id);
  }

  /** Sets the entries of an agent's history, oldest first. */
  timeline(id: string, entries: { item: unknown; timestamp?: string; turnId?: string }[]): this {
    this.history.set(id, entries);
    return this;
  }

  projects(list: { name: string; path: string }[]): this {
    this.projectList = list;
    return this;
  }

  /** Writes schedules into the app's store, where the Host reads them from disk. */
  schedules(list: StandInSchedule[]): this {
    for (const one of list) {
      const target = one.agentId ? { type: "agent", agentId: one.agentId } : { type: "new-agent" };
      writeFileSync(
        join(PASEO_SCHEDULES, `${one.id}.json`),
        JSON.stringify({ id: one.id, status: one.status, target }),
      );
      if (one.stuck) appendFileSync(join(this.dir, "stuck"), `${one.id}\n`);
    }
    return this;
  }

  /** The schedules still in the app's store. */
  scheduled(ids: readonly string[]): string[] {
    return ids.filter((id) => existsSync(join(PASEO_SCHEDULES, `${id}.json`)));
  }

  /** The CLI calls made, each as its words. */
  calls(): string[] {
    const file = join(this.dir, "calls");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
  }

  /** What reached each agent, in order, by the SDK and by the CLI. */
  received(): Arrival[] {
    const file = join(this.dir, "cli-sent");
    const byCli = existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((agentId) => ({
            agentId,
            text: readFileSync(join(this.dir, `cli-text-${agentId}`), "utf8"),
            behaviour: null,
            id: null,
          }))
      : [];
    return [...this.arrivals, ...byCli];
  }

  /** The time a call takes: forever when it hangs, else the next of its late answers. */
  private async answer<T>(call: Call, effect: () => T): Promise<T> {
    if (this.hang.has(call)) return never();
    const done = effect();
    const delay = this.late.get(call)?.shift();
    if (delay) await wait(delay);
    return done;
  }

  /** The handle of one agent: a snapshot read by `refresh`, as the SDK keeps one. */
  private handle(id: string): Partial<Handle> {
    let seen: StandInAgent | null = null;
    const refetch = (options?: Parameters<Handle["timeline"]["refetch"]>[0]) =>
      this.answer("timeline", () => ({ entries: (this.history.get(id) ?? []).slice(-(options?.limit ?? 50)) }));
    return {
      id,
      current: () => (seen ? ({ ...seen } as Agent) : null),
      refresh: () =>
        this.answer("refresh", () => {
          seen = this.agents.get(id) ?? null;
          return null;
        }),
      send: (text: string, options?: Parameters<Handle["send"]>[1]) =>
        this.answer("send", () => this.deliver(id, text, options)),
      archive: () =>
        this.answer("archive", () => {
          const archivedAt = new Date().toISOString();
          if (this.agents.has(id)) this.put({ id, archivedAt });
          return { archivedAt };
        }),
      timeline: { refetch } as unknown as Handle["timeline"],
    };
  }

  /** A message the app takes: under an id it keeps its receipt, so the same message again arrives once. */
  private deliver(agentId: string, text: string, options?: Parameters<Handle["send"]>[1]): void {
    const behaviour = options?.activeTurnBehavior ?? "interrupt";
    const id = options?.messageId ?? null;
    if (id) {
      const key = `${agentId}\0${id}`;
      if (this.forget > 0 && !this.receipts.has(key)) {
        this.forget -= 1;
        this.receipts.set(key, "pending");
      }
      const print = JSON.stringify([text, behaviour]);
      const kept = this.receipts.get(key);
      // a receipt the app never closed is one it cannot say was handed over
      if (kept === "pending") throw new Error("agent_request_outcome_unknown");
      if (kept !== undefined && kept !== print) throw new Error("agent_request_key_conflict");
      if (kept === print) return;
      this.receipts.set(key, print);
    }
    this.arrivals.push({ agentId, text, behaviour, id });
  }

  /** The open agents a page at a time, as `agents.list` gives them; an endless list never says it is done. */
  private list(options?: Parameters<Agents["list"]>[0]) {
    return this.answer("list", () => {
      if (this.endless) {
        this.pages += 1;
        return {
          entries: [{ agent: { id: `endless-${this.pages}`, provider: "claude-peer" } }],
          pageInfo: { hasMore: true, nextCursor: `page-${this.pages}` },
        };
      }
      const open = [...this.agents.values()].filter((agent) => !agent.archivedAt);
      const limit = options?.page?.limit ?? open.length;
      const from = Number(options?.page?.cursor ?? 0);
      const next = from + limit;
      return {
        entries: open.slice(from, next).map((agent) => ({ agent: { ...agent } })),
        pageInfo: { hasMore: next < open.length, nextCursor: next < open.length ? String(next) : null },
      };
    });
  }

  /** A start, kept by its key: the same request again is the same agent, another request under the key is refused. */
  private create(options: Parameters<Agents["create"]>[0]) {
    return this.answer("create", () => {
      const { idempotencyKey: key, ...rest } = options as unknown as { idempotencyKey?: string } & Record<
        string,
        unknown
      >;
      const request = JSON.stringify(rest);
      const kept = key ? this.starts.get(key) : undefined;
      if (kept && kept.request !== request) throw new Error("agent_request_key_conflict");
      if (kept) return { id: kept.id };
      const id = String(rest.agentId ?? `agent-${this.agents.size + 1}`);
      const config = (rest.config ?? {}) as { provider?: string };
      this.put({ id, provider: config.provider, cwd: rest.cwd as string, title: rest.title as string, status: "idle" });
      if (key) this.starts.set(key, { request, id });
      return { id };
    });
  }

  /** The SDK as Paseo hands it to a plugin, over these agents. */
  client(): PaseoApi {
    return {
      agents: {
        ref: (id: string) => this.handle(id),
        list: (options?: Parameters<Agents["list"]>[0]) => this.list(options),
        create: (options: Parameters<Agents["create"]>[0]) => this.create(options),
      },
      projects: {
        list: () =>
          this.answer("projects", () => ({
            projects: this.projectList.map((one) => ({ projectDisplayName: one.name, projectRootPath: one.path })),
          })),
      },
    } as unknown as PaseoApi;
  }

  /** Each start the app made, as it was asked, with its key. */
  started(): { key: string; id: string; request: Record<string, unknown> }[] {
    return [...this.starts].map(([key, one]) => ({ key, id: one.id, request: JSON.parse(one.request) }));
  }
}
