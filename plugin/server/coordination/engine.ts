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
import {
  DRAFT,
  MailStore,
  TAKEN,
  type Held,
  type Kind,
  type Message,
  type Needs,
  type PostedLine,
  type Priority,
  type WakeAdded,
  type WakeUp,
} from "./store";
import { dueOf, noteOf, wakeBody, wakeSubject, type WakeAsk } from "./wakeup";

/** The room's mail: kept per project, checked against the routes, handed to a seat at rest. */

export type { SeatRecord } from "./address";
export type { Needs, Priority } from "./store";

/** The seat a mail comes from, and its role. */
interface Sender {
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
interface MailLimits {
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

/** What mail needs from the app that runs the seats: a seat's status, a text sent to it (a turn on it at rest; `interrupt` ends a running turn first, else it steers; the same `id` again arrives once), its parent moved. */
interface MailHost {
  state(agentId: string): Promise<Status>;
  send(agentId: string, text: string, interrupt: boolean, id?: string): Promise<void>;
  reparent(child: string, parent: string): Promise<void>;
}

const MAIL_DIR = join(".seatwork", ".mail");
export const ROOM_MAIL = join(ROOM_HOME, "mail");
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

/** Whether a mail is held until a time after `now`. */
const heldAt = (mail: { heldUntil?: string | null }, now: number) =>
  !!mail.heldUntil && now < Date.parse(mail.heldUntil);

const sum = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The word a subject opens with: one of the room's signals, or a notice's own name. */
const signalFor = (subject: string) =>
  subjectOpening(subject) ?? subject.split(":")[0].replace(/^\W+/, "").trim().slice(0, 40).toUpperCase();

/** The room's mail: its seats, its stores and delivery to a seat at rest; `appendix`, `chooseAsk` and `holds` are hooks other districts set. */
export class MailEngine implements Directory {
  appendix: ((agentId: string) => { text: string; told(): void } | null) | null = null;
  chooseAsk: ((answer: Mail, asks: readonly Message[]) => Promise<{ ask: number | null } | null>) | null = null;
  holds: ((agentId: string) => string | null) | null = null;

  private readonly seats = new Map<string, SeatRecord>();
  private readonly adoptions = new Map<string, string>();
  private readonly stores = new Map<string, MailStore>();
  private readonly delivering = new Set<string>();
  private readonly again = new Set<string>();
  private readonly firing = new Set<MailStore>();
  private readonly woke = new Map<string, Mail[]>();
  private readonly unsure = new Map<string, { id: string; ids: number[]; text: string; interrupt: boolean }>();
  private readonly spent = new Map<string, { made: string; times: number }>();
  private readonly roots = new Map<string, string | null>();
  private readonly listedAt = new Map<string, number>();
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
    let unread = false;
    for (const id of chain.reverse()) {
      const cwd = this.seats.get(id)?.cwd;
      try {
        root = cwd ? (this.options.rootOf?.(cwd) ?? null) : null;
      } catch (error) {
        unread = true;
        this.log(`mail: the project of ${cwd} could not be read: ${(error as Error).message}`);
      }
      if (root) break;
    }
    // an answer that failed is asked again, never remembered as none; a word that is no seat is never remembered
    if (!unread && this.seats.has(agentId)) this.roots.set(agentId, root);
    return root;
  }

  /** The folder of a seat's mail: its project's, or the room home's for a seat in no project. */
  folderOf(agentId: string): string {
    const root = this.projectOf(agentId);
    return root ? join(root, MAIL_DIR) : ROOM_MAIL;
  }

  /** The store of a folder, opened once; null where none exists and `create` is off. A lost or damaged one is read back from the files. */
  private open(dir: string, create: boolean): MailStore | null {
    const known = this.stores.get(dir);
    if (known) return known;
    // a folder that holds mail files and no store lost its store: opening it reads the files back
    if (!create && !existsSync(join(dir, "mail.db")) && !existsSync(join(dir, ".gitignore"))) return null;
    const since = this.now().toISOString();
    // only a store that is new on disk was lost: one that merely holds no mail now has had its mail pruned
    const fresh = !existsSync(join(dir, "mail.db"));
    let store: MailStore | undefined;
    try {
      store = new MailStore(dir, this.limits.busyTimeoutMs, this.now);
      this.settleOpening(store, dir, fresh, since);
      this.stores.set(dir, store);
      return store;
    } catch (error) {
      store?.close();
      this.unwell.set(dir, { state: "damaged", since, detail: (error as Error).message });
      throw error;
    }
  }

