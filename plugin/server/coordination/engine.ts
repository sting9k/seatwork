import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import config from "../../shared/mail.json";
import { REGISTRY_LOG, ROOM_HOME } from "../paths";
import { writeJson } from "../persisted";
import type { MailPolicy, MidTurnDelivery } from "../policy";
import { inRoom, maySpawn, SPAWN } from "../../shared/workflow";
import { ANSWERS, subjectOpening } from "../signals";
import { MailError, mayWrite, type Directory, type SeatRecord } from "./address";
import {
  appendThread,
  countFiles,
  dropFiles,
  forgetSettled,
  readArchive,
  readSettled,
  threadFile,
  writeMessage,
} from "./archive";
import { digest, seatLabel } from "./envelope";
import { MailStore, type Held, type Kind, type Message, type Needs, type PostedLine, type Priority } from "./store";

/** The room's mail: kept per project, checked against the routes, handed to a seat at rest. */

export type { SeatRecord } from "./address";
export type { Needs, Priority } from "./store";

export interface Sender {
  agentId: string;
  role: string;
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

/** How much of a body is shown; how long repeats and keys count; how long a write waits. */
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

/** `idle` is any seat a message starts a turn in: at rest, closed, or after a failed turn. */
export type Status = "idle" | "running" | "permission" | "unknown" | "gone";

/** What mail needs from the app that runs the seats. */
export interface MailHost {
  state(agentId: string): Promise<Status>;
  /** A seat at rest starts a turn on the text; `interrupt` ends a running turn first, else it steers. */
  send(agentId: string, text: string, interrupt: boolean): Promise<void>;
  /** Moves the app's own record of a seat's parent. */
  reparent(child: string, parent: string): Promise<void>;
}

const MAIL_DIR = join(".seatwork", ".mail");
const ROOM_MAIL = join(ROOM_HOME, "mail");
const ADOPTIONS_FILE = join(ROOM_MAIL, "adoptions.json");
const DEFAULTS: MailLimits = {
  mailChars: 6000,
  quietChars: 600,
  dedupeSeconds: 300,
  keyHours: 24,
  busyTimeoutMs: 5000,
};
const PRIORITY_RANK: Record<Priority, number> = { blocking: 0, action: 1, fyi: 2 };
const ASKS_WEIGHED = 8;

const startsNoTurn = (mail: Held, now: number) => mail.quiet || (!!mail.heldUntil && now < Date.parse(mail.heldUntil));

/** The word a subject opens with: one of the room's signals, or a notice's own name. */
const signalFor = (subject: string) =>
  subjectOpening(subject) ?? subject.split(":")[0].replace(/^\W+/, "").trim().slice(0, 40).toUpperCase();

export class MailEngine implements Directory {
  /** What another district adds to a seat's delivered mail, and the call that marks it told. */
  appendix: ((agentId: string) => { text: string; told(): void } | null) | null = null;
  /** Which of several open asks an answer that names none settles, `ask` null for none of them; null keeps the oldest. Another district gives it. */
  chooseAsk: ((answer: Mail, asks: readonly Message[]) => Promise<{ ask: number | null } | null>) | null = null;

  private readonly seats = new Map<string, SeatRecord>();
  private readonly adoptions = new Map<string, string>();
  private readonly stores = new Map<string, MailStore>();
  private readonly delivering = new Set<string>();
  private readonly again = new Set<string>();
  private readonly woke = new Map<string, Mail[]>();
  private readonly roots = new Map<string, string | null>();
  private readonly paused = new Set<string>();
  private readonly unwell = new Map<
    string,
    { state: "damaged" | "rebuilt" | "drifted"; since: string; detail: string }
  >();
  private readonly limits: MailLimits;
  private readonly now: () => Date;

