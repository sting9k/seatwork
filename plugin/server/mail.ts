import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { maySpawn } from "./seats";
import { join } from "node:path";
import type { PaseoApi } from "./paseo";
import { paseoCli } from "./cli";
import { REGISTRY_LOG, ROOM_HOME } from "./paths";
import { parseSeat, type Role } from "./seats";
import type { MailPolicy, RoomPolicy } from "./policy";
import { Lru } from "./watch/cache";

/** Seatwork mail: writes the envelope, checks the route, and holds a mail on disk until its recipient is at rest. */

export type Priority = "blocking" | "action" | "fyi";
export type Needs = "reply" | "decision" | "nothing";

/** A mail: `sending` marks a delivery under way, `quiet` starts no turn, `progress` gives way to a newer report. */
export interface Mail {
  id: string;
  at: string;
  from: { agentId: string; role: Role | "system" };
  fromLabel?: string;
  to: string;
  priority: Priority;
  subject: string;
  body: string;
  needs: Needs;
  whyNow: string;
  sending?: true;
  quiet?: true;
  progress?: true;
}

export interface SeatRecord {
  agentId: string;
  parentAgentId: string | null;
  role: Role;
  provider: string;
  title: string | null;
  cwd?: string;
}

const MAIL_DIR = join(ROOM_HOME, "mail");
const QUEUE_DIR = join(MAIL_DIR, "queue");
const LOG_FILE = join(MAIL_DIR, "log.jsonl");
/** One file per seat: the report it mailed its parent before its turn ended. */
const REPORT_DIR = join(MAIL_DIR, "reports");
/** child agent id → the seat that adopted it (overrides the Paseo parent for routing). */
const ADOPTIONS_FILE = join(MAIL_DIR, "adoptions.json");

const HANDLING: Record<Priority, string> = {
  blocking: "BLOCKING — someone is stopped until you act. Handle this first in this turn: reason, reply with seatwork_mail (or respond_to_permission), then resume your own plan where you left it.",
  action: "ACTION — handle it in this turn: answer or take the disposition it asks for, reply with seatwork_mail if it needs one, then continue your own plan. It is a message, not a new brief.",
  fyi: "FYI — read it; no reply needed unless it changes your plan.",
}

const PRIORITY_RANK: Record<Priority, number> = { blocking: 0, action: 1, fyi: 2 };
const RECENT_MAILS = 2000;

function nowId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDirs(): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
}

function queueFile(agentId: string): string {
  return join(QUEUE_DIR, `${agentId}.jsonl`);
}

function reportFile(agentId: string): string {
  return join(REPORT_DIR, `${agentId}.json`);
}

function readQueue(agentId: string): Mail[] {
  const file = queueFile(agentId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Mail);
}

/** Writes a queue; an empty one has no file. */
function writeQueue(agentId: string, mails: Mail[]): void {
  ensureDirs();
  const file = queueFile(agentId);
  if (mails.length === 0) return rmSync(file, { force: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, mails.map((m) => JSON.stringify(m)).join("\n") + "\n");
  renameSync(tmp, file);
}

/** Rewrites a queue from what is on disk now, so mail posted in the meantime is kept. `null` drops a mail. */
function updateQueue(agentId: string, change: (mail: Mail) => Mail | null): void {
  writeQueue(agentId, readQueue(agentId).flatMap((mail) => change(mail) ?? []));
}

function logLine(kind: string, mail: Mail, detail?: string): void {
  ensureDirs();
  appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), kind, id: mail.id, from: mail.from.agentId, to: mail.to, priority: mail.priority, subject: mail.subject, detail })}\n`);
}

/** A seat stopped until someone answers it: a pending permission, or a status that says it waits. */
export function waitsOnSomeone(agent: { status?: string; pendingPermissions?: unknown[] | null }): boolean {
  if (Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0) return true;
  return agent.status === "permission" || agent.status === "attention" || agent.status === "needs_input";
}

/** Fallback for mail queued before fromLabel existed. */
export function senderLabel(from: Mail["from"]): string {
  if (from.role === "system") return "room";
  return from.role === "hq" ? "owner" : `${from.role}:${from.agentId}`;
}

/** The envelope the recipient reads. Written by the plugin, never by an agent. */
export function envelope(mail: Mail): string {
  const tag = mail.priority.toUpperCase();
  return [
    `SEATWORK MAIL #${mail.id} ${tag} from ${mail.fromLabel ?? senderLabel(mail.from)} re: ${mail.subject}`,
    `why now: ${mail.whyNow}`,
    `needs: ${mail.needs}`,
    ...(mail.sending ? [`possible repeat: an earlier delivery of this mail was cut off; if you already handled #${mail.id}, do nothing`] : []),
    "--- body ---",
    mail.body.trim(),
    "--- how to handle ---",
    HANDLING[mail.priority],
  ].join("\n");
}

