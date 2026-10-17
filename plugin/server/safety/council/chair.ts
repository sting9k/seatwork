import council from "../../../shared/safety/council.json";
import { redact } from "../../redact";
import type { SafetyStore } from "../store";
import { clip } from "../../excerpt";

/** The chair: the room's own seat rules whether a council member's finding sends a candidate back. */

/** What the chair needs of the room: the seat at home in the room, who reads a seat's work, how a seat is called, a way to mail. */
export interface ChairDeps {
  seat(): string | null;
  isChair(agentId: string): boolean;
  ownerOf(agentId: string): string | null;
  titleOf(agentId: string): string;
  tell(to: string, mail: { subject: string; body: string; needs: "nothing" | "reply"; why: string }): Promise<void>;
}

/** The evidence an appeal carries, filtered: what the member found and why it asks, its readings, the turn's commands, the diff, the brief. */
export interface Packet {
  member: string;
  why: "found" | "unsure" | "disagree" | "contradicted";
  finding: string;
  readings: { tier: string; zone: string; score?: number }[];
  commands: { command: string; exit: number | null }[];
  diff?: string;
  brief: Record<string, string>;
}

/** A finding that would send a candidate back, with the evidence behind it; `finding` names it so it is asked about once. */
interface Appeal {
  reading: number;
  member: string;
  seat: string;
  finding: string;
  packet: Packet;
}

const REASON_CHARS = 500;
const PACKET_CHARS = 8000;

/** The appeals to the chair over the store: raised with their evidence, ruled by the room's seat, lapsing when it does not answer. */
export class Chair {
  constructor(
    private readonly deps: {
      room: ChairDeps;
      store(): SafetyStore;
      minutes(): number | undefined;
      log(message: string): void;
    },
  ) {}

  /** How long an appeal waits for a ruling: the policy's, else the shipped time. */
  private get minutes(): number {
    const set = this.deps.minutes();
    return set === undefined ? council.chair.answerMinutes : Math.min(Math.max(Math.round(set), 1), 24 * 60);
  }

  /** Asks the chair to rule; null when it is not asked: nobody to ask, the finding already asked about, or too many wait. */
  async appeal(a: Appeal): Promise<number | null> {
    const chair = this.deps.room.seat();
    const store = this.deps.store();
    if (!chair) return null;
    if (store.appealed(a.seat, a.member, a.finding)) return null;
    if (store.openAppeals() >= council.chair.open) {
      this.deps.log(
        `council: ${a.member} found something in ${a.seat}, but the chair has ${council.chair.open} appeals to rule`,
      );
      return null;
    }
    const id = store.addAppeal({
      readingId: a.reading,
      member: a.member,
      seat: a.seat,
      finding: a.finding,
      chair,
      packet: kept(a.packet),
      dueInMs: this.minutes * 60_000,
    });
    await this.deps.room.tell(chair, {
      subject: `APPEAL #${id}: ${a.member} on ${this.deps.room.titleOf(a.seat)}'s candidate`,
      body: asked(id, this.deps.room.titleOf(a.seat), a.packet, this.minutes),
      needs: "nothing",
      why: "a member of the room's council asks whether a candidate goes back",
    });
    return id;
  }

