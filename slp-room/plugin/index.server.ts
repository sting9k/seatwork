import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { Collector } from "./server/gc";
import { MailEngine, type Mail, type Priority, type Needs } from "./server/mail";
import { checkHqPlacement, ensureHqProject } from "./server/hq";
import { McpHttpServer } from "./server/mcp-http";
import { REGISTRY_LOG, ROOM_HOME, WATCH_DIR } from "./server/paths";
import { describeProjects, registerProject } from "./server/onboard";
import { modelAllowed, projectModels, type Models } from "./server/models";
import { loadPolicy } from "./server/policy";
import { findProject, findRoomMarker, loadRegistry, projectBlock } from "./server/registry";
import { claudeRoleDir, describeIsolation, ensureRuntime, envFor, sharedClaudeFiles } from "./server/runtimes";
import { enabledSeats, maySpawn, parseSeat, rolePrompt, specFromTitle, type Role } from "./server/seats";
import { asksOwner, CLOSES_WORK, signalOf, subjectSignal } from "./server/signals";
import { roomStats } from "./server/stats";
import { Budget } from "./server/watch/budget";
import { calibrate, renderCalibration, type MailLine } from "./server/watch/calibrate";
import { snapshot } from "./server/watch/git";
import { JevEngine } from "./server/watch/jev";
import { REVISION } from "./server/watch/questions";
import { ScanLog } from "./server/watch/scanlog";
import { usageReport } from "./server/watch/usage";
import { roomWaiting } from "./shared/room";
import { Watcher, type SeatView, type TimelineView } from "./server/watch/watcher";

type CreateRequest = PluginBeforeRequests["agent.create"];

const VERSION = "0.12.0";
const MAIL_DIR = join(ROOM_HOME, "mail");
const MCP_TOKEN_FILE = join(MAIL_DIR, "token");
const NONCES_FILE = join(MAIL_DIR, "nonces.json");

/**
 * slp-seat: the room's hooks into Paseo. A seat gets its prompt, project block and mail server at
 * agent.create and its own environment each time its session opens; turn ends and permission
 * requests become mail; archives and GC clean up after it.
 */