function digest(mails: Mail[]): string {
  if (mails.length === 1) return envelope(mails[0]);
  const sorted = [...mails].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.at.localeCompare(b.at));
  return [`SEATWORK MAIL DIGEST — ${sorted.length} messages, highest first. Handle each by its own header.`, "", ...sorted.map((m) => envelope(m))].join("\n\n");
}

export class MailEngine {
  private readonly seats = new Map<string, SeatRecord>();
  private readonly posted = new Lru<{ from: string; to: string }>(RECENT_MAILS);
  private readonly adoptions = new Map<string, string>();
  private delivering = new Set<string>();
  private readonly woke = new Map<string, Mail[]>();

  constructor(
    private readonly paseo: PaseoApi,
    private readonly policy: MailPolicy,
    private readonly room: RoomPolicy,
    private readonly log: (message: string) => void,
  ) {
    ensureDirs();
    this.loadSeats();
    this.loadAdoptions();
  }

  private loadAdoptions(): void {
    if (!existsSync(ADOPTIONS_FILE)) return;
    try {
      for (const [child, parent] of Object.entries(JSON.parse(readFileSync(ADOPTIONS_FILE, "utf8")) as Record<string, string>)) {
        this.adoptions.set(child, parent);
      }
    } catch {
      // start empty
    }
  }

  private saveAdoptions(): void {
    writeFileSync(ADOPTIONS_FILE, `${JSON.stringify(Object.fromEntries(this.adoptions), null, 2)}\n`);
  }

  /** The seat a seat reports to: its adopter when adopted, else the Paseo parent. */
  parentOf(agentId: string): string | null {
    return this.adoptions.get(agentId) ?? this.seats.get(agentId)?.parentAgentId ?? null;
  }

