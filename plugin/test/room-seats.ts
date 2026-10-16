import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT } from "./support/room";
import type { fakeServer } from "./support/server";

/** A seat made through the plugin's hooks: its inbox, a caller of the room's tools over its own MCP server, and its Claude hook's question to the guard. */
export interface TestSeat {
  agent: { id: string; parentAgentId: string | null; provider: string; cwd: string; title: string; workspaceId: null };
  inbox: string[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  mail(args: Record<string, unknown>): Promise<string>;
  hook(tool: string, input: Record<string, unknown>): Promise<string>;
}

/** The seats of a room served through `call`: the app's handles of them, the context the hooks are given, and the verbs a test needs. */
export function roomSeats(call: ReturnType<typeof fakeServer>["call"]) {
  const agents: Record<string, object> = {};
  const listed = async () => ({
    entries: Object.entries(agents).flatMap(([id, handle]) => {
      const now = (handle as { current?: () => object }).current?.();
      return now ? [{ agent: { id, updatedAt: new Date().toISOString(), ...now } }] : [];
    }),
  });
  const context = { paseo: { agents: { ref: (id: string) => agents[id], list: listed } } };

  async function seat(
    id: string,
    provider: string,
    parent: string | null,
    title: string,
    cwd = PROJECT,
  ): Promise<TestSeat> {
    const made = (await call("before agent.create", { request: { config: { provider, cwd, title }, env: {} } })) as {
      env: Record<string, string>;
      config: { mcpServers: { seatwork: { url: string } } };
    };
    await call("before agent.session_open", { request: { env: made.env, reason: "create", agentId: id, provider } });
    const inbox: string[] = [];
    agents[id] = {
      refresh: async () => {},
      current: () => ({ status: "idle" }),
      send: async (text: string) => void inbox.push(text),
    };
    const agent = { id, parentAgentId: parent, provider, cwd, title, workspaceId: null };
    await call("on agent.created", { agent }, context);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(made.config.mcpServers.seatwork.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const { result } = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
      if (result.isError) throw new Error(result.content[0].text);
      return result.content[0].text;
    };
    const gate = `${made.config.mcpServers.seatwork.url.replace(/\/mcp\/([^/]+)\/[^/]+$/, "/gate/$1")}?cli=claude`;
    const hook = async (tool_name: string, tool_input: Record<string, unknown>) => {
      const response = await fetch(gate, {
        method: "POST",
        headers: { "content-type": "application/json", "x-seat": id },
        body: JSON.stringify({ tool_name, tool_input, cwd }),
      });
      return response.text();
    };
    return { agent, inbox, call: tool, mail: (args) => tool("seatwork_mail", args), hook };
  }

  const turnEnds = (who: TestSeat, text: string) =>
    call(
      "on agent.turn_ended",
      {
        agent: who.agent,
        turnId: null,
        outcome: { kind: "completed" },
        timeline: [{ type: "assistant_message", text }],
      },
      context,
    );

  /** Lets the app start `next` as the successor of `who`, and read and archive `who`, as a rotation needs. */
  const rotatable = (who: TestSeat, next: string, cwd: string) => {
    Object.assign(context.paseo.agents, {
      create: async (options: { parent?: string; title?: string }) => ({
        id: (await seat(next, who.agent.provider, options.parent ?? null, options.title ?? "", cwd)).agent.id,
      }),
    });
    Object.assign(agents[who.agent.id], {
      current: () => ({ status: "idle", provider: who.agent.provider, model: "claude-sonnet-5-5", cwd }),
      archive: async () => {},
      timeline: { refetch: async () => ({ entries: [], agent: { pendingPermissions: [] } }) },
    });
  };

  return { agents, context, seat, turnEnds, rotatable };
}

/** A folder the room reads as a project of its own, so its seats share one work store. */
export function projectFolder(name: string): string {
  const folder = join(PROJECT, "..", name);
  mkdirSync(join(folder, ".seatwork"), { recursive: true });
  writeFileSync(join(folder, ".seatwork", "room.json"), "{}");
  return folder;
}

/** A git repository beside the project with a nine-line source file and a test, committed: where the seats start. */
export function parserRepo(name: string): string {
  const dir = join(PROJECT, "..", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "src", "parse.js"),
    Array.from({ length: 9 }, (_, i) => `const n${i} = ${i};`).join("\n") + "\n",
  );
  writeFileSync(join(dir, "test", "a.test.ts"), 'test("a", () => expect(1).toBe(1));\n');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-qm", "start"],
  ])
    execFileSync("git", args, { cwd: dir, env });
  return dir;
}
