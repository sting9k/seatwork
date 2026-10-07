import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { Collector } from "./server/gc";
import { MailEngine, type Mail, type Priority, type Needs } from "./server/mail";
import { McpHttpServer } from "./server/mcp-http";
import { PASEO_CONFIG, REGISTRY_LOG, ROOM_HOME, TOKEN_FILE } from "./server/paths";
import { loadPolicy } from "./server/policy";
import { findProject, findRoomMarker, loadRegistry, projectBlock } from "./server/registry";
import { describeIsolation, ensureRuntime, envFor } from "./server/runtimes";
import { enabledSeats, parseSeat, rolePrompt, specFromTitle, type Role } from "./server/seats";

type CreateRequest = PluginBeforeRequests["agent.create"];

const VERSION = "0.3.0";
const MAIL_DIR = join(ROOM_HOME, "mail");
const MCP_TOKEN_FILE = join(MAIL_DIR, "token");
const NONCES_FILE = join(MAIL_DIR, "nonces.json");

/**
 * slp-seat: the room's hooks into Paseo.
 *
 *  before agent.create        a seat (`<harness>-<role>` provider) gets its isolated
 *                             runtime, the rendered role prompt, the project block and
 *                             the room's MCP server (slp_mail, slp_inbox). Refused when
 *                             the seat is not enabled or the cwd is not a registered project.
 *  before agent.session_open  binds the seat's MCP nonce to its agent id.
 *  on agent.created           enforces room.spawn and records the seat in the registry log.
 *  on agent.turn_ended / permission_requested
 *                             become mail to the parent; the engine delivers it when the
 *                             parent is idle, never by interrupting.
 *  on agent.archived          bounces held mail, forgets the nonce, deletes heartbeats.
 *  every gc.everyMinutes      archives idle seats and orphan heartbeats (gc.ts).
 */
