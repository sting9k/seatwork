#!/usr/bin/env node
// Stand-in for the room's `slp` MCP server and for Paseo's agent tools, one process per server
// (SLP_EVAL_SERVER = slp | paseo). It shows the tools named in SLP_EVAL_TOOLS, answers every call with a
// plausible result drawn from SLP_EVAL_STATE (a JSON file), and appends each call to SLP_EVAL_LOG.
// Nothing it says is real: evals grade what the seat tried to do, not what happened.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const server = process.env.SLP_EVAL_SERVER ?? "slp";
const shown = new Set((process.env.SLP_EVAL_TOOLS ?? "").split(",").filter(Boolean));
const state = process.env.SLP_EVAL_STATE ? JSON.parse(readFileSync(process.env.SLP_EVAL_STATE, "utf8")) : {};
const agents = [...(state.agents ?? [])];
// the registry as slp_projects prints it; a registration rewrites its project's line, so a seat that looks again sees what it did
let projects = state.projects ? String(state.projects).split("\n") : [];
// the seats every install has (paseo/seats.yml); the real tool sets up any other seat a table names, and says so
const ROOM_SEATS = ["claude-hq", "claude-supervisor", "claude-lead", "claude-peer", "claude-lens", "codex-peer", "codex-lens"];
let counter = 0;
const next = (prefix) => `${prefix}${++counter}`;
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });
const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const json = (value) => JSON.stringify(value, null, 2);
const findAgent = (id) => agents.find((a) => a.id === id || a.id === String(id).replace(/^[a-z]+:/, ""));

