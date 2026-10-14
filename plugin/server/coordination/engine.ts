import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../../shared/mail.json";
import { paseoCli } from "../cli";
import { maySpawn, parseSeat, type Role } from "../orchestration/seats";
import type { PaseoApi } from "../paseo";
import { REGISTRY_LOG, ROOM_HOME } from "../paths";
import type { MailPolicy, RoomPolicy } from "../policy";
import { subjectOpening } from "../signals";
import { MailError, mayWrite, type Directory, type SeatRecord } from "./address";
import { appendThread, dropFiles, readArchive, writeMessage } from "./archive";
import { digest, seatLabel } from "./envelope";
import { MailStore, type Held, type Kind, type Needs, type PostedLine, type Priority } from "./store";

/** The room's mail: kept per project, checked against the routes, handed to a seat at rest. */

export type { SeatRecord } from "./address";
export type { Needs, Priority } from "./store";

export interface Sender {
  agentId: string;
  role: Role | "system" | "human";
}

/** A mail to post; `id` names a kept report that now goes out. */
export interface NewMail {
  id?: number;
  from: Sender;
  to: string | readonly string[];
  cc?: readonly string[];
  kind?: Kind;
  priority: Priority;
  subject: string;
  body: string;
  needs: Needs;
  why?: string;
  quiet?: boolean;
  progress?: boolean;
  urgent?: boolean;
  round?: string | null;
  heldUntil?: string | null;
  thread?: string;
  replyTo?: number;
  files?: string[];
  key?: string;
}

/** A mail as its first recipient holds it. */
export type Mail = Held;

/** How much of a body is shown; how long a repeat and a key count as one mail. */
export interface MailLimits {
  mailChars: number;
  quietChars: number;
  dedupeSeconds: number;
  keyHours: number;
  busyTimeoutMs: number;
}

/** `rootOf`: the project a seat's folder lies in; null keeps its mail in the room home. */
export interface EngineOptions extends Partial<MailLimits> {
  rootOf?(cwd: string): string | null;
  now?(): Date;
}

type Status = "idle" | "running" | "permission" | "unknown" | "gone";

export const MAIL_DIR = join(".seatwork", ".mail");
const ROOM_MAIL = join(ROOM_HOME, "mail");
const ADOPTIONS_FILE = join(ROOM_MAIL, "adoptions.json");
const DEFAULTS: MailLimits = {
  mailChars: 6000,
  quietChars: 600,
  dedupeSeconds: 300,
  keyHours: 24,
  busyTimeoutMs: 30_000,
};
const PRIORITY_RANK: Record<Priority, number> = { blocking: 0, action: 1, fyi: 2 };
const ANSWERS = new Set<string>(config.answers);
const AGAIN_MS = 10 * 60_000;

const startsNoTurn = (mail: Held, now: number) => mail.quiet || (!!mail.heldUntil && now < Date.parse(mail.heldUntil));

/** A seat stopped until someone answers its permission request. */
export function waitsOnSomeone(agent: { pendingPermissions?: unknown[] | null }): boolean {
  return Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0;
}

/** The word a subject opens with: one of the room's signals, or a notice's own name. */
export const signalFor = (subject: string) =>
  subjectOpening(subject) ?? subject.split(":")[0].replace(/^\W+/, "").trim().slice(0, 40).toUpperCase();

export class MailEngine implements Directory {
  private readonly seats = new Map<string, SeatRecord>();
  private readonly adoptions = new Map<string, string>();
  private readonly stores = new Map<string, MailStore>();
  private readonly delivering = new Set<string>();
  private readonly woke = new Map<string, Mail[]>();
  private readonly limits: MailLimits;
  private readonly now: () => Date;

  constructor(
    private readonly paseo: PaseoApi,
    private readonly policy: MailPolicy,
    private readonly room: RoomPolicy,
    private readonly log: (message: string) => void,
    private readonly options: EngineOptions = {},
  ) {
    this.limits = {
      ...DEFAULTS,
      ...Object.fromEntries(Object.entries(options).filter(([, v]) => typeof v === "number")),
    };
    this.now = options.now ?? (() => new Date());
    mkdirSync(ROOM_MAIL, { recursive: true });
    this.loadSeats();
    this.loadAdoptions();
  }