export default function contribute(server: PluginServerContext) {
  mkdirSync(MAIL_DIR, { recursive: true });
  const policy = loadPolicy();
  try {
    const seats = enabledSeats();
    for (const seat of seats) ensureRuntime(seat, policy);
    console.log(`slp-seat ${VERSION}: ${seats.length} seats enabled (${seats.map((s) => s.provider).join(", ")}); runtimes under ${ROOM_HOME}/runtimes`);
    console.log(`slp-seat: isolation: ${describeIsolation()}`);
  } catch (error) {
    console.error("slp-seat: building runtimes failed; they will be retried per seat", error);
  }

  // ---- mail engine + MCP server (one per daemon, fixed port so URLs survive reloads)
  let engine: MailEngine | null = null;
  const token = loadOrCreateToken();
  const mcp = new McpHttpServer(token, "slp-seat", VERSION);
  let port = policy.mail.port;
  const nonces = loadNonces();
  const log = (m: string) => console.log(`slp-seat: ${m}`);
  const getEngine = (paseo: Parameters<Parameters<typeof server.on>[1]>[1]["paseo"]) => {
    if (!engine) engine = new MailEngine(paseo, policy.mail, policy.room, log);
    return engine;
  };
  let gc: Collector | null = null;
  const getGc = (paseo: Parameters<typeof getEngine>[0]) => {
    if (!gc) gc = new Collector(paseo, getEngine(paseo), policy.gc, log, forgetAgent);
    return gc;
  };

  mcp.register(
    {
      name: "slp_mail",
      description:
        "Write to another seat of your room. To answer a mail you received, pass reply_to: its id (the #id in its header) and no `to`; the answer goes to whoever sent it. To start a new thread, pass `to`: `owner` (the seat that launched you) or the id of a seat you launched. The plugin wraps it in an envelope and delivers it between the recipient's turns; it never interrupts anyone. Mail to an archived seat is refused.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "New thread: `owner` (the seat that launched you) or the id of a seat you launched. Omit when reply_to is given." },
          reply_to: { type: "string", description: "Id of the mail you are answering (the #id in its header). The recipient is that mail's sender; use this for every answer so it reaches the right seat." },
          subject: { type: "string", description: "Short subject, ideally starting with a protocol signal (QUESTION, CANDIDATE, ANSWER, ACCEPT, ...)." },
          body: { type: "string", description: "The message. Self-contained: the recipient may read it hours later." },
          needs: { type: "string", enum: ["reply", "decision", "nothing"], description: "What you need back." },
          priority: { type: "string", enum: ["blocking", "action", "fyi"], description: "Suggested priority; the plugin may raise or lower it." },
        },
        required: ["subject", "body"],
      },
    },
    async (args, context) => {
      if (!engine) throw new Error("mail engine not ready (no room seat has been created on this daemon yet)");
      const from = resolveCaller(context.nonce);
      if (!from) throw new Error("slp_mail: this session is not a registered room seat (unknown caller)");
      const replyTo = String(args.reply_to ?? "").trim().replace(/^#/, "");
      let to: string;
      let viaReply = false;
      if (replyTo) {
        const ref = engine.lookupMail(replyTo);
        if (!ref) throw new Error(`slp_mail: no mail #${replyTo} is known; copy the id from the mail header`);
        if (ref.to !== from) throw new Error(`slp_mail: mail #${replyTo} was not addressed to you; you can only answer your own mail`);
        if (ref.from === "room") throw new Error(`slp_mail: #${replyTo} is a notice from the room; nobody waits for an answer`);
        to = ref.from;
        viaReply = true;
      } else {
        const rawTo = String(args.to ?? "").trim().replace(/^(hq|supervisor|lead|peer):/i, "");
        to = /^(owner|parent|human)$/i.test(rawTo) ? engine.parentOf(from) ?? "" : rawTo;
        if (!to) throw new Error(`slp_mail: ${rawTo === "" ? "give `to` (owner, or a seat you launched) or reply_to" : "you have no parent seat; the Owner reads your final message, no mail is needed"}`);
      }
      const check = engine.canWrite(from, to, viaReply);
      if (!check.ok) throw new Error(`slp_mail refused: ${check.reason}`);
      if ((await engine.recipientStatus(to)) === "gone") throw new Error(`slp_mail refused: ${to} is archived or gone; nothing was sent`);
      const sender = engine.seat(from)!;
      const recipient = engine.seat(to)!;
      const subject = String(args.subject ?? "").trim() || "(no subject)";
      const body = String(args.body ?? "");
      const needs = (["reply", "decision", "nothing"].includes(String(args.needs)) ? args.needs : "nothing") as Needs;
      const suggested = (["blocking", "action", "fyi"].includes(String(args.priority)) ? args.priority : undefined) as Priority | undefined;
      const priority = classifyAgentMail({ senderRole: sender.role, recipientRole: recipient.role, subject, needs, suggested });
      const mail = await engine.post({
        from: { agentId: from, role: sender.role },
        to,
        priority,
        subject,
        body,
        needs,
        whyNow: whyNowFor(engine.isAncestor(from, to) ? "owner" : sender.role, needs),
      });
      const held = engine.held(to).some((m) => m.id === mail.id);
      return `sent #${mail.id} to ${engine.isAncestor(to, from) ? "owner" : `${recipient.role} ${to}`} as ${priority}; ${held ? "held until the recipient can take it" : "delivered"}. Continue your work; do not wait for a reply unless needs=decision blocks you.`;
    },
  );

  mcp.register(
    {
      name: "slp_inbox",
      description: "Read the mail the plugin is holding for you (fyi mail that arrived while you were busy). Returns and clears it.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    async (_args, context) => {
      if (!engine) throw new Error("mail engine not ready");
      const me = resolveCaller(context.nonce);
      if (!me) throw new Error("slp_inbox: unknown caller");
      const mails = engine.takeHeld(me);
      if (mails.length === 0) return "inbox empty";
      return mails.map((m) => formatForInbox(m)).join("\n\n");
    },
  );

  mcp.register(
    {
      name: "slp_adopt",
      description:
        "Take over a seat handed to you (a handoff): from now on it reports to you, its `to: owner` reaches you, and you may mail it. Allowed only for a role you may create, and only when its current owner is archived or sits in your own chain. Then mail it its brief and your disposition of its last signal.",
      inputSchema: {
        type: "object",
        properties: { agent_id: { type: "string", description: "Id of the seat to adopt (from the handoff)." } },
        required: ["agent_id"],
      },
    },
    async (args, context) => {
      if (!engine) throw new Error("mail engine not ready");
      const me = resolveCaller(context.nonce);
      if (!me) throw new Error("slp_adopt: unknown caller");
      const child = String(args.agent_id ?? "").trim().replace(/^(hq|supervisor|lead|peer|lens):/i, "");
      if (!child) throw new Error("slp_adopt: give agent_id");
      const result = await engine.adopt(me, child);
      if (!result.ok) throw new Error(`slp_adopt refused: ${result.reason}`);
      const seat = engine.seat(child)!;
      if (result.previous !== me) {
        await engine.post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: child,
          priority: "fyi",
          subject: "OWNER CHANGED: you were handed over",
          body: "Your Owner seat changed. Mail addressed `to: owner`, your final messages and your permission requests now reach the new Owner; answer its mail with reply_to as usual. Your brief stands until the new Owner writes; continue your current work.",
          needs: "nothing",
          whyNow: "a handoff moved you under a new Owner",
        });
      }
      return `adopted ${seat.role} ${child} (${seat.title ?? ""}); it now reports to you. Mail it its brief and your disposition of its last signal.`;
    },
  );

  const starting = mcp
    .listen(port)
    .then((bound) => {
      port = bound;
      log(`mail MCP server on 127.0.0.1:${port}`);
    })
    .catch((error) => {
      console.error(`slp-seat: mail MCP server failed to listen on ${port}; slp_mail unavailable`, error);
    });

  // ---- hooks
  server.before("agent.create", async ({ request }) => {
    await starting;
    return applySeat(request);
  });

  // agent.create hands out the nonce (in the MCP URL and in env.SLP_NONCE); session_open
  // is the first hook that knows the agent id, so the link is made here, never guessed.
  server.before("agent.session_open", ({ request }) => {
    const nonce = request.env?.SLP_NONCE;
    if (nonce && request.reason === "create" && nonces[nonce] !== request.agentId) {
      nonces[nonce] = request.agentId;
      saveNonces(nonces);
    }
    return request;
  });

  server.on("agent.created", async (event, { paseo }) => {
    const seat = parseSeat(event.agent.provider);
    // spawn rules: a seat may only create the roles policy.room.spawn allows, never a non-room provider
    const parentId = event.agent.parentAgentId;
    const parent = parentId ? getEngine(paseo).seat(parentId) : undefined;
    if (parent) {
      const allowed = policy.room.spawn[parent.role] ?? [];
      const childRole = seat?.role;
      if (!childRole || !allowed.includes(childRole)) {
        const what = seat ? `a ${seat.role} seat` : `a non-room agent (provider ${event.agent.provider})`;
        log(`spawn refused: ${parent.role} ${parentId} created ${what} ${event.agent.id}; archiving it`);
        try {
          await paseo.agents.ref(event.agent.id).archive();
        } catch (error) {
          log(`spawn refused: could not archive ${event.agent.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        await getEngine(paseo).post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: parentId!,
          priority: "blocking",
          subject: `SPAWN REFUSED: a ${parent.role} may create only ${allowed.length ? allowed.join(", ") : "nothing"}`,
          body: `You created ${what} titled "${event.agent.title ?? ""}". The room archived it at once; nothing ran. Create only the roles your role allows (${allowed.length ? allowed.join(", ") : "none"}), on the room's providers, and continue.`,
          needs: "nothing",
          whyNow: "a seat you created was outside the room's spawn rules",
        });
        return;
      }
    }
    if (!seat) return;
    getEngine(paseo).rememberSeat({ agentId: event.agent.id, parentAgentId: event.agent.parentAgentId, role: seat.role, provider: seat.provider, title: event.agent.title });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      agentId: event.agent.id,
      parentAgentId: event.agent.parentAgentId,
      provider: seat.provider,
      role: seat.role,
      cwd: event.agent.cwd,
      title: event.agent.title,
    });
    try {
      appendFileSync(REGISTRY_LOG, `${line}\n`);
    } catch (error) {
      console.error("slp-seat: cannot append registry log", error);
    }
  });

  // Any turn start wakes the engine and the collector, so both work right after a
  // plugin reload (the API hands us the Paseo client only inside hook contexts).
  server.on("agent.turn_started", (_event, { paseo }) => {
    getGc(paseo);
  });

  server.on("agent.archived", async (event, { paseo }) => {
    await getGc(paseo).onArchived(event.agent.id);
  });

  server.on("agent.turn_ended", async (event, { paseo }) => {
    const eng = getEngine(paseo);
    const seat = parseSeat(event.agent.provider);
    // whoever finished a turn may now take held mail
    await eng.deliver(event.agent.id);
    const parentId = eng.parentOf(event.agent.id) ?? event.agent.parentAgentId;
    if (!seat || !parentId || event.outcome.kind === "canceled") return;
    const parent = eng.seat(parentId);
    if (!parent) return;
    const text = lastAssistantText(event.timeline);
    const signal = signalOf(text);
    let priority: Priority;
    let subject: string;
    let needs: Needs;
    if (event.outcome.kind === "failed") {
      priority = "blocking";
      subject = `FAILED: ${event.outcome.error.message.slice(0, 120)}`;
      needs = "decision";
    } else if (signal && signal !== "STATUS") {
      priority = "action";
      subject = `${signal} from ${seat.role} ${event.agent.title ?? event.agent.id}`;
      needs = ["QUESTION", "BLOCKED", "DECISION_NEEDED", "REOPEN_REQUEST", "DEPENDENCY_REQUEST"].includes(signal) ? "decision" : "reply";
    } else {
      priority = "fyi";
      subject = `${signal ?? "turn ended"}: ${seat.role} ${event.agent.title ?? event.agent.id}`;
      needs = "nothing";
    }
    // HQ hears only from a Supervisor, and only when there is something to act on.
    if (parent.role === "hq" && (seat.role !== "supervisor" || priority === "fyi")) return;
    await eng.post({
      from: { agentId: event.agent.id, role: seat.role },
      to: parentId,
      priority,
      subject,
      body: text || `(no final message; outcome ${event.outcome.kind})`,
      needs,
      whyNow: event.outcome.kind === "failed" ? "the seat's turn failed; its work is stopped" : `the seat ended its turn with ${signal ?? "a progress message"}`,
    });
  });

  server.on("agent.permission_requested", async (event, { paseo }) => {
    const eng = getEngine(paseo);
    const seat = parseSeat(event.agent.provider);
    const parentId = eng.parentOf(event.agent.id) ?? event.agent.parentAgentId;
    if (!seat || !parentId || !eng.seat(parentId)) return;
    await eng.post({
      from: { agentId: event.agent.id, role: seat.role },
      to: parentId,
      priority: "blocking",
      subject: `PERMISSION: ${seat.role} ${event.agent.title ?? event.agent.id} is waiting for approval`,
      body: JSON.stringify(event.request).slice(0, 2000),
      needs: "decision",
      whyNow: "the seat is stopped until someone answers with respond_to_permission",
    });
  });

  // safety net: anything still held gets another delivery attempt every minute
  const sweep = setInterval(() => {
    void engine?.sweep();
  }, 60_000);
  // garbage collection: idle seats and orphan heartbeats
  const collect = setInterval(() => {
    void gc?.run();
  }, Math.max(1, policy.gc.everyMinutes) * 60_000);

  return async () => {
    clearInterval(sweep);
    clearInterval(collect);
    await mcp.close();
  };

  /* ---------- helpers bound to this plugin instance ---------- */

  function applySeat(request: CreateRequest): CreateRequest {
    const seat = parseSeat(request.config.provider);
    if (!seat) return request;
    if (!enabledSeats().some((s) => s.provider === seat.provider)) {
      throw new Error(`slp-seat: ${seat.provider} is not enabled in paseo/seats.yml (enable it there and re-run install.sh)`);
    }

    const registry = loadRegistry();
    const cwd = request.config.cwd;
    let project: { name: string; root: string; mission: string | null; law: string | null } | null = null;

    if (registry) {
      if (seat.role === "hq") {
        if (registry.hq && !isInside(cwd, registry.hq)) {
          throw new Error(`slp-seat: an hq seat may only be created in ${registry.hq}, not in ${cwd}`);
        }
      } else {
        const match = findProject(registry, cwd);
        if (!match) {
          const names = registry.projects.map((p) => `${p.name} (${p.cwd})`).join(", ") || "none";
          throw new Error(`slp-seat: ${seat.provider} refused: ${cwd} is not a registered SLP project. Registered: ${names}`);
        }
        project = { name: match.entry.name, root: match.root, mission: match.mission, law: match.law };
      }
    } else if (seat.role !== "hq") {
      const marker = findRoomMarker(cwd);
      if (marker) project = { name: marker.root.split("/").pop() ?? marker.root, root: marker.root, mission: marker.mission, law: marker.law };
    }

    let dir: string | null = null;
    try {
      dir = ensureRuntime(seat);
    } catch (error) {
      console.error(`slp-seat: runtime for ${seat.provider} unavailable, launching on the shared home`, error);
    }

    const env: Record<string, string> = { ...(request.env ?? {}), ...(dir ? envFor(seat.harness, dir) : {}) };
    if (seat.harness === "claude" && dir) {
      const tok = claudeToken();
      if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
      else console.error("slp-seat: no Claude token found (~/.config/slp-room/oauth-token or the claude provider env); the seat may fail to authenticate");
    }

    // the room's MCP server; agent.session_open ties this nonce to the agent id
    const nonce = randomBytes(9).toString("base64url");
    env.SLP_NONCE = nonce;
    const mcpServers = {
      ...(request.config.mcpServers ?? {}),
      slp: { type: "http" as const, url: mcp.urlFor(port, nonce), alwaysLoad: true },
    };

    const featureSpec = (request.config.featureValues as { slpSpec?: unknown } | undefined)?.slpSpec;
    const spec = specFromTitle(request.config.title) ?? (typeof featureSpec === "string" ? featureSpec : undefined);
    const parts = [
      rolePrompt(seat.role, { harness: seat.harness, spec, params: policy.room.params }),
      project ? projectBlock(project.name, project.root, project.mission, project.law) : null,
      request.config.systemPrompt,
    ];
    const systemPrompt = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
    return { ...request, env, config: { ...request.config, systemPrompt, mcpServers } };
  }

  function resolveCaller(nonce: string): string | null {
    return nonces[nonce] ?? null;
  }

  /** An archived seat can never call slp_mail again: drop its nonce. */
  function forgetAgent(agentId: string): void {
    const stale = Object.keys(nonces).filter((nonce) => nonces[nonce] === agentId);
    if (stale.length === 0) return;
    for (const nonce of stale) delete nonces[nonce];
    saveNonces(nonces);
  }
}