  /** A handoff: `adopter` becomes `child`'s owner for mail, reports and permissions, when the route allows it. */
  async adopt(adopter: string, child: string): Promise<{ ok: true; previous: string | null } | { ok: false; reason: string }> {
    const a = this.seats.get(adopter);
    const c = this.seats.get(child);
    if (!a) return { ok: false, reason: `adopter ${adopter} is not a room seat` };
    if (!c) return { ok: false, reason: `${child} is not a room seat` };
    if (adopter === child) return { ok: false, reason: "a seat does not adopt itself" };
    if (this.isAncestor(child, adopter)) return { ok: false, reason: `${child} is above you` };
    if (!maySpawn(this.room.spawn, a.role, c.role, c.title)) return { ok: false, reason: `a ${a.role} may own only ${(this.room.spawn[a.role] ?? []).join(", ") || "nothing"}, not this ${c.role}` };
    const previous = this.parentOf(child);
    if (previous === adopter) return { ok: true, previous };
    if ((await this.status(child)) === "gone") return { ok: false, reason: `${child} is archived or gone` };
    const previousGone = !previous || (await this.status(previous)) === "gone";
    const adopterParent = this.parentOf(adopter);
    const sameChain = this.isAncestor(adopter, child) || (adopterParent !== null && this.isAncestor(adopterParent, child));
    if (!previousGone && !sameChain) {
      return { ok: false, reason: `${child} still reports to a live seat that is not in your chain; only its chain may hand it over` };
    }
    this.adoptions.set(child, adopter);
    this.saveAdoptions();
    // Paseo's parent link is a label; moving it keeps its archive cascade off the adopted child
    try {
      await paseoCli(["agent", "update", child, "--label", `paseo.parent-agent-id=${adopter}`]);
    } catch (error) {
      this.log(`adopt: could not move the Paseo parent label of ${child}: ${error instanceof Error ? error.message : String(error)}`);
    }
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), kind: "adopted", child, adopter, previous })}\n`);
    return { ok: true, previous };
  }

  /** Finds in the log the sender and recipient of a mail no longer in memory. */
  private findPosted(id: string): { from: string; to: string } | null {
    if (!existsSync(LOG_FILE)) return null;
    const lines = readFileSync(LOG_FILE, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"kind":"queued"') || !lines[i].includes(id)) continue;
      try {
        const rec = JSON.parse(lines[i]) as { kind: string; id: string; from: string; to: string };
        if (rec.kind !== "queued" || rec.id !== id) continue;
        this.posted.set(id, { from: rec.from, to: rec.to });
        return { from: rec.from, to: rec.to };
      } catch {
        // skip bad line
      }
    }
    return null;
  }

  /** Who sent mail #id and to whom; null when unknown. */
  lookupMail(id: string): { from: string; to: string } | null {
    return this.posted.get(id) ?? this.findPosted(id);
  }

  /* ---------- seat directory (who is whose parent) ---------- */

  private loadSeats(): void {
    if (!existsSync(REGISTRY_LOG)) return;
    for (const line of readFileSync(REGISTRY_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { agentId: string; parentAgentId: string | null; role: Role; provider: string; title: string | null; cwd?: string };
        this.seats.set(rec.agentId, { agentId: rec.agentId, parentAgentId: rec.parentAgentId ?? null, role: rec.role, provider: rec.provider, title: rec.title ?? null, ...(rec.cwd ? { cwd: rec.cwd } : {}) });
      } catch {
        // skip bad line
      }
    }
  }

  rememberSeat(seat: SeatRecord): void {
    this.seats.set(seat.agentId, seat);
  }

  seat(agentId: string): SeatRecord | undefined {
    return this.seats.get(agentId);
  }

  /** Every seat ever registered, oldest first. */
  allSeats(): SeatRecord[] {
    return [...this.seats.values()];
  }

  /** True when `ancestor` is the parent, grandparent, ... of `agentId`. */
  isAncestor(ancestor: string, agentId: string): boolean {
    let cursor = this.parentOf(agentId);
    for (let i = 0; cursor && i < 16; i += 1) {
      if (cursor === ancestor) return true;
      cursor = this.parentOf(cursor);
    }
    return false;
  }

  /** Two gates: the role route table (`room.routes`) and the tree relation, read over effective parents. */
  canWrite(from: string, to: string, viaReply = false): { ok: true } | { ok: false; reason: string } {
    const sender = this.seats.get(from);
    const recipient = this.seats.get(to);
    if (!sender) return { ok: false, reason: `sender ${from} is not a room seat` };
    if (!recipient) return { ok: false, reason: `recipient ${to} is not a room seat (not in the registry log)` };
    if (from === to) return { ok: false, reason: "a seat does not mail itself" };
    const route = `${sender.role}>${recipient.role}`;
    if (this.room.routes[route] !== true) {
      if (route === "supervisor>hq") return { ok: false, reason: "nothing travels up from a Supervisor: the Owner reads your final message and .seatwork/status.md (WAITING ON YOU rows); write there" };
      return { ok: false, reason: `route ${route} is off in the room policy (room.routes)` };
    }
    if (this.parentOf(from) === to || this.parentOf(to) === from) return { ok: true };
    if (this.isAncestor(from, to)) return { ok: true }; // writing down the chain (direct intervention)
    if (viaReply && this.isAncestor(to, from)) return { ok: true }; // answering someone above who wrote first
    return {
      ok: false,
      reason: `${sender.role} ${from} may write to its parent, to seats it launched, or down its own chain; ${recipient.role} ${to} is none of these${viaReply ? "" : " (to answer a mail from above, pass reply_to: its id)"}`,
    };
  }

  /** Live status of a seat, for callers that must not post to an archived one. */
  recipientStatus(agentId: string): Promise<"idle" | "running" | "permission" | "unknown" | "gone"> {
    return this.status(agentId);
  }

  /* ---------- enqueue + deliver ---------- */

  /** `id` is given when the mail was shown to its sender before it is posted (a kept report). */
  async post(input: Omit<Mail, "id" | "at"> & { id?: string }): Promise<Mail> {
    const fromLabel = input.fromLabel ?? (this.isAncestor(input.from.agentId, input.to) ? "owner" : `${input.from.role}:${input.from.agentId}`);
    const mail: Mail = { ...input, id: input.id ?? nowId(), at: new Date().toISOString(), fromLabel };
    this.posted.set(mail.id, { from: mail.from.agentId, to: mail.to });
    const queue = readQueue(mail.to);
    queue.push(mail);
    writeQueue(mail.to, queue);
    logLine("queued", mail);
    await this.deliver(mail.to);
    return mail;
  }

  /** A report written before its sender's turn ended: kept on disk, one per seat, posted at that turn's end. */
  keepReport(input: Omit<Mail, "id" | "at">): Mail {
    const mail: Mail = { ...input, id: nowId(), at: new Date().toISOString() };
    mkdirSync(REPORT_DIR, { recursive: true });
    const replaced = this.takeReport(mail.from.agentId);
    if (replaced) logLine("report-replaced", replaced);
    writeFileSync(reportFile(mail.from.agentId), `${JSON.stringify(mail)}\n`);
    this.posted.set(mail.id, { from: mail.from.agentId, to: mail.to });
    logLine("report-kept", mail);
    return mail;
  }

  /** The report kept for this seat, removed from disk; null when it wrote none. */
  takeReport(agentId: string): Mail | null {
    const file = reportFile(agentId);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Mail;
    } catch {
      return null;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Drops the progress reports of `from` still waiting for `to`: a newer one is on its way. */
  dropProgress(from: string, to: string): void {
    if (!readQueue(to).some((mail) => mail.progress && mail.from.agentId === from && !mail.sending)) return;
    updateQueue(to, (mail) => {
      if (!mail.progress || mail.from.agentId !== from || mail.sending) return mail;
      logLine("replaced-by-newer-report", mail);
      return null;
    });
  }

  /** The mail that started this seat's current turn; empty when something else did. Read once. */
  takeWake(agentId: string): Mail[] {
    const mails = this.woke.get(agentId) ?? [];
    this.woke.delete(agentId);
    return mails;
  }

  /** Mail held for an agent, without delivering it (for seatwork_inbox). */
  held(agentId: string): Mail[] {
    return readQueue(agentId);
  }

  /** Marks held mail as read by the recipient itself (seatwork_inbox); mail on its way out is left alone. */
  takeHeld(agentId: string): Mail[] {
    const mails = readQueue(agentId).filter((mail) => !mail.sending);
    updateQueue(agentId, (mail) => (mail.sending ? mail : null));
    for (const mail of mails) logLine("read-by-inbox", mail);
    return mails;
  }

  /** Delivery pass for one recipient. Safe to call often; it is idempotent. */
  async deliver(agentId: string): Promise<void> {
    if (this.delivering.has(agentId)) return;
    this.delivering.add(agentId);
    try {
      if (readQueue(agentId).length === 0) return;
      const status = await this.status(agentId);
      // read after the wait: mail posted meanwhile is in the file now
      const queue = readQueue(agentId);
      if (status === "gone") {
        writeQueue(agentId, []);
        for (const mail of queue) {
          logLine("dropped-recipient-gone", mail);
          if (mail.from.role === "system" || !this.seats.has(mail.from.agentId)) continue;
          const who = this.seats.get(agentId);
          // a sender that waited for an answer must learn none will come; one that asked nothing reads it later
          const waited = mail.needs !== "nothing";
          await this.post({
            from: { agentId: "room", role: "system" },
            fromLabel: "room",
            to: mail.from.agentId,
            priority: waited ? "action" : "fyi",
            subject: `UNDELIVERABLE: #${mail.id} re: ${mail.subject}`,
            body: `Your mail to ${who ? `${who.role} ${agentId}` : agentId} was not delivered: that seat is archived or gone. Nothing is waiting on it. If the work still matters, launch a new seat with the brief and what was tried.`,
            needs: "nothing",
            whyNow: "the recipient of a mail you sent no longer exists",
            ...(waited ? {} : { quiet: true as const }),
          });
        }
        return;
      }
      if (status === "unknown" || status === "permission") {
        return; // hold everything; the next trigger retries
      }
      let send: Mail[];
      if (status === "idle") {
        // quiet mail starts no turn; it goes out with the first mail that does
        send = queue.some((mail) => !mail.quiet) ? queue : [];
      } else {
        // running: only harnesses whose steer waits for the current tool call get mail mid-turn
        const harness = parseSeat(this.seats.get(agentId)?.provider)?.harness;
        const mode = harness ? this.policy.midTurn[harness] : "hold";
        send = mode === "steer" ? queue.filter((m) => m.priority !== "fyi" || !this.policy.holdFyiWhileRunning) : [];
      }
      if (send.length === 0) return;
      const asRead = new Map(send.map((mail) => [mail.id, mail]));
      // the mail stays on disk, marked, until the daemon has it: a process that dies here loses nothing
      updateQueue(agentId, (mail) => (asRead.has(mail.id) ? { ...mail, sending: true } : mail));
      if (status === "idle") this.woke.set(agentId, send);
      try {
        // The SDK's default for a running agent is "interrupt"; the room never interrupts.
        await this.paseo.agents.ref(agentId).send(digest(send), { activeTurnBehavior: "steer" } as never);
      } catch (error) {
        // refused, so nothing arrived: the mail waits as it was read
        if (status === "idle") this.woke.delete(agentId);
        updateQueue(agentId, (mail) => asRead.get(mail.id) ?? mail);
        for (const mail of send) logLine("delivery-failed", mail, error instanceof Error ? error.message : String(error));
        this.log(`mail: delivery to ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      updateQueue(agentId, (mail) => (asRead.has(mail.id) ? null : mail));
      for (const mail of send) logLine(status === "idle" ? "delivered-idle" : "delivered-steer", mail);
    } finally {
      this.delivering.delete(agentId);
    }
  }

  /** Every recipient with held mail; used by the periodic sweep. */
  async sweep(): Promise<void> {
    if (!existsSync(QUEUE_DIR)) return;
    for (const name of readdirSync(QUEUE_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      // older versions left empty queue files
      if (statSync(join(QUEUE_DIR, name), { throwIfNoEntry: false })?.size === 0) rmSync(join(QUEUE_DIR, name), { force: true });
      else await this.deliver(name.slice(0, -".jsonl".length));
    }
    // a kept report whose seat is in no turn any more: its turn end never reached us
    if (!existsSync(REPORT_DIR)) return;
    for (const name of readdirSync(REPORT_DIR)) {
      if (!name.endsWith(".json")) continue;
      const agentId = name.slice(0, -".json".length);
      const status = await this.status(agentId);
      if (status !== "idle" && status !== "gone") continue;
      const report = this.takeReport(agentId);
      if (report) await this.post(report);
    }
  }

  /** `idle` is any seat a message starts a turn in: at rest, without a runtime, or after a failed turn. */
  private async status(agentId: string): Promise<"idle" | "running" | "permission" | "unknown" | "gone"> {
    const handle = this.paseo.agents.ref(agentId);
    try {
      await handle.refresh();
    } catch {
      // a lost connection or a timeout proves nothing about the seat
      return "unknown";
    }
    const snapshot = handle.current() as { status?: string; archivedAt?: string | null; pendingPermissions?: unknown[] } | null;
    // the daemon answered: it has no such agent (deleted), or the agent is archived
    if (!snapshot || snapshot.archivedAt) return "gone";
    if (waitsOnSomeone(snapshot)) return "permission";
    if (snapshot.status === "running") return "running";
    if (snapshot.status === "idle" || snapshot.status === "closed" || snapshot.status === "error") return "idle";
    // initializing: its session is still opening
    return "unknown";
  }
}