  /* ---------- the stores, one per project ---------- */

  /** The folder of a seat's mail: its project's, or the room home's for a seat in no project. */
  folderOf(agentId: string): string {
    const cwd = this.seats.get(agentId)?.cwd;
    const root = cwd ? (this.options.rootOf?.(cwd) ?? null) : null;
    return root ? join(root, MAIL_DIR) : ROOM_MAIL;
  }

  private open(dir: string, create: boolean): MailStore | null {
    const known = this.stores.get(dir);
    if (known) return known;
    // a folder that holds mail files and no store lost its store: opening it reads the files back
    if (!create && !existsSync(join(dir, "mail.db")) && !existsSync(join(dir, ".gitignore"))) return null;
    const store = new MailStore(dir, this.limits.busyTimeoutMs, this.now);
    // a store that lost its file, or was set aside as damaged, gets its mail back from the files
    if (store.count() === 0) {
      const archived = readArchive(dir);
      if (archived.length > 0) {
        const again = new Date(this.now().getTime() - AGAIN_MS).toISOString();
        this.log(`mail: rebuilt ${store.restore(archived, again)} mails of ${dir} from their files`);
      }
    }
    this.stores.set(dir, store);
    return store;
  }

  /** The store a seat's mail lives in; null when `create` is off and none was ever written. */
  storeOf(agentId: string, create = true): MailStore | null {
    return this.open(this.folderOf(agentId), create);
  }

  /** Every store that holds mail of a seat the room knows. */
  private known(): MailStore[] {
    const dirs = new Set([ROOM_MAIL, ...[...this.seats.keys()].map((id) => this.folderOf(id))]);
    return [...dirs].flatMap((dir) => this.open(dir, false) ?? []);
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }

  /* ---------- seat directory (who is whose parent) ---------- */

  private loadAdoptions(): void {
    if (!existsSync(ADOPTIONS_FILE)) return;
    try {
      for (const [child, parent] of Object.entries(
        JSON.parse(readFileSync(ADOPTIONS_FILE, "utf8")) as Record<string, string>,
      ))
        this.adoptions.set(child, parent);
    } catch {
      // start empty
    }
  }