/* ---------- classification ---------- */

const SIGNAL = /\b(DONE|DECISION_NEEDED|BLOCKED|REOPEN_REQUEST|DEPENDENCY_REQUEST|QUESTION|CANDIDATE|REVIEW|STATUS)\b/;

/** The protocol signal of a final message. The role prompts put it on the first line; the whole text is the fallback. */
function signalOf(text: string): string | undefined {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  return SIGNAL.exec(firstLine)?.[1] ?? SIGNAL.exec(text)?.[1];
}

function classifyAgentMail(input: { senderRole: Role; recipientRole: Role; subject: string; needs: Needs; suggested?: Priority }): Priority {
  const s = input.subject.toUpperCase();
  // a Lead answering a Peer that is stuck must reach it at once
  if (/\b(ANSWER|REVISED BRIEF|HOLD|REJECT)\b/.test(s) && input.recipientRole === "peer") return "blocking";
  if (/\b(ACCEPT|DEFER)\b/.test(s) && input.recipientRole === "peer") return "action";
  if (/\b(PERMISSION|FAILED|BLOCKED)\b/.test(s)) return "blocking";
  if (input.needs === "decision") return "action";
  if (/\b(QUESTION|CANDIDATE|REVIEW|REOPEN_REQUEST|DEPENDENCY_REQUEST|DECISION_NEEDED|DONE)\b/.test(s)) return "action";
  if (input.suggested) return input.suggested === "blocking" ? "action" : input.suggested; // a seat cannot demand blocking
  return input.needs === "reply" ? "action" : "fyi";
}