  constructor(
    private readonly host: MailHost,
    private readonly policy: MailPolicy,
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

  /** A seat's project: that of the top seat of its project's tree, so a worktree elsewhere shares it. */
  projectOf(agentId: string): string | null {
    if (this.roots.has(agentId)) return this.roots.get(agentId)!;
    const chain: string[] = [];
    for (let id: string | null = agentId; id && chain.length < 16; id = this.parentOf(id)) {
      chain.push(id);
      const parent = this.parentOf(id);
      if (inRoom(this.seats.get(id)?.role) || inRoom(parent ? this.seats.get(parent)?.role : undefined)) break;
    }
    let root: string | null = null;
    for (const id of chain.reverse()) {
      const cwd = this.seats.get(id)?.cwd;
      try {
        root = cwd ? (this.options.rootOf?.(cwd) ?? null) : null;
      } catch (error) {
        this.log(`mail: the project of ${cwd} could not be read: ${(error as Error).message}`);
      }
      if (root) break;
    }
    this.roots.set(agentId, root);
    return root;
  }

  /** The folder of a seat's mail: its project's, or the room home's for a seat in no project. */
  folderOf(agentId: string): string {
    const root = this.projectOf(agentId);
    return root ? join(root, MAIL_DIR) : ROOM_MAIL;
  }

  private open(dir: string, create: boolean): MailStore | null {
    const known = this.stores.get(dir);
    if (known) return known;
    // a folder that holds mail files and no store lost its store: opening it reads the files back
    if (!create && !existsSync(join(dir, "mail.db")) && !existsSync(join(dir, ".gitignore"))) return null;
    const since = this.now().toISOString();
    // only a store that is new on disk was lost: one that merely holds no mail now has had its mail pruned
    const fresh = !existsSync(join(dir, "mail.db"));
    let store: MailStore;
    try {
      store = new MailStore(dir, this.limits.busyTimeoutMs, this.now);
    } catch (error) {
      this.unwell.set(dir, { state: "damaged", since, detail: (error as Error).message });
      throw error;
    }
    this.unwell.delete(dir);
    // a store that lost its file, or was set aside as damaged, gets its mail back from the files
    if ((fresh || store.startedOver) && store.count() === 0) {
      const archived = readArchive(dir);
      if (archived.length > 0) {
        const back = store.restore(archived, readSettled(dir));
        this.log(`mail: rebuilt ${back} mails of ${dir} from their files`);
        this.unwell.set(dir, {
          state: "rebuilt",
          since,
          detail: `${store.startedOver ? "its database was damaged and set aside" : "its database was gone"}; ${back} mails were read back from their files`,
        });
      }
    }
    const files = countFiles(dir);
    if (files > store.count())
      this.unwell.set(dir, {
        state: "drifted",
        since,
        detail: `${files} mail files and ${store.count()} mails in the store: mail written to its file never reached the store`,
      });
    this.stores.set(dir, store);
    return store;
  }

  /** The mails after `id` in a project's store, or the room home's for `null`; none where no store exists. */
  mailAfter(root: string | null, id: number, limit: number): (Message & { to: string[] })[] {
    return this.open(root ? join(root, MAIL_DIR) : ROOM_MAIL, false)?.after(id, limit) ?? [];
  }

  /** The stores a reader of every project asks for: `all`, or one project by its folder or folder name. */
  storesAt(project: string): { folder: string; store: MailStore | null; error?: string }[] {
    const roots = this.projects().filter((root) => project === "all" || root === project || basename(root) === project);
    return roots.map((root) => {
      const folder = join(root, MAIL_DIR);
      try {
        return { folder: root, store: this.open(folder, false) };
      } catch (error) {
        return { folder: root, store: null, error: (error as Error).message };
      }
    });
  }

  /** A successor's view of a seat's mail: its threads, what is owed there, each file. */
  threadsFor(seat: string, limit = 8): string[] {
    const store = this.storeOf(seat, false);
    if (!store) return [];
    const owes = store.owedBy(seat);
    const awaits = store.owedTo(seat);
    return store.threadsOf(seat, limit).map(({ thread, last, count }) => {
      const open = [
        ...owes.filter((ask) => ask.thread === thread).map((ask) => `it owes an answer to #${ask.id}`),
        ...awaits.filter((ask) => ask.thread === thread).map((ask) => `it waits for the answer to #${ask.id}`),
      ];
      return `- ${thread}: ${count} mail${count === 1 ? "" : "s"}, the last #${last.id} "${last.subject}" from ${this.label(last.sender, seat)}${open.length ? `; ${open.join("; ")}` : ""}. The thread: ${threadFile(this.folderOf(seat), thread)}`;
    });
  }

  /** The project folders of the seats the room knows. */
  projects(): string[] {
    return [...new Set([...this.seats.keys()].map((id) => this.projectOf(id)))].filter((root) => root !== null);
  }

  /** The stores that are not well: damaged, read back from their files, or short of their files. */
  health(): { folder: string; state: "damaged" | "rebuilt" | "drifted"; since: string; detail: string }[] {
    return [...this.unwell].map(([folder, ill]) => ({ folder, ...ill }));
  }

  /** Withdraws unread mail sent only to be read, before `before`, in every store. */
  expire(before: string): number {
    let gone = 0;
    for (const store of this.known()) {
      try {
        gone += store.expire(before);
      } catch (error) {
        this.log(`mail: expiring unread mail failed in one store: ${(error as Error).message}`);
      }
    }
    return gone;
  }

  /** How the room answers its asks since `since`, and the refusals of its mail tools by code. */
  answering(since: string): { minutes: number[]; open: number; refusals: Map<string, number> } {
    const out = { minutes: [] as number[], open: 0, refusals: new Map<string, number>() };
    for (const store of this.known()) {
      const replies = store.replies(since);
      out.minutes.push(...replies.minutes);
      out.open += replies.open;
      for (const [code, n] of store.refusals(since)) out.refusals.set(code, (out.refusals.get(code) ?? 0) + n);
    }
    return out;
  }

  /** The store a seat's mail lives in; null when `create` is off and none was ever written. */
  storeOf(agentId: string, create = true): MailStore | null {
    return this.open(this.folderOf(agentId), create);
  }

  /** Every store that holds mail of a seat the room knows. */
  private known(): MailStore[] {
    const dirs = new Set([ROOM_MAIL, ...[...this.seats.keys()].map((id) => this.folderOf(id))]);
    return [...dirs].flatMap((dir) => {
      try {
        return this.open(dir, false) ?? [];
      } catch (error) {
        this.log(`mail: the store of ${dir} cannot be opened: ${(error as Error).message}`);
        return [];
      }
    });
  }

  /** Runs `work` on each store; one that fails is said in the log and passed over. */
  private each(what: string, work: (store: MailStore) => void | Promise<void>): Promise<void> {
    return this.known().reduce(
      (done, store) =>
        done.then(async () => {
          try {
            await work(store);
          } catch (error) {
            this.log(`mail: ${what} failed in one store: ${(error as Error).message}`);
          }
        }),
      Promise.resolve(),
    );
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }

  private loadAdoptions(): void {
    if (!existsSync(ADOPTIONS_FILE)) return;
    try {
      for (const [child, parent] of Object.entries(
        JSON.parse(readFileSync(ADOPTIONS_FILE, "utf8")) as Record<string, string>,
      ))
        this.adoptions.set(child, parent);
    } catch (error) {
      this.log(
        `mail: ${ADOPTIONS_FILE} could not be read; seats adopted before start under their first owner: ${String(error)}`,
      );
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
      } catch {}
    }
  }