  private loadSeats(): void {
    if (!existsSync(REGISTRY_LOG)) return;
    for (const line of readFileSync(REGISTRY_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as SeatRecord;
        this.seats.set(rec.agentId, {
          agentId: rec.agentId,
          parentAgentId: rec.parentAgentId ?? null,
          role: rec.role,
          provider: rec.provider,
          title: rec.title ?? null,
          ...(rec.cwd ? { cwd: rec.cwd } : {}),
          ...(rec.version ? { version: rec.version } : {}),
        });
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

  /** The seat a seat reports to: its adopter when adopted, else the Paseo parent. */
  parentOf(agentId: string): string | null {
    return this.adoptions.get(agentId) ?? this.seats.get(agentId)?.parentAgentId ?? null;
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

  canWrite(from: string, to: string, viaReply = false): { ok: true } | { ok: false; reason: string } {
    return mayWrite(this, this.room.routes, from, to, viaReply);
  }

  /** The seats whose mail a seat may read: itself and every seat under it; null for all. */
  seenBy(agentId: string): string[] | null {
    if (this.seats.get(agentId)?.role === "hq") return null;
    return [
      agentId,
      ...this.allSeats().flatMap((seat) => (this.isAncestor(agentId, seat.agentId) ? [seat.agentId] : [])),
    ];
  }

  /** How a sender reads to a reader: `owner`, `room`, or its role, short id and title. */
  label(sender: string, reader: string): string {
    if (sender === "room" || sender === "human") return sender;
    if (this.isAncestor(sender, reader)) return "owner";
    const seat = this.seats.get(sender);
    return seat ? seatLabel(seat) : sender;
  }

  /** A handoff: `adopter` becomes `child`'s owner for mail, reports and permissions. */
  async adopt(
    adopter: string,
    child: string,
  ): Promise<{ ok: true; previous: string | null } | { ok: false; reason: string }> {
    const a = this.seats.get(adopter);
    const c = this.seats.get(child);
    if (!a) return { ok: false, reason: `adopter ${adopter} is not a room seat` };
    if (!c) return { ok: false, reason: `${child} is not a room seat` };
    if (adopter === child) return { ok: false, reason: "a seat does not adopt itself" };
    if (this.isAncestor(child, adopter)) return { ok: false, reason: `${child} is above you` };
    if (!maySpawn(this.room.spawn, a.role, c.role, c.title))
      return {
        ok: false,
        reason: `a ${a.role} may own only ${(this.room.spawn[a.role] ?? []).join(", ") || "nothing"}, not this ${c.role}`,
      };
    const previous = this.parentOf(child);
    if (previous === adopter) return { ok: true, previous };
    if ((await this.status(child)) === "gone") return { ok: false, reason: `${child} is archived or gone` };
    const previousGone = !previous || (await this.status(previous)) === "gone";
    const adopterParent = this.parentOf(adopter);
    const sameChain =
      this.isAncestor(adopter, child) || (adopterParent !== null && this.isAncestor(adopterParent, child));
    if (!previousGone && !sameChain)
      return {
        ok: false,
        reason: `${child} still reports to a live seat that is not in your chain; only its chain may hand it over`,
      };
    this.adoptions.set(child, adopter);
    writeFileSync(ADOPTIONS_FILE, `${JSON.stringify(Object.fromEntries(this.adoptions), null, 2)}\n`);
    // Paseo's parent link is a label; moving it keeps its archive cascade off the adopted child
    try {
      await paseoCli(["agent", "update", child, "--label", `paseo.parent-agent-id=${adopter}`]);
    } catch (error) {
      this.log(
        `adopt: could not move the Paseo parent label of ${child}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.storeOf(child)?.note("adopted", child, { adopter, previous });
    return { ok: true, previous };
  }

  /** Live status of a seat, for callers that must not post to an archived one. */
  recipientStatus(agentId: string): Promise<Status> {
    return this.status(agentId);
  }

  /* ---------- post ---------- */

  private print(input: Pick<NewMail, "from" | "to" | "cc" | "subject" | "body">): string {
    const to = [[input.to].flat().join(","), [...(input.cc ?? [])].sort().join(",")].join("|");
    return createHash("sha256").update([input.from.agentId, to, input.subject, input.body].join("\n")).digest("hex");
  }

  /** The mail this one repeats: the same text within the window, or the sender's own key. */
  repeatOf(input: NewMail): Mail | null {
    const [first] = [input.to].flat();
    const store = this.storeOf(first, false);
    if (!store) return null;
    const print = this.print(input);
    const since = (ms: number) => new Date(this.now().getTime() - ms).toISOString();
    if (input.key) {
      const used = store.byKey(input.from.agentId, input.key, since(this.limits.keyHours * 3_600_000));
      if (used && used.fingerprint !== print)
        throw new MailError(
          "KEY_REUSED",
          `key \`${input.key}\` was used for another mail (#${used.message.id}); give a new key`,
        );
      if (used) return this.heldBy(store, used.message.id, first);
    }
    const same = store.duplicate(input.from.agentId, print, since(this.limits.dedupeSeconds * 1000));
    return same ? this.heldBy(store, same.id, first) : null;
  }

  private heldBy(store: MailStore, id: number, seat: string): Mail | null {
    const message = store.get(id);
    const delivery = store.deliveries(id).find((to) => to.seat === seat) ?? store.deliveries(id)[0];
    return message && delivery ? { ...message, ...delivery } : null;
  }

  /** The store all of a mail's recipients share; a mail goes to one project. */
  private shared(recipients: readonly string[]): MailStore {
    const dirs = new Set(recipients.map((seat) => this.folderOf(seat)));
    if (dirs.size > 1)
      throw new MailError("INVALID_ARGUMENT", "a mail goes to seats of one project; write to each project on its own");
    return this.storeOf(recipients[0])!;
  }

  private write(store: MailStore, input: NewMail, state: "queued" | "kept"): Mail {
    const to = [input.to].flat();
    const flags = {
      priority: input.priority,
      state,
      progress: input.progress === true,
      urgent: input.urgent === true,
      round: input.round ?? null,
      heldUntil: input.heldUntil ?? null,
    };
    const message = store.insert(
      {
        sender: input.from.agentId,
        senderRole: input.from.role,
        signal: signalFor(input.subject),
        subject: input.subject,
        body: input.body,
        needs: input.needs,
        why: input.why,
        thread: input.thread,
        replyTo: input.replyTo,
        files: input.files,
        fingerprint: this.print(input),
        key: input.key,
      },
      [
        ...to.map((seat) => ({ ...flags, seat, kind: input.kind ?? ("to" as Kind), quiet: input.quiet === true })),
        ...(input.cc ?? [])
          .filter((seat) => !to.includes(seat))
          .map((seat) => ({ ...flags, seat, kind: "cc" as Kind, priority: "fyi" as Priority, quiet: true })),
      ],
    );
    return this.heldBy(store, message.id, to[0])!;
  }

  /** Writes a mail's file and its thread's; the store stands when a file cannot be written. */
  private file(store: MailStore, dir: string, id: number): void {
    const message = store.get(id);
    if (!message) return;
    const deliveries = store.deliveries(id);
    try {
      const file = writeMessage(dir, { message, deliveries });
      store.revise(id, { file });
      const to = deliveries.map((d) =>
        this.label(d.seat, message.sender) === "owner"
          ? "owner"
          : seatLabel(this.seats.get(d.seat) ?? { role: "seat", agentId: d.seat, title: null }),
      );
      appendThread(dir, { ...message, file }, this.label(message.sender, deliveries[0]?.seat ?? ""), to.join(", "));
    } catch (error) {
      this.log(`mail: #${id} has no file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A mail that answers one: the ask it names, or its recipient's oldest open ask. */
  private settle(store: MailStore, mail: Mail, to: readonly string[]): void {
    if (mail.senderRole === "system") return;
    if (mail.replyTo) store.answer(mail.replyTo, mail.id);
    else if (to.length === 1 && ANSWERS.has(mail.signal)) {
      const ask = store.openAsk(to[0], mail.sender, mail.thread) ?? store.openAsk(to[0], mail.sender);
      if (ask) store.answer(ask.id, mail.id);
    }
  }

  async post(input: NewMail): Promise<Mail> {
    const to = [input.to].flat();
    const recipients = [...to, ...(input.cc ?? []).filter((seat) => !to.includes(seat))];
    const store = this.shared(recipients);
    const dir = this.folderOf(to[0]);
    let mail: Mail;
    if (input.id !== undefined) {
      // a report kept for its sender's turn end: it goes out as it stands now
      store.revise(input.id, { body: input.body, why: input.why ?? "" });
      store.revive(input.id, to[0]);
      store.hold(input.id, to[0], input.round ?? null, input.heldUntil ?? null);
      mail = this.heldBy(store, input.id, to[0])!;
    } else mail = this.write(store, input, "queued");
    this.file(store, dir, mail.id);
    this.settle(store, mail, to);
    for (const seat of recipients) await this.deliver(seat);
    return this.heldBy(store, mail.id, to[0])!;
  }

  /** A report written before its sender's turn ended: kept, one per seat, until that turn ends. */
  keepReport(input: NewMail): Mail {
    const store = this.shared([input.to].flat());
    for (const old of store.kept(input.from.agentId)) store.mark(old.seat, [old.id], "replaced");
    return this.write(store, input, "kept");
  }

  /** The report kept for this seat, taken out of waiting; null when it wrote none. */
  takeReport(agentId: string): NewMail | null {
    const store = this.storeOf(agentId, false);
    const kept = store?.kept(agentId)[0];
    if (!store || !kept) return null;
    store.mark(kept.seat, [kept.id], "withdrawn");
    return {
      id: kept.id,
      from: { agentId: kept.sender, role: kept.senderRole as Sender["role"] },
      to: kept.seat,
      priority: kept.priority,
      subject: kept.subject,
      body: kept.body,
      needs: kept.needs,
      why: kept.why,
      quiet: kept.quiet,
      progress: kept.progress,
      urgent: kept.urgent,
      thread: kept.thread,
    };
  }

  /** Drops the progress reports of `from` still waiting for `to`: a newer one is on its way. */
  dropProgress(from: string, to: string): void {
    const store = this.storeOf(to, false);
    const stale = store?.queued(to).filter((mail) => mail.progress && mail.sender === from && mail.state === "queued");
    if (store && stale?.length)
      store.mark(
        to,
        stale.map((mail) => mail.id),
        "replaced",
      );
  }

  /** The last reviewer of a round is in, or will not come: its held reports wait no longer. */
  async release(agentId: string, round: string): Promise<void> {
    this.storeOf(agentId, false)?.release(agentId, round);
    await this.deliver(agentId);
  }

  /** What waits for a replaced seat waits for its successor. */
  async move(from: string, to: string): Promise<void> {
    this.storeOf(from, false)?.readdress(from, to);
    await this.deliver(to);
  }

  /** The mail that started this seat's current turn; empty when something else did. Read once. */
  takeWake(agentId: string): Mail[] {
    const mails = this.woke.get(agentId) ?? [];
    this.woke.delete(agentId);
    return mails;
  }

  /** Mail held for a seat, without delivering it. */
  held(agentId: string): Mail[] {
    return this.storeOf(agentId, false)?.queued(agentId) ?? [];
  }

  /** The asks that reached a seat and still wait for its answer; undefined when it owes none. */
  owes(agentId: string): { asks: number; oldestAt: string } | undefined {
    const owed = this.storeOf(agentId, false)?.owedBy(agentId) ?? [];
    return owed.length > 0 ? { asks: owed.length, oldestAt: owed[0].at } : undefined;
  }

  /** Hands a seat its held mail (seatwork_inbox); mail on its way out is left alone. */
  takeHeld(agentId: string, peek = false): Mail[] {
    const store = this.storeOf(agentId, false);
    const mails = store?.queued(agentId).filter((mail) => mail.state === "queued") ?? [];
    if (store && !peek)
      store.mark(
        agentId,
        mails.map((mail) => mail.id),
        "read",
        "inbox",
      );
    return mails;
  }

  /** A mail as a seat reads it: whole when asked for by id, else cut where its file takes over. */
  shown(mail: Mail, reader: string, whole = false): Parameters<typeof digest>[0][number] {
    return {
      message: mail,
      delivery: mail,
      from: this.label(mail.sender, reader),
      rank: PRIORITY_RANK[mail.priority],
      ...(whole ? {} : { chars: mail.quiet ? this.limits.quietChars : this.limits.mailChars }),
    };
  }

  /* ---------- deliver ---------- */

  private async bounce(store: MailStore, agentId: string, queue: readonly Mail[]): Promise<void> {
    store.mark(
      agentId,
      queue.map((mail) => mail.id),
      "bounced",
    );
    const who = this.seats.get(agentId);
    for (const mail of queue) {
      if (mail.senderRole === "system" || !this.seats.has(mail.sender)) continue;
      // a sender that waited must learn no answer will come; one that asked nothing reads it later
      const waited = mail.needs !== "nothing";
      await this.post({
        from: { agentId: "room", role: "system" },
        to: mail.sender,
        priority: waited ? "action" : "fyi",
        subject: `UNDELIVERABLE: #${mail.id} re: ${mail.subject}`.slice(0, config.subjectChars),
        body: `Your mail to ${who ? `${who.role} ${agentId}` : agentId} was not delivered: that seat is archived or gone. Nothing is waiting on it. If the work still matters, launch a new seat with the brief and what was tried.`,
        needs: "nothing",
        why: "the recipient of a mail you sent no longer exists",
        thread: mail.thread,
        quiet: !waited,
      });
    }
  }

  /** Delivery pass for one recipient. Safe to call often. */
  async deliver(agentId: string): Promise<void> {
    if (this.delivering.has(agentId)) return;
    const store = this.storeOf(agentId, false);
    if (!store) return;
    this.delivering.add(agentId);
    try {
      if (store.queued(agentId).length === 0) return;
      const status = await this.status(agentId);
      // read after the wait: mail posted meanwhile is in the store now
      const queue = store.queued(agentId);
      if (status === "gone") return await this.bounce(store, agentId, queue);
      // a stop order does not wait for the turn, or the permission prompt, it finds
      const stops = status !== "idle" && queue.some((mail) => mail.urgent);
      if (status === "unknown" || (status === "permission" && !stops)) return;
      const now = this.now().getTime();
      let send: Mail[];
      if (status === "idle" || stops) {
        // quiet mail starts no turn; it goes out with the first mail that does
        send = queue.some((mail) => !startsNoTurn(mail, now)) ? queue : [];
      } else {
        // running: only harnesses whose steer waits for the current tool call get mail mid-turn
        const harness = parseSeat(this.seats.get(agentId)?.provider)?.harness;
        const mode = harness ? this.policy.midTurn[harness] : "hold";
        send = mode === "steer" ? queue.filter((m) => m.priority !== "fyi" || !this.policy.holdFyiWhileRunning) : [];
      }
      if (send.length === 0) return;
      const ids = send.map((mail) => mail.id);
      const text = digest(send.map((mail) => this.shown(mail, agentId)));
      // marked in the store until the daemon has it: a process that dies here loses nothing
      store.mark(agentId, ids, "sending");
      const opensTurn = status === "idle" || stops;
      if (opensTurn) this.woke.set(agentId, send);
      try {
        // the SDK interrupts a running agent by default; the room does so for a stop order only
        const activeTurnBehavior = stops ? "interrupt" : "steer";
        await this.paseo.agents.ref(agentId).send(text, { activeTurnBehavior } as never);
      } catch (error) {
        // refused, so nothing arrived: the mail waits as it was
        if (opensTurn) this.woke.delete(agentId);
        store.mark(agentId, ids, "queued", "delivery-failed");
        this.log(`mail: delivery to ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      store.mark(agentId, ids, "delivered", status === "idle" ? "idle" : stops ? "interrupt" : "steer");
    } finally {
      this.delivering.delete(agentId);
    }
  }

  /** Delivers what is held, and posts the kept reports whose turn end never reached the room. */
  async sweep(): Promise<void> {
    for (const store of this.known()) {
      for (const seat of store.waiting().keys()) await this.deliver(seat);
      for (const kept of store.kept()) {
        const status = await this.status(kept.sender);
        if (status !== "idle" && status !== "gone") continue;
        const report = this.takeReport(kept.sender);
        if (report) await this.post(report);
      }
    }
  }

  /* ---------- the record ---------- */

  /** Who sent a mail of a seat's project, and to whom; null when unknown. */
  lookupMail(id: number, forSeat: string): { from: string; to: string[]; thread: string } | null {
    const store = this.storeOf(forSeat, false);
    const message = store?.get(id);
    if (!store || !message) return null;
    return { from: message.sender, to: store.deliveries(id).map((d) => d.seat), thread: message.thread };
  }

  /** What was posted in every project since `since`, a line per recipient, oldest first. */
  posted(since: string): PostedLine[] {
    return this.known()
      .flatMap((store) => store.posted(since))
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Drops finished mail older than `before` from every store, with its files; returns how many. */
  prune(before: string, stays: (subject: string) => boolean): number {
    let gone = 0;
    for (const store of this.known()) {
      const pruned = store.prune(before, stays);
      dropFiles(pruned.files);
      gone += pruned.messages;
    }
    return gone;
  }

  /** `idle` is any seat a message starts a turn in: at rest, closed, or after a failed turn. */
  private async status(agentId: string): Promise<Status> {
    const handle = this.paseo.agents.ref(agentId);
    try {
      await handle.refresh();
    } catch {
      // a lost connection or a timeout proves nothing about the seat
      return "unknown";
    }
    const snapshot = handle.current() as {
      status?: string;
      archivedAt?: string | null;
      pendingPermissions?: unknown[];
    } | null;
    // the daemon answered: it has no such agent (deleted), or the agent is archived
    if (!snapshot || snapshot.archivedAt) return "gone";
    if (waitsOnSomeone(snapshot)) return "permission";
    if (snapshot.status === "running") return "running";
    if (snapshot.status === "idle" || snapshot.status === "closed" || snapshot.status === "error") return "idle";
    // initializing: its session is still opening
    return "unknown";
  }
}
