import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT } from "./support/room";
import type { fakeServer } from "./support/server";

/** A seat made through the plugin's hooks: its inbox, and a caller of the room's tools over its own MCP server. */
export interface TestSeat {
  agent: { id: string; parentAgentId: string | null; provider: string; cwd: string; title: string; workspaceId: null };
  inbox: string[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  mail(args: Record<string, unknown>): Promise<string>;
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
    return { agent, inbox, call: tool, mail: (args) => tool("seatwork_mail", args) };
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

  return { agents, context, seat, turnEnds };
}

/** A folder the room reads as a project of its own, so its seats share one work store. */
export function projectFolder(name: string): string {
  const folder = join(PROJECT, "..", name);
  mkdirSync(join(folder, ".seatwork"), { recursive: true });
  writeFileSync(join(folder, ".seatwork", "room.json"), "{}");
  return folder;
}