export default function contribute(server: PluginServerContext) {
  // the room home holds mail bodies and copies of the user's harness config: its owner only
  mkdirSync(ROOM_HOME, { recursive: true });
  chmodSync(ROOM_HOME, 0o700);
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
  /** seat → the signals it mailed its parent in the turn it is in; read when that turn ends. */
  const mailedUp = new Map<string, Set<string>>();
  /** seat → the signal its last turn ended with. */
  const lastSignal = new Map<string, string>();
  /** seat nobody above reads by mail → what its last turn left for the Owner to answer. */
  const owed = new Map<string, { key: string; agentId: string; title: string | null; what: string; at: string }>();
  let gc: Collector | null = null;
  const getGc = (paseo: Parameters<typeof getEngine>[0]) => {
    if (!gc) gc = new Collector(paseo, getEngine(paseo), policy.gc, log, forgetAgent);
    return gc;
  };
  const budget = new Budget(join(WATCH_DIR, "usage-{month}.json"), policy.watcher.budget);
  // what the decision model cost this month, for Paseo's Usage screen; a watcher that is off asks nothing
  if (policy.watcher.mode !== "off") {
    server.registerUsageSource({
      id: "slp-watcher",
      label: "Room watcher",
      input: z.object({}),
      discover: async (scope) => (scope.kind === "global" ? [{ key: "decision-model", label: policy.watcher.engine.model, input: {} }] : []),
      fetch: async () => usageReport(budget.summary()),
    });
  }
  const scans = new ScanLog(join(WATCH_DIR, "scans.jsonl"));
  let watcher: Watcher | null = null;
  const getWatcher = (paseo: Parameters<typeof getEngine>[0]) => {
    watcher ??= new Watcher({
      policy: policy.watcher,
      params: policy.room.params,
      engine: new JevEngine({ ...policy.watcher.engine, apiKey: watchKey(policy.watcher.engine) }),
      budget,
      scans,
      timeline: (agentId) => readTimeline(paseo, agentId, policy.watcher.historyEntries),
      snapshot,
      notify: async (notice) => {
        const mail = await getEngine(paseo).post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: notice.to,
          priority: "action",
          subject: notice.subject,
          body: notice.body,
          needs: "nothing",
          whyNow: "the room noticed something in a seat you launched; its own report does not say it",
          // a notice about a finished turn rides with that turn's report instead of starting a turn before it
          ...(notice.withReport ? { quiet: true as const } : {}),
        });
        return mail.id;
      },
      now: Date.now,
      log,
    });
    return watcher;
  };
  /** A seat as the watcher sees it; null for an agent that is not a room seat. */
  const viewOf = (paseo: Parameters<typeof getEngine>[0], agent: { id: string; provider: string; cwd: string; title: string | null; parentAgentId: string | null }): SeatView | null => {
    const seat = parseSeat(agent.provider);
    if (!seat) return null;
    const parent = getEngine(paseo).parentOf(agent.id) ?? agent.parentAgentId;
    return { agentId: agent.id, role: seat.role, title: agent.title, cwd: agent.cwd, parent, parentRole: (parent && getEngine(paseo).seat(parent)?.role) || null };
  };

  mcp.register(
    {
      name: "slp_mail",
      description:
        "Write to another seat of your room. To answer a mail you received, pass reply_to: its id (the #id in its header) and no `to`; the answer goes to whoever sent it. To start a new thread, pass `to`: `owner` (the seat that launched you) or the id of a seat you launched. The plugin wraps it in an envelope and delivers it between the recipient's turns; it never interrupts anyone. A CANDIDATE, REVIEW or DONE to your owner is your turn's report: it is delivered when your turn ends, and your final message is not mailed a second time. Mail to an archived seat is refused.",
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
      const signal = subjectSignal(subject);
      if (signal && engine.parentOf(from) === to) {
        mailedUp.set(from, (mailedUp.get(from) ?? new Set()).add(signal));
        // "my work is finished" is true only once the turn has ended: until then the parent must not act on this seat
        if (CLOSES_WORK.has(signal)) {
          const kept = engine.keepReport({
            from: { agentId: from, role: sender.role },
            to,
            priority,
            subject,
            body,
            needs: needs === "nothing" ? "reply" : needs,
            whyNow: `the seat ended its turn with ${signal}`,
          });
          return `kept #${kept.id} as your report to owner: it is delivered once, when your turn ends. End your turn with ${signal} on the first line; do not send it again.`;
        }
      }
      // an acknowledgement asks nothing of anyone, and neither does a receipt for a candidate under review: neither starts a turn
      const waits = signal === "ACK" || isReceipt({ recipientRole: recipient.role, subject, needs: args.needs, fromAbove: engine.isAncestor(from, to), recipientEndedWith: lastSignal.get(to) });
      const mail = await engine.post({
        from: { agentId: from, role: sender.role },
        to,
        priority: waits ? "fyi" : priority,
        subject,
        body,
        needs,
        whyNow: whyNowFor(engine.isAncestor(from, to) ? "owner" : sender.role, needs),
        ...(waits ? { quiet: true as const } : {}),
      });
      const held = engine.held(to).some((m) => m.id === mail.id);
      return `sent #${mail.id} to ${engine.isAncestor(to, from) ? "owner" : `${recipient.role} ${to}`} as ${mail.priority}; ${waits ? "it is read with the recipient's next mail" : held ? "held until the recipient can take it" : "delivered"}. Continue your work; do not wait for a reply unless needs=decision blocks you.`;
    },
  );

  mcp.register(
    {
      name: "slp_inbox",
      description: "Read the mail the plugin is holding for you: mail that arrived while you were busy, and mail that starts no turn of its own (the newest progress report of a seat you launched, acknowledgements). Returns and clears it.",
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

  // the registry belongs to the seat above the projects; the descriptions stay neutral because every seat can read them
  const registryOwner = (nonce: string, tool: string) => {
    const me = resolveCaller(nonce);
    if (!me || engine?.seat(me)?.role !== "hq") throw new Error(`${tool} refused: your seat does not keep the project registry`);
  };

  mcp.register(
    {
      name: "slp_projects",
      description: "The project registry, one line per project known to Paseo: registered or not, name, root, whether its mission and law exist, its model table (default or custom) and the Supervisor seat to use. Refused for seats that do not keep the registry.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    async (_args, context) => {
      registryOwner(context.nonce, "slp_projects");
      return describeProjects();
    },
  );

  mcp.register(
    {
      name: "slp_register_project",
      description:
        "Register a project that Paseo already has: writes its room marker, its mission and its own model table when given, and its registry line. A seat the table names that the room does not have yet is set up first. Repeat it with `mission` or `models` to replace them. Refused for seats that do not keep the registry.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The project's root, or its name in Paseo (see slp_projects)." },
          name: { type: "string", description: "Registry name, letters digits dashes. Default: the Paseo name." },
          mission: { type: "string", description: "What the project is for and what done looks like, a few lines of markdown." },
          models: { type: "object", description: "Only the differences from ROOM_DIR/models.json, same shape; objects merge, lists and values replace, null removes a key. Omit to use the room's table." },
        },
        required: ["path"],
      },
    },
    async (args, context) => {
      registryOwner(context.nonce, "slp_register_project");
      return registerProject({ path: String(args.path ?? ""), name: args.name ? String(args.name) : undefined, mission: args.mission ? String(args.mission) : undefined, models: args.models ?? undefined });
    },
  );

  mcp.register(
    {
      name: "slp_room_stats",
      description: "What the mail log says happened in the last N days, per project and per signal (candidates accepted or rejected, reopen requests conceded or held, decisions escalated, questions). Refused for seats that do not keep the registry.",
      inputSchema: { type: "object", properties: { days: { type: "number", description: "Window in days, default 14." } }, required: [] },
    },
    async (args, context) => {
      registryOwner(context.nonce, "slp_room_stats");
      return roomStats(Number(args.days) > 0 ? Number(args.days) : 14);
    },
  );

  mcp.register(
    {
      name: "slp_watch_stats",
      description: "What the watcher found and what it cost: this month's spending on its decision model, and per rule how often it spoke and how its findings compare with what the seat above did next. Refused for seats that do not keep the registry.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    async (_args, context) => {
      registryOwner(context.nonce, "slp_watch_stats");
      const spend = budget.summary();
      const mailLog = join(MAIL_DIR, "log.jsonl");
      const mail = existsSync(mailLog) ? readFileSync(mailLog, "utf8").split("\n").flatMap((line) => { try { return line.trim() ? [JSON.parse(line) as MailLine] : []; } catch { return []; } }) : [];
      const lines = [
        `watcher mode ${policy.watcher.mode}; ${spend.month}: ${spend.total.calls} calls, ${spend.total.tokens} tokens, $${spend.total.usd.toFixed(4)} of a $${spend.planUsd} plan (cap $${spend.capUsd}); today $${spend.today.usd.toFixed(4)}; asking is ${spend.pace}`,
        renderCalibration(calibrate(scans.read(), mail, policy.watcher.calibration, Date.now(), REVISION), policy.watcher.calibration),
      ];
      return lines.join("\n");
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
    const seat = parseSeat(request.provider);
    if (!seat) return request;
    // Paseo saves no env with an agent: a seat reopened after a restart would start on the user's own home
    ensureRuntime(seat);
    return { ...request, env: { ...request.env, ...envFor(seat, policy) } };
  });

  server.on("agent.created", async (event, { paseo }) => {
    const seat = parseSeat(event.agent.provider);
    // spawn rules: a seat may only create the roles policy.room.spawn allows, never a non-room provider
    const parentId = event.agent.parentAgentId;
    const parent = parentId ? getEngine(paseo).seat(parentId) : undefined;
    if (parent) {
      const allowed = policy.room.spawn[parent.role] ?? [];
      const childRole = seat?.role;
      if (!childRole || !maySpawn(policy.room.spawn, parent.role, childRole, event.agent.title)) {
        const what = seat ? `a ${seat.role} seat` : `a non-room agent (provider ${event.agent.provider})`;
        log(`spawn refused: ${parent.role} ${parentId} created ${what} ${event.agent.id}; archiving it`);
        // Paseo sends a new agent its first prompt without waiting for this hook, so the seat may already be at work
        let outcome = "The room archived it. If you gave it a first prompt, that turn may have started before the archive: check what it changed.";
        try {
          await paseo.agents.ref(event.agent.id).archive();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          log(`spawn refused: could not archive ${event.agent.id}: ${reason}`);
          outcome = `The room could not archive it (${reason}), so it is still there: archive ${event.agent.id} yourself, then check what it changed.`;
        }
        await getEngine(paseo).post({
          from: { agentId: "room", role: "system" },
          fromLabel: "room",
          to: parentId!,
          priority: "blocking",
          subject: `SPAWN REFUSED: a ${parent.role} may create only ${allowed.length ? allowed.join(", ") : "nothing"}`,
          body: `You created ${what} titled "${event.agent.title ?? ""}". ${outcome} Create only the roles your role allows (${allowed.length ? allowed.join(", ") : "none"}), on the room's providers, and continue.`,
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
  // the app asks this while it is open. After a daemon start it is the first thing to hand the room a Paseo client:
  // mail held on disk moves without waiting for an agent to run
  server.handle(roomWaiting, (_input, { paseo }) => {
    if (!engine) void getEngine(paseo).sweep();
    getGc(paseo);
    return { chime: policy.owner.chime, waiting: [...owed.values()] };
  });

  server.on("agent.turn_started", (event, { paseo }) => {
    owed.delete(event.agent.id);
    getGc(paseo);
    const view = viewOf(paseo, event.agent);
    if (view) getWatcher(paseo).turnStarted(view, event.turnId);
  });

  server.on("agent.archived", async (event, { paseo }) => {
    owed.delete(event.agent.id);
    watcher?.forget(event.agent.id);
    await getGc(paseo).onArchived(event.agent.id);
  });

  // a runtime that closes (daemon stopping, seat deleted) takes its turn with it, and Paseo sends that turn no end:
  // what the room kept for the turn goes; held mail stays, and the sweep posts a report the seat had mailed
  server.on("agent.closed", (event) => {
    watcher?.cut(event.agent.id);
    owed.delete(event.agent.id);
    mailedUp.delete(event.agent.id);
    engine?.takeWake(event.agent.id);
  });

  server.on("agent.turn_ended", async (event, { paseo }) => {
    const eng = getEngine(paseo);
    const id = event.agent.id;
    const seat = parseSeat(event.agent.provider);
    // what this turn was started by and what the seat mailed during it; read before the next delivery starts its next turn
    const wake = eng.takeWake(id);
    const kept = eng.takeReport(id);
    const mailed = mailedUp.get(id) ?? new Set<string>();
    mailedUp.delete(id);
    const parentId = eng.parentOf(id) ?? event.agent.parentAgentId;
    const parent = parentId ? eng.seat(parentId) : undefined;
    // nothing travels up to hq: it reads the Supervisor's final message and .slp/status.md when it looks
    const reportsTo = seat && parentId && parent && parent.role !== "hq" ? parentId : null;
    const canceled = event.outcome.kind === "canceled";
    // a seat nobody above reads by mail: the Owner reads its final message, and the app is told when it asks something
    if (seat && !reportsTo && !canceled) {
      const what = event.outcome.kind === "failed" ? "FAILED" : asksOwner(lastAssistantText(event.timeline));
      if (what) owed.set(id, { key: `${id}:${Date.now()}`, agentId: id, title: event.agent.title, what, at: new Date().toISOString() });
    }
    // the turn's own report; it stays null when the parent has this turn's signal from the seat's own mail
    let report: Parameters<MailEngine["post"]>[0] | null = null;
    if (seat && reportsTo && !canceled) {
      const text = lastAssistantText(event.timeline);
      const signal = signalOf(text);
      const repeats = signal !== undefined && lastSignal.get(id) === signal;
      // a Lead's first report carries its plan; a STATUS after it asks nothing of the seat above
      let progress = signal === "STATUS" && seat.role === "lead" && lastSignal.has(id);
      if (signal) lastSignal.set(id, signal);
      let priority: Priority = "fyi";
      let subject = `${signal ?? "turn ended"}: ${seat.role} ${event.agent.title ?? event.agent.id}`;
      let needs: Needs = "nothing";
      let quiet = signal === "ACK" || progress;
      let send = true;
      if (event.outcome.kind === "failed") {
        priority = "blocking";
        subject = `FAILED: ${event.outcome.error.message.slice(0, 120)}`;
        needs = "decision";
        quiet = progress = false;
      } else if (signal ? mailed.has(signal) : kept) {
        // one report per turn
        log(`turn end of ${id} not mailed again: the seat mailed ${signal ?? "its report"} to its parent itself`);
        send = false;
      } else if (signal && signal !== "STATUS" && signal !== "ACK") {
        priority = "action";
        subject = `${signal} from ${seat.role} ${event.agent.title ?? event.agent.id}`;
        needs = ["QUESTION", "BLOCKED", "DECISION_NEEDED", "REOPEN_REQUEST", "DEPENDENCY_REQUEST"].includes(signal) ? "decision" : "reply";
        // DONE again, in a turn started only by mail that asked nothing: the parent has it already
        if (signal === "DONE" && repeats && askedNothing(wake)) {
          priority = "fyi";
          needs = "nothing";
          quiet = true;
        }
      }
      if (send) {
        report = {
          from: { agentId: id, role: seat.role },
          to: reportsTo,
          priority,
          subject,
          body: text || `(no final message; outcome ${event.outcome.kind})`,
          needs,
          whyNow: event.outcome.kind === "failed" ? "the seat's turn failed; its work is stopped" : progress ? "progress only: the seat ended its turn with STATUS and asks nothing of you" : quiet ? `nothing new: the seat ended its turn with ${signal === "ACK" ? "an acknowledgement" : "DONE again, after mail that asked nothing"}` : `the seat ended its turn with ${signal ?? "a progress message"}`,
          ...(quiet ? { quiet: true as const } : {}),
          ...(progress ? { progress: true as const } : {}),
        };
      }
    }
    // the watcher reads the turn before anything goes up: its notice rides with a mail that starts the parent's turn, or goes alone when this turn sends none
    const view = canceled ? null : viewOf(paseo, event.agent);
    const carried = [kept, report].some((mail) => mail && !mail.quiet);
    if (view) await getWatcher(paseo).turnEnded(view, event.turnId, carried);
    else watcher?.forget(id);
    // whoever finished a turn may now take held mail; the watcher has read the turn, so the next one may start
    await eng.deliver(id);
    if (!reportsTo) return;
    // a newer report takes the place of this seat's progress report that still waits unread
    if (kept || report) eng.dropProgress(id, reportsTo);
    // the report the seat mailed before its turn ended goes out now, however the turn ended
    if (kept) await eng.post({ ...kept, to: reportsTo });
    if (report) await eng.post(report);
  });

  server.on("agent.permission_requested", async (event, { paseo }) => {
    const eng = getEngine(paseo);
    const seat = parseSeat(event.agent.provider);
    const parentId = eng.parentOf(event.agent.id) ?? event.agent.parentAgentId;
    if (!seat || !parentId || !eng.seat(parentId) || eng.seat(parentId)?.role === "hq") return;
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

  // the default project: retried because the daemon may not answer the CLI while it loads plugins
  const hqRetry = (left: number) => {
    ensureHqProject(log).catch((error) => {
      if (left > 0) setTimeout(() => hqRetry(left - 1), 15_000).unref();
      else console.error("slp-seat: the hq-seatwork project could not be created", error);
    });
  };
  hqRetry(4);

  // safety net: anything still held gets another delivery attempt every minute
  const sweep = setInterval(() => {
    void engine?.sweep();
  }, 60_000);
  // garbage collection: idle seats and orphan heartbeats
  const collect = setInterval(() => {
    void gc?.run();
  }, Math.max(1, policy.gc.everyMinutes) * 60_000);
  // the watcher's look at turns that are still running
  const watch = setInterval(() => {
    void watcher?.tick();
  }, Math.max(5, policy.watcher.pollSeconds) * 1000);

  return async () => {
    clearInterval(sweep);
    clearInterval(collect);
    clearInterval(watch);
    // a mail server still binding would stay open behind a close that came first
    await starting;
    await mcp.close();
  };

  /* ---------- helpers bound to this plugin instance ---------- */

  function applySeat(request: CreateRequest): CreateRequest {
    const seat = parseSeat(request.config.provider);
    if (!seat) return request;
    if (!enabledSeats().some((s) => s.provider === seat.provider)) {
      throw new Error(`slp-seat: ${seat.provider} is not a seat the room has set up (\`./install.sh --seat ${seat.provider}\` in slp-room sets it up)`);
    }

    const registry = loadRegistry();
    const cwd = request.config.cwd;
    let project: { name: string; root: string; room: Record<string, unknown>; mission: string | null; law: string | null } | null = null;

    checkHqPlacement(seat.role, seat.provider, cwd);
    if (registry) {
      if (seat.role !== "hq") {
        const match = findProject(registry, cwd);
        if (!match) {
          const names = registry.projects.map((p) => `${p.name} (${p.cwd})`).join(", ") || "none";
          throw new Error(`slp-seat: ${seat.provider} refused: ${cwd} is not a registered SLP project. Registered: ${names}`);
        }
        project = { name: match.entry.name, root: match.root, room: match.room, mission: match.mission, law: match.law };
      }
    } else if (seat.role !== "hq") {
      const marker = findRoomMarker(cwd);
      if (marker) project = { name: marker.root.split("/").pop() ?? marker.root, root: marker.root, room: marker.room, mission: marker.mission, law: marker.law };
    }

    // a project that carries its own model table gets it in its prompts, and enforced
    let models: Models | undefined;
    if (project?.room.models !== undefined) {
      const where = `${project.root}/.slp/room.json`;
      models = projectModels(project.room.models, enabledSeats().map((s) => s.provider), `slp-seat: ${where}`);
      const check = modelAllowed(models, seat.role, seat.provider, request.config.model ?? undefined);
      if (!check.ok) {
        throw new Error(`slp-seat: ${seat.provider}/${request.config.model ?? "(default model)"} refused: project ${project.name} lists for ${seat.role} only ${check.listed.join(", ")} (${where})`);
      }
    }

    // without its own home a seat would start on the user's, with the user's MCP servers and plugins
    try {
      ensureRuntime(seat);
    } catch (error) {
      throw new Error(`slp-seat: ${seat.provider} refused: its runtime could not be built (${error instanceof Error ? error.message : String(error)}). Fix that and create the seat again.`);
    }

    // the room's MCP server; agent.session_open ties this nonce to the agent id and adds the seat's own environment
    const nonce = randomBytes(9).toString("base64url");
    const env: Record<string, string> = { ...(request.env ?? {}), SLP_NONCE: nonce };
    const mcpServers = {
      ...(request.config.mcpServers ?? {}),
      slp: { type: "http" as const, url: mcp.urlFor(port, nonce), alwaysLoad: true },
    };

    const featureSpec = (request.config.featureValues as { slpSpec?: unknown } | undefined)?.slpSpec;
    const spec = specFromTitle(request.config.title) ?? (typeof featureSpec === "string" ? featureSpec : undefined);
    const parts = [
      rolePrompt(seat.role, { harness: seat.harness, spec, params: policy.room.params, models }),
      project ? projectBlock(project.name, project.root, project.mission, project.law) : null,
      seat.harness === "claude" ? sharedClaudeFiles(policy) : null,
      request.config.systemPrompt,
    ];
    const systemPrompt = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
    // a Claude seat runs on the user's ~/.claude: personal customizations off by flags, its role's skills as an additional directory
    let providerOptions = request.config.providerOptions;
    if (seat.harness === "claude") {
      const current = (providerOptions ?? {}) as { additionalDirectories?: unknown; extraArgs?: Record<string, string | null> };
      const dirs = Array.isArray(current.additionalDirectories) ? current.additionalDirectories.filter((d): d is string => typeof d === "string") : [];
      providerOptions = { ...current, additionalDirectories: [...new Set([...dirs, claudeRoleDir(seat.role)])], extraArgs: { ...(current.extraArgs ?? {}), ...policy.launch.claude.extraArgs } };
    }
    return { ...request, env, config: { ...request.config, systemPrompt, mcpServers, ...(providerOptions ? { providerOptions } : {}) } };
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

/** True when a turn was started by mail and none of it asked the seat for anything. */
function askedNothing(wake: readonly Mail[]): boolean {
  return wake.length > 0 && wake.every((mail) => mail.needs === "nothing" && (mail.priority === "fyi" || mail.from.role === "system"));
}

/**
 * A receipt: the seat above writes HOLD or NOTED, says it needs nothing, and the Peer's last turn handed its work
 * over. That Peer waits for the verdict and has nothing to do with a receipt; a Peer stopped on a challenge is
 * waiting for exactly this mail.
 */
function isReceipt(input: { recipientRole: Role; subject: string; needs: unknown; fromAbove: boolean; recipientEndedWith: string | undefined }): boolean {
  if (input.recipientRole !== "peer" || !input.fromAbove || input.needs !== "nothing") return false;
  return /^\W*(?:HOLD|NOTED)\b/.test(input.subject) && input.recipientEndedWith !== undefined && CLOSES_WORK.has(input.recipientEndedWith);
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

/* ---------- the watcher's view of Paseo ---------- */

/** The key of the watcher's decision model: from the environment, else from its file under the room home. */
function watchKey(engine: { keyEnv: string; keyFile: string }): string | undefined {
  const fromEnv = process.env[engine.keyEnv]?.trim();
  if (fromEnv) return fromEnv;
  const file = join(ROOM_HOME, engine.keyFile);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

/** A seat's recent timeline with tool calls and messages merged, as Paseo projects it. */
async function readTimeline(paseo: PaseoApi, agentId: string, limit: number): Promise<TimelineView | null> {
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "projected", limit });
    return { entries: page.entries.map((entry) => ({ item: entry.item, timestamp: entry.timestamp, turnId: entry.turnId })), pendingPermission: (page.agent?.pendingPermissions?.length ?? 0) > 0 };
  } catch {
    return null;
  }
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