  /** What a store just opened gets: its mail back from the files when it lost its file, reports taken by a stopped process kept again, a check against the files. */
  private settleOpening(store: MailStore, dir: string, fresh: boolean, since: string): void {
    this.unwell.delete(dir);
    // a store that lost its file, or was set aside as damaged, gets its mail and its wake-ups back from their files
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
      const woken = store.restoreWakeUps();
      if (woken > 0) this.log(`mail: ${woken} wake-ups of ${dir} read back from their copy`);
    }
    // a report taken to go out by a process that stopped is posted by the next sweep
    const taken = store.keepTaken();
    if (taken > 0) this.log(`mail: ${taken} reports taken to go out when the room stopped are kept for the next pass`);
    const files = countFiles(dir);
    if (files > store.count())
      this.unwell.set(dir, {
        state: "drifted",
        since,
        detail: `${files} mail files and ${store.count()} mails in the store: mail written to its file never reached the store`,
      });
  }

  /** The mail that went out after `id` in a project's store, or the room home's for `null`; none where no store exists. */
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
    return sum(this.across("expiring unread mail", (store) => store.expire(before)));
  }

  /** How the room answers its asks since `since`, and the refusals of its mail tools by code. */
  answering(since: string): { minutes: number[]; open: number; refusals: Map<string, number> } {
    const out = { minutes: [] as number[], open: 0, refusals: new Map<string, number>() };
    for (const { replies, refusals } of this.across("counting the answers", (store) => ({
      replies: store.replies(since),
      refusals: store.refusals(since),
    }))) {
      out.minutes.push(...replies.minutes);
      out.open += replies.open;
      for (const [code, n] of refusals) out.refusals.set(code, (out.refusals.get(code) ?? 0) + n);
    }
    return out;
  }

  /** The store a seat's mail lives in; null when `create` is off and none was ever written. */
  storeOf(agentId: string, create = true): MailStore | null {
    return this.open(this.folderOf(agentId), create);
  }

  /** Every store that holds mail of a seat the room knows. */
  private known(): MailStore[] {
    const dirs = new Set([ROOM_MAIL, ...this.projects().map((root) => join(root, MAIL_DIR))]);
    return [...dirs].flatMap((dir) => {
      try {
        return this.open(dir, false) ?? [];
      } catch (error) {
        this.log(`mail: the store of ${dir} cannot be opened: ${(error as Error).message}`);
        return [];
      }
    });
  }

  /** The result of `work` on each store; a store where it fails is said in the log and passed over. */
  private across<T>(what: string, work: (store: MailStore) => T): T[] {
    return this.known().flatMap((store) => {
      try {
        return [work(store)];
      } catch (error) {
        this.log(`mail: ${what} failed in one store: ${errorText(error)}`);
        return [];
      }
    });
  }

  /** Runs `work` for each item in turn; one that fails is said in the log and the rest still run. */
  private async each<T>(items: Iterable<T>, what: string, work: (item: T) => Promise<void>): Promise<void> {
    for (const item of items)
      try {
        await work(item);
      } catch (error) {
        this.log(`mail: ${what} failed: ${errorText(error)}`);
      }
  }

  /** Closes every store. */
  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }

  /** Reads the handovers made before this start from their file. */
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

  /** Reads the seats the room registered from its log. */
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
        // a torn line
      }
    }
  }

  /** Records a seat as registered; its project is worked out again. */
  rememberSeat(seat: SeatRecord): void {
    this.seats.set(seat.agentId, seat);
    this.roots.delete(seat.agentId);
  }

  /** A registered seat's record. */
  seat(agentId: string): SeatRecord | undefined {
    return this.seats.get(agentId);
  }

  /** Every seat registered and not forgotten, oldest first. */
  allSeats(): SeatRecord[] {
    return [...this.seats.values()];
  }

  /** Forgets the seats `listed` has lacked for `keepMs`, save those the room still needs: mail waiting, a seat below, the newest of a project; returns how many. */
  forgetGone(listed: ReadonlySet<string>, keepMs: number): number {
    const now = this.now().getTime();
    const ids = [...this.seats.keys()];
    for (const id of ids) if (listed.has(id) || !this.listedAt.has(id)) this.listedAt.set(id, now);
    const newest = new Map<string, string>();
    for (const id of ids) {
      const root = this.projectOf(id);
      if (root) newest.set(root, id);
    }
    const kept = new Set(newest.values());
    const waiting = (id: string) => {
      try {
        return (this.storeOf(id, false)?.queued(id).length ?? 0) > 0;
      } catch {
        return true;
      }
    };
    const gone = new Set(
      ids.filter((id) => !listed.has(id) && !kept.has(id) && now - this.listedAt.get(id)! >= keepMs && !waiting(id)),
    );
    const above = new Set<string>();
    for (const id of ids)
      if (!gone.has(id))
        for (let up = this.parentOf(id); up && !above.has(up); up = this.parentOf(up)) {
          above.add(up);
          gone.delete(up);
        }
    for (const id of gone) {
      this.seats.delete(id);
      this.listedAt.delete(id);
      for (const held of [this.woke, this.unsure, this.spent]) held.delete(id);
      this.paused.delete(id);
    }
    for (const id of this.roots.keys()) if (!this.seats.has(id)) this.roots.delete(id);
    if ([...gone].filter((id) => this.adoptions.delete(id)).length > 0)
      writeJson(ADOPTIONS_FILE, Object.fromEntries(this.adoptions));
    return gone.size;
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

  /** Whether a seat may write to another: the workflow's routes and the tree both allow it. */
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
      this.log(`adopt: the app kept ${child} under its old parent: ${errorText(error)}`);
    }
    this.storeOf(child)?.note("adopted", child, { adopter, previous });
    return { ok: true, previous, linkMoved };
  }

  /** Live status of a seat, for callers that must not post to an archived one. */
  recipientStatus(agentId: string): Promise<Status> {
    return this.host.state(agentId);
  }

  /** A digest of what a mail says and to whom, so the same text sent again is known for a repeat. */
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

  /** A mail as `seat` holds it, or as its first recipient does when `seat` is none of them. */
  private heldBy(store: MailStore, id: number, seat: string): Mail | null {
    const message = store.get(id);
    const deliveries = store.deliveries(id);
    const delivery = deliveries.find((to) => to.seat === seat) ?? deliveries[0];
    return message && delivery ? { ...message, ...delivery } : null;
  }

  /** The store all of a mail's recipients share; a mail goes to one project. */
  private shared(recipients: readonly string[]): MailStore {
    const dirs = new Set(recipients.map((seat) => this.folderOf(seat)));
    if (dirs.size > 1)
      throw new MailError("INVALID_ARGUMENT", "a mail goes to seats of one project; write to each project on its own");
    return this.storeOf(recipients[0])!;
  }

  /** Puts a new mail in the store with a delivery to each recipient, the copies quiet. */
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

  /** Writes a mail's file and, the first time only, its entry in its thread's; the store stands when a file cannot be written. */
  private file(store: MailStore, dir: string, id: number): void {
    const message = store.get(id);
    if (!message) return;
    const deliveries = store.deliveries(id);
    try {
      const file = writeMessage(dir, { message, deliveries });
      if (!message.file) {
        const to = deliveries.map((d) =>
          this.label(d.seat, message.sender) === "owner"
            ? "owner"
            : seatLabel(this.seats.get(d.seat) ?? { role: "seat", agentId: d.seat, title: null }),
        );
        appendThread(dir, { ...message, file }, this.label(message.sender, deliveries[0]?.seat ?? ""), to.join(", "));
      }
      store.revise(id, { file });
    } catch (error) {
      this.log(`mail: #${id} has no file: ${errorText(error)}`);
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
            this.log(`mail: no ask was chosen for #${mail.id}: ${errorText(error)}`);
            return null;
          })
        : null;
    if (chosen?.ask === null) return;
    store.answer(asks.find((ask) => ask.id === chosen?.ask)?.id ?? asks[0].id, mail.id);
  }

  /** Stores a mail, writes its files, settles the ask it answers and hands it to each recipient that can take it. */
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
    // the last report of a round is in: the reports held for it go out with it
    if (input.round && !heldAt(input, this.now().getTime())) store.release(to[0], input.round);
    this.file(store, dir, mail.id);
    await this.settle(store, mail, to);
    for (const seat of recipients) await this.deliver(seat);
    return this.heldBy(store, mail.id, to[0])!;
  }

  /** A report taken at its sender's turn end goes out; one that cannot be posted is kept again for the next pass, never lost. */
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
    for (const old of store.kept(input.from.agentId)) store.mark(old.seat, [old.id], "replaced", DRAFT);
    return this.write(store, input, "kept");
  }

  /** The report kept for this seat, taken out of waiting; null when it wrote none. */
  takeReport(agentId: string): NewMail | null {
    const store = this.storeOf(agentId, false);
    const kept = store?.kept(agentId)[0];
    if (!store || !kept) return null;
    store.mark(kept.seat, [kept.id], "withdrawn", TAKEN);
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

  /** The seat takes mail again. */
  unpause(agentId: string): void {
    this.paused.delete(agentId);
  }

  /** What waits for a replaced seat, its mail and its wake-ups, waits for its successor. */
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

  /** How many deliveries wait to reach their seats across the stores the room's seats use. */
  backlog(): number {
    return sum(this.known().map((store) => store.backlog()));
  }

  /** How many mails wait for a seat and since when the oldest has, and the reports held for their round with the first one's time; undefined when there are none. A held report is not waiting yet. Reads no body. */
  holding(
    agentId: string,
  ): { mails: number; oldestAt: string | null; later: number; dueAt: string | null } | undefined {
    const waiting = this.storeOf(agentId, false)?.waitingFor(agentId, this.now().toISOString());
    return waiting && { mails: waiting.count, oldestAt: waiting.since, later: waiting.later, dueAt: waiting.due };
  }

  /** The asks that reached a seat and still wait for its answer; undefined when it owes none. Reads no body. */
  owes(agentId: string): { asks: number; oldestAt: string } | undefined {
    const owed = this.storeOf(agentId, false)?.owedCount(agentId);
    return owed && { asks: owed.count, oldestAt: owed.since };
  }

  /** Of a seat's queue, the mail that may go out: a report still held for its round waits for its time, and once one report of a round is due the round goes whole. */
  private deliverable(store: MailStore, agentId: string, queue: readonly Held[], now: number): Held[] {
    const ripe = new Set(
      queue.flatMap((mail) => (mail.round && mail.heldUntil && !heldAt(mail, now) ? [mail.round] : [])),
    );
    for (const round of ripe) store.release(agentId, round);
    return queue.filter((mail) => !heldAt(mail, now) || (mail.round !== null && ripe.has(mail.round)));
  }

  /** Hands a seat the mail waiting for it; mail on its way out and reports not yet due are left alone. */
  takeHeld(agentId: string, peek = false): Mail[] {
    const store = this.storeOf(agentId, false);
    if (!store) return [];
    const queued = store.queued(agentId).filter((mail) => mail.state === "queued");
    const mails = this.deliverable(store, agentId, queued, this.now().getTime());
    if (!peek)
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

  /** Mail for a seat that is gone is bounced, and each sender is told. */
  private async bounce(store: MailStore, agentId: string, queue: readonly Mail[]): Promise<void> {
    this.unsure.delete(agentId);
    this.spent.delete(agentId);
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
    // a held seat takes only a stop order, which ends a running turn and its spending
    const held = this.holds?.(agentId) != null;
    if (held && !store.queued(agentId).some((mail) => mail.urgent)) return;
    this.delivering.add(agentId);
    try {
      if (this.deliverable(store, agentId, store.queued(agentId), this.now().getTime()).length === 0) return;
      const status = await this.host.state(agentId);
      // read after the wait: mail posted meanwhile is in the store now
      const queue = store.queued(agentId);
      if (status === "gone") return await this.bounce(store, agentId, queue);
      const ready = this.deliverable(store, agentId, queue, this.now().getTime());
      // a stop order does not wait for the turn, or the permission prompt, it finds
      const stops = status !== "idle" && ready.some((mail) => mail.urgent);
      if (status === "unknown" || (status === "permission" && !stops)) return;
      let send: Mail[];
      if (held) send = stops ? ready.filter((mail) => mail.urgent) : [];
      else if (status === "idle" || stops) {
        // quiet mail starts no turn; it goes out with the first mail that does
        send = ready.some((mail) => !mail.quiet) ? ready : [];
      } else {
        // running: only harnesses whose steer waits for the current tool call get mail mid-turn
        // a seat is the provider <agent CLI>-<role>: how its CLI takes mail mid-turn is its own
        const provider = this.seats.get(agentId)?.provider ?? "";
        const midTurn: Partial<Record<string, MidTurnDelivery>> = this.policy.midTurn;
        const mode = midTurn[provider.split("-")[0]] ?? "hold";
        send = mode === "steer" ? ready.filter((m) => m.priority !== "fyi" || !this.policy.holdFyiWhileRunning) : [];
      }
      if (send.length === 0) return;
      // a message that failed goes again as it was, alone; a held seat's stop order does not wait behind it
      const retry = this.unsure.get(agentId);
      const retried =
        retry && (!held || retry.interrupt) && retry.ids.every((id) => queue.some((mail) => mail.id === id))
          ? retry
          : undefined;
      if (retry && !retried) this.unsure.delete(agentId);
      const extra = retried ? null : (this.appendix?.(agentId) ?? null);
      const text =
        retried?.text ??
        [digest(send.map((mail) => this.shown(mail, agentId))), extra?.text].filter(Boolean).join("\n\n");
      const ids = retried?.ids ?? send.map((mail) => mail.id);
      const interrupt = retried?.interrupt ?? stops;
      // the id is what the message is: the same mail in the same words, after a restart too, is handed over once
      const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
      const made = hash([agentId, ids, text, interrupt]);
      const spent = this.spent.get(agentId);
      const attempt = { id: spent?.made === made ? hash([made, spent.times]) : made, ids, text, interrupt };
      if (retried) send = queue.filter((mail) => retried.ids.includes(mail.id));
      // marked in the store until the daemon has it: a process that dies here loses nothing
      store.mark(agentId, attempt.ids, "sending");
      const opensTurn = status === "idle" || attempt.interrupt;
      if (opensTurn) this.woke.set(agentId, send);
      try {
        await this.host.send(agentId, attempt.text, attempt.interrupt, attempt.id);
      } catch (error) {
        if (opensTurn) this.woke.delete(agentId);
        // the app lost track of it: it goes again under a new id, still marked sending, so the seat knows it may repeat
        if (/agent_request_(outcome_unknown|key_conflict)/.test(String(error))) {
          this.unsure.delete(agentId);
          this.spent.set(agentId, { made, times: spent?.made === made ? spent.times + 1 : 1 });
        } else {
          store.mark(agentId, attempt.ids, "queued", "delivery-failed");
          this.unsure.set(agentId, attempt);
        }
        this.log(`mail: delivery to ${agentId} failed: ${errorText(error)}`);
        return;
      }
      this.unsure.delete(agentId);
      this.spent.delete(agentId);
      if (retried) this.again.add(agentId);
      store.mark(
        agentId,
        attempt.ids,
        "delivered",
        status === "idle" ? "idle" : attempt.interrupt ? "interrupt" : "steer",
      );
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

  /** Sends the wake-ups that fell due, delivers what is held, and posts the kept reports whose turn end never reached the room. */
  async sweep(): Promise<void> {
    await this.each(this.known(), "the sweep of one store", async (store) => {
      await this.each([store], "the wake-ups of one store", (one) => this.fireWakeUps(one));
      await this.each(store.waiting(this.now().toISOString()).keys(), "a delivery of the sweep", (seat) =>
        this.deliver(seat),
      );
      await this.each(store.kept(), "a kept report of the sweep", async (kept) => {
        const status = await this.host.state(kept.sender);
        if (status !== "idle" && status !== "gone") return;
        const report = this.takeReport(kept.sender);
        if (report) await this.postReport(report);
      });
    });
  }

  /** Sets a wake-up of `seat` for `by` after reading its time and note; the one waiting that this repeats, or the share that is full, when there is one. */
  setWakeUp(by: string, seat: string, ask: WakeAsk): WakeAdded {
    const now = this.now();
    const due = dueOf(ask, now);
    const note = noteOf(ask.note);
    const { perSeat, perSetter, sameWithinMinutes } = config.wake;
    return this.storeOf(seat)!.addWakeUp(
      { seat, by, at: now.toISOString(), due, note },
      { own: perSeat, others: perSeat, setter: perSetter, sameWithinMs: sameWithinMinutes * 60_000 },
    );
  }

  /** The soonest `limit` wake-ups waiting for a seat or set by it, in every project. */
  wakeUpsOf(seat: string, limit: number): WakeUp[] {
    return this.across("listing wake-ups", (store) => store.wakeUpsOf(seat, limit))
      .flat()
      .sort((a, b) => a.due.localeCompare(b.due) || a.id - b.id)
      .slice(0, limit);
  }

  /** Cancels wake-up `id` for the seat it wakes or the seat that set it; `seat` names the one it wakes where two projects hold the same id. Null where `me` has none. */
  cancelWakeUp(me: string, id: number, seat?: string): WakeUp | null {
    const found = this.across("looking for a wake-up", (store) => {
      const wake = store.wakeUp(id);
      return wake && (wake.seat === me || wake.by === me) && (!seat || wake.seat === seat) ? [{ store, wake }] : [];
    }).flat();
    if (found.length > 1)
      throw new MailError(
        "INVALID_ARGUMENT",
        `wake-up #${id} is waiting in ${found.length} projects; give \`to\`, the seat it wakes`,
        {
          to: found.map(({ wake }) => wake.seat),
        },
      );
    return found.length === 1 && found[0].store.closeWakeUp(id, "canceled") ? found[0].wake : null;
  }

  /** Sends the wake-ups of a store that fell due; one pass of a store at a time. */
  private async fireWakeUps(store: MailStore): Promise<void> {
    if (this.firing.has(store)) return;
    this.firing.add(store);
    try {
      await this.fireDue(store);
    } finally {
      this.firing.delete(store);
    }
  }

  /** Sends the due wake-ups of a store, the oldest first and at most `turnsPerPass` of them, so a crowd set for one minute does not start a crowd of turns: each a WAKE mail, or dropped with a seat that is gone. The copy beside the store is written once for the pass. */
  private async fireDue(store: MailStore): Promise<void> {
    const states = new Map<string, Status>();
    let started = 0;
    let closed = 0;
    try {
      await this.each(store.dueWakeUps(this.now().toISOString(), config.wake.perPass), "a wake-up", async (wake) => {
        if (!states.has(wake.seat))
          states.set(wake.seat, this.seats.has(wake.seat) ? await this.host.state(wake.seat) : "gone");
        const status = states.get(wake.seat);
        // an app that cannot be read proves nothing about the seat: the wake-up waits for the next pass
        if (status === "unknown") return;
        if (status === "gone") {
          if (store.closeWakeUp(wake.id, "dropped", false)) closed += 1;
          this.log(`mail: wake-up #${wake.id} of ${wake.seat} is dropped: that seat is archived or gone`);
          return;
        }
        const key = `wake-${wake.id}`;
        // a pass that stopped before the wake-up was closed finds its mail by this key and sends no second
        const since = new Date(this.now().getTime() - this.limits.keyHours * 3_600_000).toISOString();
        if (!this.storeOf(wake.seat)!.byKey("room", key, since)) {
          if (started >= config.wake.turnsPerPass) return;
          started += 1;
          await this.post({
            from: { agentId: "room", role: "system" },
            to: wake.seat,
            priority: "action",
            subject: wakeSubject(wake.note),
            body: wakeBody(wake, wake.by === wake.seat ? "you" : this.label(wake.by, wake.seat)),
            needs: "nothing",
            why: "a wake-up set earlier has come due",
            key,
          });
        }
        if (store.closeWakeUp(wake.id, "fired", false)) closed += 1;
      });
    } finally {
      if (closed > 0) store.copyWakeUps();
    }
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
    return this.across("reading what was posted", (store) => store.posted(since))
      .flat()
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Drops finished mail older than `before` from every store, with its files; returns how many. */
  prune(before: string): number {
    return sum(
      this.across("pruning mail", (store) => {
        const pruned = store.prune(before);
        dropFiles(store.folder, pruned.files, pruned.threads);
        forgetSettled(store.folder, pruned.ids);
        return pruned.messages;
      }),
    );
  }
}