const TOOLS = {
  slp_mail: {
    description:
      "Write to another seat of your room. To answer a mail you received, pass reply_to: its id (the #id in its header) and no `to`; the answer goes to whoever sent it. To start a new thread, pass `to`: `owner` (the seat that launched you) or the id of a seat you launched. The plugin wraps it in an envelope and delivers it between the recipient's turns; it never interrupts anyone.",
    inputSchema: object(
      {
        to: string("New thread: `owner` (the seat that launched you) or the id of a seat you launched. Omit when reply_to is given."),
        reply_to: string("Id of the mail you are answering (the #id in its header). The recipient is that mail's sender; use this for every answer so it reaches the right seat."),
        subject: string("Short subject, ideally starting with a protocol signal (QUESTION, CANDIDATE, ANSWER, ACCEPT, ...)."),
        body: string("The message. Self-contained: the recipient may read it hours later."),
        needs: string("What you need back.", { enum: ["reply", "decision", "nothing"] }),
        priority: string("Suggested priority; the plugin may raise or lower it.", { enum: ["blocking", "action", "fyi"] }),
      },
      ["subject", "body"],
    ),
    call: (a) => {
      if (!a.to && !a.reply_to) throw new Error("slp_mail: give `to` for a new thread or `reply_to` for an answer");
      return `sent #${next("m")} ${a.reply_to ? `in answer to #${String(a.reply_to).replace(/^#/, "")}` : `to ${a.to}`}; delivered between the recipient's turns`;
    },
  },
  slp_inbox: {
    description: "Read the mail the plugin is holding for you (fyi mail that arrived while you were busy). Returns and clears it.",
    inputSchema: object({}),
    call: () => "inbox empty",
  },
  slp_adopt: {
    description: "Take over a seat handed to you (a handoff): from now on it reports to you, its `to: owner` reaches you, and you may mail it. Allowed only for a role you may create, and only when its current owner is archived or in your chain.",
    inputSchema: object({ agent_id: string("Id of the seat to adopt (from the handoff).") }, ["agent_id"]),
    call: (a) => `adopted ${a.agent_id}: it now reports to you`,
  },
  slp_projects: {
    description: "The project registry, one line per project known to Paseo: registered or not, name, root, whether its mission and law exist, its model table (default or custom) and the Supervisor seat to use.",
    inputSchema: object({}),
    call: () => projects.join("\n") || "no projects known to Paseo",
  },
  slp_register_project: {
    description:
      "Register a project that Paseo already has: writes its room marker, its mission and its own model table when given, and its registry line. A seat the table names that the room does not have yet is set up first. Repeat it with `mission` or `models` to replace them.",
    inputSchema: object(
      {
        path: string("The project's root, or its name in Paseo (see slp_projects)."),
        name: string("Registry name, letters digits dashes. Default: the Paseo name."),
        mission: string("What the project is for and what done looks like, a few lines of markdown."),
        models: { type: "object", description: "Only the differences from ROOM_DIR/models.json, same shape; objects merge, lists and values replace, null removes a key. Omit to use the room's table." },
      },
      ["path"],
    ),
    call: (a) => {
      const at = projects.findIndex((row) => row.includes(` | ${a.path} | `));
      const [, roomSupervisor = "claude-supervisor/claude-opus-5-5", roomThinking = "high"] = /supervisor: (\S+) thinking (\S+)/.exec(projects[at] ?? "") ?? [];
      const name = a.name ?? String(a.path).split("/").filter(Boolean).pop() ?? "project";
      const supervisor = a.models?.seats?.supervisor ?? {};
      const table = `models: ${a.models ? "custom" : "default"} | supervisor: ${supervisor.provider ?? roomSupervisor} thinking ${supervisor.thinking ?? roomThinking}`;
      const named = JSON.stringify(a.models ?? {}).match(/\b(claude|codex|pi|opencode)-(hq|supervisor|lead|peer|lens)(?=\/)/g) ?? [];
      const added = [...new Set(named)].filter((seat) => !ROOM_SEATS.includes(seat));
      const row = `registered as ${name} | ${name} | ${a.path} | mission: ${a.mission ? "yes" : "no"} | law: no | ${table}`;
      if (at >= 0) projects[at] = row;
      else projects.push(row);
      return `registered: ${name} at ${a.path}. ${table}.${added.length ? ` Seats set up for this table: ${added.join(", ")}.` : ""} Still missing: law (.slp/${name}-law.md, written by the project's Supervisor on its first task).`;
    },
  },
  slp_room_stats: {
    description: "What the mail log says happened in the last N days, per project and per signal (candidates, rejects, reopen requests, escalations).",
    inputSchema: object({ days: { type: "number", description: "How many days back; default 14." } }),
    call: (a) => state.roomStats ?? `no mail in the last ${a.days ?? 14} days`,
  },
  create_agent: {
    description: "Create an agent. Agent-scoped creation defaults to your workspace and creates your subagent. Pass title, provider (<provider>/<model>), settings (modeId, thinkingOptionId), initialPrompt, notifyOnFinish; workspaceId only to place it elsewhere.",
    inputSchema: object(
      {
        title: string("Shown in the agent list."),
        provider: string("Provider id, optionally with /<model>."),
        settings: { type: "object", description: "modeId and thinkingOptionId for the provider.", properties: { modeId: string(""), thinkingOptionId: string("") } },
        initialPrompt: string("The first prompt the agent receives; it starts working at once."),
        notifyOnFinish: { type: "boolean", description: "Whether the creator is notified when the agent's first turn ends." },
        workspaceId: string("Workspace to create the agent in; defaults to yours."),
        cwd: string("Legacy; prefer workspaceId."),
        background: { type: "boolean", description: "Legacy; prefer notifyOnFinish." },
      },
      ["title", "provider", "initialPrompt"],
    ),
    call: (a) => {
      const id = next("agent-new-");
      agents.push({ id, title: a.title, provider: a.provider, status: "running", parentAgentId: state.self ?? null });
      return json({ agentId: id, status: "running", title: a.title, provider: a.provider, workspaceId: a.workspaceId ?? "ws-self" });
    },
  },
  get_agent_status: {
    description: "Status of one agent: idle, running, error or closed, its title, provider, parent and pending permissions.",
    inputSchema: object({ agentId: string("") }, ["agentId"]),
    call: (a) => {
      const agent = findAgent(a.agentId);
      if (!agent) throw new Error(`Agent not found: ${a.agentId}`);
      return json({ agentId: agent.id, title: agent.title, provider: agent.provider, status: agent.status, parentAgentId: agent.parentAgentId ?? null, pendingPermissions: agent.pendingPermissions ?? [], updatedAt: agent.updatedAt ?? "2026-10-09T08:00:00Z" });
    },
  },
  get_agent_activity: {
    description: "The most recent activity of an agent, newest first: its last messages and tool calls.",
    inputSchema: object({ agentId: string(""), limit: { type: "number", description: "Optional limit for number of activities to include (most recent first)." } }, ["agentId"]),
    call: (a) => {
      const agent = findAgent(a.agentId);
      if (!agent) throw new Error(`Agent not found: ${a.agentId}`);
      return json({ agentId: agent.id, updateCount: 1, content: agent.lastReport ?? "(no activity yet)" });
    },
  },
  list_agents: {
    description: "List agents, newest first, with id, title, provider, status, parent and workspace.",
    inputSchema: object({ includeArchived: { type: "boolean" }, cwd: string("Only agents in this directory."), limit: { type: "number" } }),
    call: () => json({ agents: agents.map((x) => ({ agentId: x.id, title: x.title, provider: x.provider, status: x.status, parentAgentId: x.parentAgentId ?? null, cwd: x.cwd ?? state.cwd ?? null })) }),
  },
  cancel_agent: { description: "Stop the agent's current turn; the agent stays.", inputSchema: object({ agentId: string("") }, ["agentId"]), call: (a) => json({ success: true, agentId: a.agentId }) },
  archive_agent: { description: "Archive an agent; it stops and leaves the list.", inputSchema: object({ agentId: string("") }, ["agentId"]), call: (a) => json({ success: true, agentId: a.agentId }) },
  update_agent: { description: "Change an agent's title or labels.", inputSchema: object({ agentId: string(""), title: string("") }, ["agentId"]), call: (a) => json({ success: true, agentId: a.agentId }) },
  set_agent_mode: { description: "Switch an agent's provider mode.", inputSchema: object({ agentId: string(""), modeId: string("") }, ["agentId", "modeId"]), call: (a) => json({ success: true, agentId: a.agentId, modeId: a.modeId }) },
  create_heartbeat: {
    description: "Create a recurring prompt to yourself on a cron cadence. Returns the schedule id.",
    inputSchema: object({ prompt: string("Sent to you on every beat."), cron: string("Cron cadence, five fields."), name: string("Shown in the schedule list."), timezone: string("IANA time zone for the cron cadence.") }, ["prompt", "cron"]),
    call: (a) => json({ scheduleId: next("hb-"), name: a.name ?? null, cron: a.cron }),
  },
  delete_heartbeat: { description: "Delete a heartbeat by schedule id.", inputSchema: object({ scheduleId: string("") }, ["scheduleId"]), call: (a) => json({ success: true, scheduleId: a.scheduleId }) },
  list_schedules: { description: "List schedules and heartbeats.", inputSchema: object({}), call: () => json({ schedules: state.schedules ?? [] }) },
  inspect_schedule: { description: "Details of one schedule.", inputSchema: object({ scheduleId: string("") }, ["scheduleId"]), call: (a) => json((state.schedules ?? []).find((s) => s.scheduleId === a.scheduleId) ?? { error: "not found" }) },
  list_pending_permissions: {
    description: "Permission requests waiting on you from agents you created.",
    inputSchema: object({}),
    call: () => json({ permissions: state.permissions ?? [] }),
  },
  respond_to_permission: {
    description: "Answer a pending permission request of an agent you created.",
    inputSchema: object({ agentId: string(""), requestId: string(""), decision: string("allow or deny", { enum: ["allow", "deny"] }), message: string("Optional note to the agent.") }, ["agentId", "requestId", "decision"]),
    call: (a) => json({ success: true, agentId: a.agentId, requestId: a.requestId, decision: a.decision }),
  },
  create_workspace: {
    description: "Create a workspace: isolation local adopts an existing directory; worktree makes a git worktree on a new branch.",
    inputSchema: object({ isolation: string("", { enum: ["local", "worktree"] }), path: string("Local directory or source checkout."), projectId: string("Existing project id to own the workspace."), title: string(""), baseBranch: string(""), worktreeSlug: string("") }, ["isolation"]),
    call: (a) => json({ workspaceId: next("ws-"), isolation: a.isolation, path: a.path ?? state.cwd ?? null }),
  },
  list_workspaces: { description: "List workspaces with id, project and path.", inputSchema: object({}), call: () => json({ workspaces: state.workspaces ?? [] }) },
  list_models: { description: "Models a provider offers.", inputSchema: object({ provider: string("") }), call: () => "see the model table in your role prompt" },
  list_providers: { description: "Providers the daemon offers.", inputSchema: object({}), call: () => "see the model table in your role prompt" },
};

function log(entry) {
  if (!process.env.SLP_EVAL_LOG) return;
  appendFileSync(process.env.SLP_EVAL_LOG, `${JSON.stringify({ server, at: new Date().toISOString(), ...entry })}\n`);
}

const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = msg;
  if (method === "initialize") {
    return out({ id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `${server}-stub`, version: "0" } } });
  }
  if (id === undefined) return; // a notification
  if (method === "ping") return out({ id, result: {} });
  if (method === "tools/list") {
    const tools = [...shown].filter((name) => TOOLS[name]).map((name) => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema }));
    return out({ id, result: { tools } });
  }
  if (method === "tools/call") {
    const name = params.name;
    const input = params.arguments ?? {};
    const tool = shown.has(name) ? TOOLS[name] : undefined;
    if (!tool) return out({ id, error: { code: -32602, message: `unknown tool: ${name}` } });
    let text;
    let isError = false;
    try {
      text = tool.call(input);
    } catch (error) {
      text = error instanceof Error ? error.message : String(error);
      isError = true;
    }
    log({ name, input, result: text, isError });
    return out({ id, result: { content: [{ type: "text", text }], isError } });
  }
  return out({ id, error: { code: -32601, message: `method not found: ${method}` } });
});