  /** The chair's word on an appeal: the candidate goes back to its seat, or stays. */
  async rule(by: string, id: number, sendBack: boolean, reason: string): Promise<string> {
    if (!this.deps.room.isChair(by)) return "Only the room's own seat rules on appeals.";
    const store = this.deps.store();
    const row = store.appeal(id);
    if (!row) return `No appeal #${id}: copy the number from the APPEAL mail.`;
    const said = reason.trim().slice(0, REASON_CHARS);
    if (!store.rule(id, sendBack ? "sent_back" : "upheld", by, said)) {
      return row.status === "open" || row.status === "lapsed"
        ? `Appeal #${id} lapsed before you ruled: nothing is sent back, and the seat did not wait.`
        : `Appeal #${id} was ruled already (${row.status}).`;
    }
    if (!sendBack) return `Noted: appeal #${id} is upheld, the candidate stays with its Owner.`;
    const packet = JSON.parse(row.packet) as Packet;
    const title = this.deps.room.titleOf(row.seat);
    const owner = this.deps.room.ownerOf(row.seat);
    const sent = [
      this.deps.room.tell(row.seat, {
        subject: `HAND-IN RETURNED: the chair sent your candidate back (${row.member})`,
        body: returned(packet.finding, said),
        needs: "reply",
        why: "the room's chair read a council finding about your candidate and sent it back",
      }),
    ];
    if (owner && owner !== by)
      sent.push(
        this.deps.room.tell(owner, {
          subject: `COUNCIL: the chair sent ${title}'s hand-in back`,
          body: `The room's chair sent this seat's candidate back after a council finding (${row.member}): ${said}\nHold your verdict on it until the seat hands in again.`,
          needs: "nothing",
          why: "the candidate you were given was sent back by the room's chair",
        }),
      );
    for (const result of await Promise.allSettled(sent))
      if (result.status === "rejected")
        this.deps.log(`council: a mail about appeal #${id} was not sent: ${String(result.reason)}`);
    return `Sent back: ${title} is told, with your reason.`;
  }
}

/** The packet as stored, whole JSON: past the limit the diff goes first, then the commands, then the rest. */
function kept(packet: Packet): string {
  for (const part of [packet, { ...packet, diff: undefined }, { ...packet, diff: undefined, commands: [] }]) {
    const text = JSON.stringify(part);
    if (text.length <= PACKET_CHARS) return text;
  }
  return JSON.stringify({ ...packet, diff: undefined, commands: [], brief: {}, readings: [] });
}

/** What the chair reads: the finding, why it is asked, the evidence, and how to rule. */
function asked(id: number, title: string, packet: Packet, minutes: number): string {
  const lines = [
    `The room's council member ${packet.member} found something in ${title}'s candidate, and a candidate goes back only when you agree.`,
    `Why you are asked: ${REASONS[packet.why]}.`,
    `Finding: ${redact(packet.finding)}`,
    `Readings: ${packet.readings.map((r) => `${r.tier} ${r.zone}${r.score === undefined ? "" : ` ${r.score.toFixed(2)}`}`).join("; ") || "none"}`,
  ];
  if (packet.commands.length)
    lines.push(
      "Commands the turn ran, with exit codes:",
      ...packet.commands.map((c) => `- ${redact(clip(c.command, 160))} (${c.exit ?? "no exit code"})`),
    );
  if (packet.diff) lines.push("The changes, filtered:", packet.diff);
  const brief = Object.entries(packet.brief).map(([key, value]) => `${key}: ${redact(clip(value, 300))}`);
  if (brief.length) lines.push("The brief:", ...brief);
  lines.push(
    `Rule within ${minutes} minutes, on this evidence only: seatwork_safety action=rule id=${id} send_back=true or false and a reason of a sentence in English.`,
    "Send it back only when the evidence above shows the problem. When it is thin or unclear, send_back=false. If you do not rule in time nothing is sent back.",
  );
  return lines.join("\n");
}

const REASONS = {
  found: "the member found it by what the diff and the turn show",
  unsure: "the member's reading fell between sure and clear",
  disagree: "two readings of the same question disagreed",
  contradicted: "the facts and the reading of the excerpt contradict each other",
} as const;

/** What the seat reads when the chair sends its candidate back. */
function returned(finding: string, reason: string): string {
  return [
    "The room's chair read the evidence behind a council finding about your candidate and sent it back.",
    `Finding: ${finding}`,
    `The chair's reason: ${reason}`,
    "Fix what the reason names, then hand in again. If you think the chair is wrong, say so in your next hand-in, with your evidence.",
  ].join("\n");
}