function whyNowFor(sender: Role | "owner", needs: Needs): string {
  if (needs === "decision") return `${sender} cannot proceed on this point without your decision`;
  if (needs === "reply") return `${sender} is waiting for your answer to continue; it keeps working on other parts meanwhile`;
  return `${sender} is informing you; nothing is waiting on you`;
}

function lastAssistantText(timeline: readonly unknown[]): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i] as Record<string, unknown>;
    const type = String(item.type ?? "");
    const role = String(item.role ?? "assistant");
    if (!/assistant|message|text/i.test(type) || role !== "assistant") continue;
    const text = item.text ?? item.content ?? item.message;
    if (typeof text === "string" && text.trim()) return text.trim();
    if (Array.isArray(text)) {
      const joined = text
        .map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : ""))
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

function formatForInbox(mail: Mail): string {
  return `#${mail.id} ${mail.priority.toUpperCase()} from ${mail.fromLabel ?? `${mail.from.role}:${mail.from.agentId}`} re: ${mail.subject}\nneeds: ${mail.needs}\n${mail.body.trim()}`;
}

/* ---------- small persistence helpers ---------- */

function loadOrCreateToken(): string {
  if (existsSync(MCP_TOKEN_FILE)) {
    const existing = readFileSync(MCP_TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(18).toString("base64url");
  writeFileSync(MCP_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

function loadNonces(): Record<string, string> {
  if (!existsSync(NONCES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(NONCES_FILE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveNonces(nonces: Record<string, string>): void {
  writeFileSync(NONCES_FILE, `${JSON.stringify(nonces, null, 2)}\n`, { mode: 0o600 });
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

let tokenCache: { value: string | null; at: number } | null = null;

/** The shared Claude token: the room's token file first, else the base claude provider's env. */
function claudeToken(): string | null {
  if (tokenCache && Date.now() - tokenCache.at < 60_000) return tokenCache.value;
  let value: string | null = null;
  if (existsSync(TOKEN_FILE)) {
    value = readFileSync(TOKEN_FILE, "utf8").trim() || null;
  }
  if (!value && existsSync(PASEO_CONFIG)) {
    try {
      const config = JSON.parse(readFileSync(PASEO_CONFIG, "utf8")) as {
        agents?: { providers?: Record<string, { env?: Record<string, string> }> };
      };
      value = config.agents?.providers?.claude?.env?.CLAUDE_CODE_OAUTH_TOKEN?.trim() || null;
    } catch {
      value = null;
    }
  }
  tokenCache = { value, at: Date.now() };
  return value;
}
