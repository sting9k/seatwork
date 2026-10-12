import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { liveAgents, type LiveAgent } from "./gc";
import { waitsOnSomeone, type MailEngine } from "./mail";
import { ROOM_HOME } from "./paths";
import type { ScanRecord } from "./watch/scanlog";

const MAIL_LOG = join(ROOM_HOME, "mail", "log.jsonl");

/** What a turn left for the Owner to answer, kept by the plugin until that seat works again. */
export interface Owed {
  key: string;
  agentId: string;
  title: string | null;
  what: string;
  at: string;
}

/** What waits on the Owner, one entry per seat, kept on disk: a plugin reload or a daemon restart answers nothing. */
export class OwedList {
  private readonly items = new Map<string, Owed>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      for (const item of JSON.parse(readFileSync(file, "utf8")) as Owed[]) this.items.set(item.agentId, item);
    } catch {
      // an unreadable list starts empty: the next turn that asks fills it again
    }
  }

  set(item: Owed): void {
    this.items.set(item.agentId, item);
    this.save();
  }

  /** The seat works again, or was archived. */
  clear(agentId: string): void {
    if (this.items.delete(agentId)) this.save();
  }

  /** What still waits: an entry whose seat the daemon no longer has is dropped. */
  among(live: ReadonlyMap<string, LiveAgent>): Owed[] {
    const gone = [...this.items.keys()].filter((agentId) => !live.has(agentId));
    for (const agentId of gone) this.items.delete(agentId);
    if (gone.length > 0) this.save();
    return [...this.items.values()];
  }

  async current(paseo: PaseoApi): Promise<Owed[]> {
    return this.among(await liveAgents(paseo));
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify([...this.items.values()], null, 1)}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Where a mail stands, from the last line the mail log has for it. */
const STATE: Record<string, string> = {
  queued: "waiting",
  "delivered-idle": "delivered",
  "delivered-steer": "delivered",
  "delivery-failed": "waiting",
  "read-by-inbox": "read",
  "dropped-recipient-gone": "undeliverable",
  "replaced-by-newer-report": "replaced",
  "report-kept": "kept for the turn's end",
  "report-replaced": "replaced",
};

interface LogLine {
  at: string;
  kind: string;
  id: string;
  from: string;
  to: string;
  subject: string;
}

/** The newest mails, one row each, with where each stands now. */
function latestMail(count: number): { id: string; at: string; from: string; to: string; subject: string; state: string }[] {
  if (!existsSync(MAIL_LOG)) return [];
  const mails = new Map<string, { id: string; at: string; from: string; to: string; subject: string; state: string }>();
  for (const line of readFileSync(MAIL_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: LogLine;
    try {
      entry = JSON.parse(line) as LogLine;
    } catch {
      continue;
    }
    if (!entry.id || !entry.subject) continue;
    const known = mails.get(entry.id);
    mails.set(entry.id, { id: entry.id, at: known?.at ?? entry.at, from: entry.from, to: entry.to, subject: entry.subject, state: STATE[entry.kind] ?? entry.kind });
  }
  return [...mails.values()].slice(-count).reverse();
}

/** The room as the app shows it: what waits on the Owner, the seats that exist as a tree, the latest mail, what the watcher found. */
export async function roomStatus(paseo: PaseoApi, engine: MailEngine, owed: OwedList, scans: ScanRecord[]) {
  const live = await liveAgents(paseo);
  const records = engine.allSeats().filter((seat) => live.has(seat.agentId));
  const listed = new Set(records.map((seat) => seat.agentId));
  const above = (id: string) => {
    const parent = engine.parentOf(id);
    return parent && listed.has(parent) ? parent : null;
  };
  const seats: { agentId: string; role: string; title: string | null; status: string; held: number; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const seat of records) {
      if (above(seat.agentId) !== parent) continue;
      const agent = live.get(seat.agentId)!;
      seats.push({ agentId: seat.agentId, role: seat.role, title: seat.title, status: waitsOnSomeone(agent) ? "waiting" : agent.status, held: engine.held(seat.agentId).length, depth });
      walk(seat.agentId, depth + 1);
    }
  };
  walk(null, 0);
  const name = (id: string) => {
    const seat = engine.seat(id);
    return seat ? (seat.title ?? seat.role) : id === "room" ? "room" : id.slice(0, 8);
  };
  const findings = scans
    .flatMap((scan) => scan.findings.map((finding) => ({ at: scan.at, seat: name(scan.seat), rule: finding.rule as string, evidence: finding.evidence, outcome: finding.outcome as string })))
    .slice(-8)
    .reverse();
  return {
    waiting: owed.among(live),
    seats,
    mail: latestMail(12).map((mail) => ({ ...mail, from: name(mail.from), to: name(mail.to) })),
    findings,
  };
}
