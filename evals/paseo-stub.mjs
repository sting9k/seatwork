#!/usr/bin/env node
// Paseo's agent tools for a seat under test, over stdio MCP: each call goes to the run's control address, where the room answers it.
import { createInterface } from "node:readline";

const control = process.env.EVAL_CONTROL_URL;
const shown = new Set((process.env.EVAL_PASEO_TOOLS ?? "").split(",").filter(Boolean));

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });
const text = (description) => ({ type: "string", description });

/** The Paseo tools a room seat is given, with the arguments the room's prompts name. */
const TOOLS = {
  create_agent: {
    description: "Create an agent: a title, a provider, the brief as initialPrompt, and its settings.",
    inputSchema: object(
      {
        title: text("The agent's title."),
        provider: text("provider/model, such as claude-peer/claude-sonnet-5-5."),
        initialPrompt: text("The first prompt: the brief."),
        cwd: text("The folder it works in; your own by default."),
        settings: object({ modeId: text("Its permission mode."), thinkingOptionId: text("Its thinking level.") }),
        notifyOnFinish: { type: "boolean", description: "Whether you are told when its turn ends." },
      },
      ["title", "provider", "initialPrompt"],
    ),
  },
  list_agents: { description: "The agents you created, with their status.", inputSchema: object({}) },
  get_agent_status: {
    description: "One agent's status.",
    inputSchema: object({ agentId: text("Its id.") }, ["agentId"]),
  },
  get_agent_activity: {
    description: "An agent's recent activity.",
    inputSchema: object({ agentId: text("Its id.") }, ["agentId"]),
  },
  send_agent_prompt: {
    description: "Send an agent a prompt.",
    inputSchema: object({ agentId: text("Its id."), prompt: text("What to send.") }, ["agentId", "prompt"]),
  },
  cancel_agent: {
    description: "End an agent's running turn.",
    inputSchema: object({ agentId: text("Its id.") }, ["agentId"]),
  },
  archive_agent: { description: "Archive an agent.", inputSchema: object({ agentId: text("Its id.") }, ["agentId"]) },
  list_models: {
    description: "The models a provider offers.",
    inputSchema: object({ provider: text("The provider.") }),
  },
  list_providers: { description: "The providers set up.", inputSchema: object({}) },
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** One tool call answered by the run's control address: its text, and whether it is a refusal. */
async function answer(name, args) {
  const response = await fetch(control, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: name, args }),
  });
  return response.json();
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize")
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo", version: "0" },
      },
    });
  if (method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: Object.entries(TOOLS)
          .filter(([name]) => shown.has(name))
          .map(([name, tool]) => ({ name, ...tool })),
      },
    });
  if (method === "tools/call") {
    const name = params?.name;
    if (!shown.has(name))
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `no tool ${name}` }], isError: true },
      });
    try {
      const done = await answer(name, params?.arguments ?? {});
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: done.text }], isError: !!done.error },
      });
    } catch (error) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(error) }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
});
