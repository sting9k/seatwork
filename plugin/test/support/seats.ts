import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoWith } from "./git";
import { PROJECT } from "./room";
import type { fakeServer } from "./server";

/** A seat made through the plugin's hooks: its inbox and prompt, a caller of the room's tools over its own MCP server and the tools it is listed, what seatwork_inbox hands it, and its Claude hook's question to the guard. */
export interface TestSeat {
  agent: { id: string; parentAgentId: string | null; provider: string; cwd: string; title: string; workspaceId: null };
  inbox: string[];
  prompt: string;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  listed(): Promise<string[]>;
  mail(args: Record<string, unknown>): Promise<string>;
  held(): Promise<string>;
  adopt(agentId: string): Promise<string>;
  hook(tool: string, input: object, cwd?: string): Promise<string>;
}

/** The seats of a room served through `call`: the app's handles of them, the context the hooks are given, and the verbs a test needs. */
export function roomSeats(call: ReturnType<typeof fakeServer>["call"]) {
  const agents: Record<string, object> = {};
  /** What the daemon lists of the stand-in agents: every one not archived. */
  const listed = async () => ({
    entries: Object.entries(agents).flatMap(([id, handle]) => {
      const now = (handle as { current?: () => { archivedAt?: string } | null }).current?.();
      return now && !now.archivedAt ? [{ agent: { id, updatedAt: new Date().toISOString(), ...now } }] : [];
    }),
  });
  const context = {
    paseo: {
      agents: { ref: (id: string) => agents[id], list: listed },
      projects: { list: async () => ({ projects: [] }) },
    },
  };

  async function seat(
    id: string,
    provider: string,
    parent: string | null,
    title: string,
    cwd = PROJECT,
  ): Promise<TestSeat> {
    const made = (await call("before agent.create", { request: { config: { provider, cwd, title }, env: {} } })) as {
      env: Record<string, string>;
      config: { systemPrompt: string; mcpServers: { seatwork: { url: string } } };
    };
    await call("before agent.session_open", { request: { env: made.env, reason: "create", agentId: id, provider } });
    const inbox: string[] = [];
    agents[id] = {
      refresh: async () => {},
      current: () => ({ status: "idle", provider }),
      send: async (text: string) => void inbox.push(text),
    };
    const agent = { id, parentAgentId: parent, provider, cwd, title, workspaceId: null };
    await call("on agent.created", { agent }, context);
    const { url } = made.config.mcpServers.seatwork;
    const post = (to: string, body: object, headers: Record<string, string> = {}) =>
      fetch(to, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const rpc = async (method: string, params?: object) =>
      ((await (await post(url, { jsonrpc: "2.0", id: 1, method, params })).json()) as { result: any }).result;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await rpc("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return result.content[0].text as string;
    };
    const gate = `${url.replace(/\/mcp\/([^/]+)\/[^/]+$/, "/gate/$1")}?cli=claude`;
    return {
      agent,
      inbox,
      prompt: made.config.systemPrompt,
      call: tool,
      listed: async () => (await rpc("tools/list")).tools.map((entry: { name: string }) => entry.name),
      mail: (args) => tool("seatwork_mail", args),
      held: () => tool("seatwork_inbox", {}),
      adopt: (agentId) => tool("seatwork_adopt", { agent_id: agentId }),
      hook: async (tool_name, tool_input, at = cwd) =>
        (await post(gate, { tool_name, tool_input, cwd: at }, { "x-seat": id })).text(),
    };
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

  const fails = (who: TestSeat, message: string) =>
    call(
      "on agent.turn_ended",
      { agent: who.agent, turnId: null, outcome: { kind: "failed", error: { message } }, timeline: [] },
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

  return { agents, context, seat, turnEnds, fails, rotatable };
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
  return repoWith(join(PROJECT, "..", name), {
    "src/parse.js": Array.from({ length: 9 }, (_, i) => `const n${i} = ${i};`).join("\n") + "\n",
    "test/a.test.ts": 'test("a", () => expect(1).toBe(1));\n',
  });
}