  rememberSeat(seat: SeatRecord): void {
    this.seats.set(seat.agentId, seat);
    this.roots.delete(seat.agentId);
  }

  seat(agentId: string): SeatRecord | undefined {
    return this.seats.get(agentId);
  }

  /** Every seat ever registered, oldest first. */
  allSeats(): SeatRecord[] {
    return [...this.seats.values()];
  }

  /** The seat a seat reports to: its adopter when adopted, else the parent it was created under. */
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
    return mayWrite(this, from, to, viaReply);
  }

  /** The seats whose mail a seat may read: itself and every seat under it; null for all. */
  seenBy(agentId: string): string[] | null {
    if (inRoom(this.seats.get(agentId)?.role)) return null;
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
  ): Promise<{ ok: true; previous: string | null; linkMoved: boolean } | { ok: false; reason: string }> {
    const a = this.seats.get(adopter);
    const c = this.seats.get(child);
    if (!a) return { ok: false, reason: `adopter ${adopter} is not a room seat` };
    if (!c) return { ok: false, reason: `${child} is not a room seat` };
    if (adopter === child) return { ok: false, reason: "a seat does not adopt itself" };
    if (this.isAncestor(child, adopter)) return { ok: false, reason: `${child} is above you` };
    if (!maySpawn(a.role, c.role, c.title))
      return {
        ok: false,
        reason: `a ${a.role} may own only ${(SPAWN[a.role] ?? []).join(", ") || "nothing"}, not this ${c.role}`,
      };
    const previous = this.parentOf(child);
    if (previous === adopter) return { ok: true, previous, linkMoved: true };
    if ((await this.host.state(child)) === "gone") return { ok: false, reason: `${child} is archived or gone` };
    const previousGone = !previous || (await this.host.state(previous)) === "gone";
    const adopterParent = this.parentOf(adopter);
    const sameChain =
      this.isAncestor(adopter, child) || (adopterParent !== null && this.isAncestor(adopterParent, child));
    if (!previousGone && !sameChain)
      return {
        ok: false,
        reason: `${child} still reports to a live seat that is not in your chain; only its chain may hand it over`,
      };
    this.adoptions.set(child, adopter);
    this.roots.clear();
    writeJson(ADOPTIONS_FILE, Object.fromEntries(this.adoptions));
    // the app's own parent link moves too: an archive of the old parent must not take the child along
    let linkMoved = true;
    try {
      await this.host.reparent(child, adopter);
    } catch (error) {
      linkMoved = false;
      this.log(
        `adopt: the app kept ${child} under its old parent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.storeOf(child)?.note("adopted", child, { adopter, previous });
    return { ok: true, previous, linkMoved };
  }

  /** Live status of a seat, for callers that must not post to an archived one. */
  recipientStatus(agentId: string): Promise<Status> {
    return this.host.state(agentId);
  }

  private print(input: NewMail): string {
    const to = [[input.to].flat().join(","), [...(input.cc ?? [])].sort().join(",")].join("|");
    const said = [
      input.from.agentId,
      to,
      input.subject,
      input.body,
      input.replyTo ?? "",
      input.thread ?? "",
      input.needs,
    ];
    // a list as JSON: a field holding the separator can never pass for two fields
    return createHash("sha256")
      .update(JSON.stringify([...said, ...(input.files ?? [])]))
      .digest("hex");
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

  /** A mail that answers one: the ask it names; else, of its recipient's open asks, the one `chooseAsk` picks or the oldest. */
  private async settle(store: MailStore, mail: Mail, to: readonly string[]): Promise<void> {
    if (mail.senderRole === "system") return;
    if (mail.replyTo) {
      if (store.deliveries(mail.replyTo).some((to) => to.seat === mail.sender && to.kind === "to"))
        store.answer(mail.replyTo, mail.id);
      return;
    }
    if (to.length !== 1 || !ANSWERS.has(mail.signal)) return;
    const inThread = store.openAsks(to[0], mail.sender, mail.thread, ASKS_WEIGHED);
    const asks = inThread.length ? inThread : store.openAsks(to[0], mail.sender, null, ASKS_WEIGHED);
    if (asks.length === 0) return;
    const chosen =
      asks.length > 1 && this.chooseAsk
        ? await this.chooseAsk(mail, asks).catch((error) => {
            this.log(
              `mail: no ask was chosen for #${mail.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })
        : null;
    if (chosen?.ask === null) return;
    store.answer(asks.find((ask) => ask.id === chosen?.ask)?.id ?? asks[0].id, mail.id);
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
    await this.settle(store, mail, to);
    for (const seat of recipients) await this.deliver(seat);
    return this.heldBy(store, mail.id, to[0])!;
  }

  /** A report taken at its sender's turn end goes out; one that fails to is kept again for the next pass, never lost. */
  async postReport(report: NewMail): Promise<Mail> {
    try {
      return await this.post(report);
    } catch (error) {
      if (report.id !== undefined) this.storeOf(report.from.agentId, false)?.keepAgain(report.id);
      throw error;
    }
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
      from: { agentId: kept.sender, role: kept.senderRole },
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

  /** A seat being replaced takes no mail: it waits until the successor can be handed it. */
  pause(agentId: string): void {
    this.paused.add(agentId);
  }

  unpause(agentId: string): void {
    this.paused.delete(agentId);
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

  /** Hands a seat its held mail; mail on its way out is left alone. */
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

  private async bounce(store: MailStore, agentId: string, queue: readonly Mail[]): Promise<void> {
    store.mark(
      agentId,
      queue.map((mail) => mail.id),
      "bounced",
    );
    const who = this.seats.get(agentId);
    for (const mail of queue) {
      if (mail.kind !== "to" || mail.senderRole === "system" || !this.seats.has(mail.sender)) continue;
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

  /** Delivery pass for one recipient, with what another district's `appendix` adds to it. Safe to call often. */
  async deliver(agentId: string): Promise<void> {
    if (this.paused.has(agentId)) return;
    // mail posted while a pass is under way gets a pass of its own right after, not at the next sweep
    if (this.delivering.has(agentId)) {
      this.again.add(agentId);
      return;
    }
    const store = this.storeOf(agentId, false);
    if (!store) return;
    this.delivering.add(agentId);
    try {
      if (store.queued(agentId).length === 0) return;
      const status = await this.host.state(agentId);
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
        // a seat is the provider <agent CLI>-<role>: how its CLI takes mail mid-turn is its own
        const provider = this.seats.get(agentId)?.provider ?? "";
        const midTurn: Partial<Record<string, MidTurnDelivery>> = this.policy.midTurn;
        const mode = midTurn[provider.split("-")[0]] ?? "hold";
        send = mode === "steer" ? queue.filter((m) => m.priority !== "fyi" || !this.policy.holdFyiWhileRunning) : [];
      }
      if (send.length === 0) return;
      const ids = send.map((mail) => mail.id);
      const extra = this.appendix?.(agentId) ?? null;
      const text = [digest(send.map((mail) => this.shown(mail, agentId))), extra?.text].filter(Boolean).join("\n\n");
      // marked in the store until the daemon has it: a process that dies here loses nothing
      store.mark(agentId, ids, "sending");
      const opensTurn = status === "idle" || stops;
      if (opensTurn) this.woke.set(agentId, send);
      try {
        await this.host.send(agentId, text, stops);
      } catch (error) {
        // refused, so nothing arrived: the mail waits as it was
        if (opensTurn) this.woke.delete(agentId);
        store.mark(agentId, ids, "queued", "delivery-failed");
        this.log(`mail: delivery to ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      store.mark(agentId, ids, "delivered", status === "idle" ? "idle" : stops ? "interrupt" : "steer");
      try {
        extra?.told();
      } catch (error) {
        this.log(`mail: what went out with the mail of ${agentId} was not marked: ${String(error)}`);
      }
    } finally {
      this.delivering.delete(agentId);
      if (this.again.delete(agentId))
        void this.deliver(agentId).catch((error) =>
          this.log(`mail: a second pass for ${agentId} failed: ${String(error)}`),
        );
    }
  }

  /** Delivers what is held, and posts the kept reports whose turn end never reached the room. */
  async sweep(): Promise<void> {
    await this.each("the sweep", async (store) => {
      for (const seat of store.waiting().keys()) await this.deliver(seat);
      for (const kept of store.kept()) {
        const status = await this.host.state(kept.sender);
        if (status !== "idle" && status !== "gone") continue;
        const report = this.takeReport(kept.sender);
        if (report) await this.postReport(report);
      }
    });
  }

  /** A mail tool refused a seat: counted by its code in the seat's project. */
  noteRefusal(seat: string, code: string): void {
    try {
      this.storeOf(seat)?.note("refused", seat, { code });
    } catch {
      // a count is not worth a second failure
    }
  }

  /** A seat's permission request was answered in the app: its PERMISSION mail is owed no more. */
  settlePermission(agentId: string): void {
    this.storeOf(agentId, false)?.closeAsks(agentId, "PERMISSION");
  }

  /** Who sent a mail of a seat's project, and to whom; null when unknown. */
  lookupMail(id: number, forSeat: string): { from: string; to: string[]; thread: string } | null {
    const store = this.storeOf(forSeat, false);
    const message = store?.get(id);
    if (!store || !message) return null;
    return { from: message.sender, to: store.deliveries(id).map((to) => to.seat), thread: message.thread };
  }

  /** What was posted in every project since `since`, a line per recipient, oldest first. */
  posted(since: string): PostedLine[] {
    return this.known()
      .flatMap((store) => {
        try {
          return store.posted(since);
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Drops finished mail older than `before` from every store, with its files; returns how many. */
  prune(before: string): number {
    let gone = 0;
    for (const store of this.known()) {
      try {
        const pruned = store.prune(before);
        dropFiles(store.folder, pruned.files, pruned.threads);
        forgetSettled(store.folder, pruned.ids);
        gone += pruned.messages;
      } catch (error) {
        this.log(`mail: pruning one store failed: ${(error as Error).message}`);
      }
    }
    return gone;
  }
}
