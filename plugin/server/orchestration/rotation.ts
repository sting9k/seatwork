import { writeFileSync } from "node:fs";
import { readJson, writeJson } from "../persisted";
import { join } from "node:path";
import type { MailEngine, SeatRecord } from "../coordination/engine";
import type { Host } from "../host";
import { keptOutOfGit } from "../sqlite";
import { fromTemplate } from "./brief";
import type { SeatFit } from "./models";

/** Replacing a seat whose context has grown: its handoff, and its successor's start. */

const HANDOFF_HEADINGS = ["CURRENT TASK", "PROGRESS", "KEY DECISIONS", "ACTIVE FILES", "BLOCKERS"] as const;
type Heading = (typeof HANDOFF_HEADINGS)[number];

const HANDOFF_CHARS = 6000;
const BRIEF_CHARS = 12_000;

export function handoffRequest(why: string): string {
  return [
    `A fresh seat will continue your work${why ? ` (${why})` : ""}: every step a seat takes reads its whole context again, and yours has grown large. Nothing about the work changes, and nothing you did is lost.`,
    "Write the handoff as your whole final message, 500 words at most: first line `HANDOFF`, then these five headings, each on a line of its own:",
    "CURRENT TASK: what you are doing, in a sentence or two",
    "PROGRESS: what is done (commit ids, paths) and what is still to do",
    "KEY DECISIONS: what you decided and why, and what you ruled out",
    "ACTIVE FILES: what you were changing or reading, and what is uncommitted",
    "BLOCKERS: what you wait for, and from whom; `none` when nothing",
    "Start no new work for it. When your turn ends the room starts your successor on your brief and this handoff, hands it the seats you launched, and archives you.",
  ].join("\n");
}

export interface Handoff {
  sections: Record<Heading, string>;
  text: string;
}

/** A heading at the start of a line, behind whatever list or emphasis marks the writer put there. */
const headingAt = (heading: string) => new RegExp(`^[\\s#>*_\\-\\d.)]*${heading}\\b[*_]*\\s*[:—-]?[ \\t]*`, "im");

/** The handoff in a seat's reply; null when it does not say what it was doing and how far it got. */
export function parseHandoff(message: string): Handoff | null {
  const found = HANDOFF_HEADINGS.flatMap((heading) => {
    const match = headingAt(heading).exec(message);
    return match ? [{ heading, from: match.index, body: match.index + match[0].length }] : [];
  }).sort((a, b) => a.from - b.from);
  const sections = Object.fromEntries(HANDOFF_HEADINGS.map((heading) => [heading, ""])) as Record<Heading, string>;
  found.forEach((at, index) => {
    sections[at.heading] = message.slice(at.body, found[index + 1]?.from ?? message.length).trim();
  });
  if (!sections["CURRENT TASK"] || !sections.PROGRESS) return null;
  return { sections, text: cut(message.slice(found[0].from).trim()) };
}

/** A handoff past HANDOFF_CHARS ends at the last line or sentence before it, and says it was cut. */
function cut(text: string): string {
  if (text.length <= HANDOFF_CHARS) return text;
  const head = text.slice(0, HANDOFF_CHARS);
  const end = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". ") + 1);
  return `${(end > HANDOFF_CHARS / 2 ? head.slice(0, end) : head).trimEnd()}\n[cut by the room at ${HANDOFF_CHARS} characters]`;
}

/** The latest prompt from the room's brief template, else the seat's first prompt. */
export function briefInForce(received: readonly string[]): string | null {
  const brief = received.findLast(fromTemplate) ?? received[0];
  return brief ? brief.slice(0, BRIEF_CHARS) : null;
}

export function successorPrompt(input: {
  brief: string | null;
  handoff: string;
  file: string;
  threads?: readonly string[];
}): string {
  return [
    "You continue the work of a seat that was replaced because its context had grown large. Nothing else changed: its brief stands, and the tree is as that seat left it.",
    "",
    "## The brief in force",
    input.brief ?? "(the room could not read it: ask your Owner for the brief before you edit)",
    "",
    `## The handoff (kept at ${input.file})`,
    input.handoff,
    "",
    ...(input.threads?.length
      ? ["## The mail threads it was in, newest first (seatwork_inbox reads a thread whole)", ...input.threads, ""]
      : []),
    "Before your first edit hold the handoff against the tree (git status, git log, the files it names) and trust the tree where the two differ. Then continue from PROGRESS, and report to your Owner as the brief says.",
  ].join("\n");
}

/** `[role] store`, then `[role] store (2)`, `[role] store (3)`. */
export function nextTitle(title: string | null): string {
  const numbered = /^(.*) \((\d+)\)$/.exec(title ?? "");
  return numbered ? `${numbered[1]} (${Number(numbered[2]) + 1})` : `${title ?? "seat"} (2)`;
}

/** A rotation asked for: `starting` once the room has begun to start the successor. */
export interface Asked {
  by: string;
  mailId: number;
  at: number;
  state: "asked" | "starting";
}

/** Rotations asked for and not done, kept on disk: a restart neither repeats one nor forgets it. */
export class Rotations {
  private readonly items = new Map<string, Asked>();
  /** Left in `starting` by a process that stopped: their askers are told once. */
  readonly interrupted: [string, Asked][] = [];

  constructor(private readonly file: string) {
    for (const [seat, asked] of Object.entries(readJson<Record<string, Asked>>(file, {}))) {
      if (asked.state === "starting") this.interrupted.push([seat, asked]);
      else this.items.set(seat, asked);
    }
    if (this.interrupted.length > 0) this.save();
  }

  get(seat: string): Asked | undefined {
    return this.items.get(seat);
  }

  ask(seat: string, by: string, mailId: number, at: number): void {
    this.items.set(seat, { by, mailId, at, state: "asked" });
    this.save();
  }

  /** The claim is written before the successor is started. */
  starting(seat: string): void {
    const asked = this.items.get(seat);
    if (!asked) return;
    asked.state = "starting";
    this.save();
  }

  done(seat: string): void {
    if (this.items.delete(seat)) this.save();
  }

  /** The rotations asked longer than `minutes` ago and never answered; each is handed out once. */
  expired(now: number, minutes: number): [string, Asked][] {
    const out = [...this.items].filter(([, asked]) => asked.state === "asked" && now - asked.at > minutes * 60_000);
    for (const [seat] of out) this.items.delete(seat);
    if (out.length > 0) this.save();
    return out;
  }

  private save(): void {
    writeJson(this.file, Object.fromEntries(this.items));
  }
}

/** What starting a successor needs besides the app. */
export interface RotateDeps {
  host: Host;
  engine: MailEngine;
  version: string;
  /** What the table in force at that folder makes of a seat on this model. */
  fit(cwd: string, role: string, provider: string, model: string | undefined): SeatFit;
  /** Moves what the room keeps for the old seat to the successor: its task's rounds, its claimed work. */
  handOver(from: string, to: string): void;
}

/** Starts a seat's successor on its brief and handoff, hands it over, archives the seat. */
export async function rotate(
  deps: RotateDeps,
  old: SeatRecord,
  handoff: Handoff,
): Promise<{ id: string; file: string; model: string; left: string[] }> {
  const { host, engine } = deps;
  const now = await host.seat(old.agentId);
  if (!now) throw new Error("the app no longer has the seat");
  // the old seat's model while the table still lists it, else the table's
  const fit = deps.fit(now.cwd, old.role, old.provider, now.model ?? undefined);
  if (!fit.ok)
    throw new Error(`the table in force lists for ${old.role} only ${fit.listed.join(", ")}, none on ${old.provider}`);
  const model = fit.model ?? now.model ?? "";
  const thinking = fit.model ? (fit.thinking === "default" ? undefined : fit.thinking) : now.thinking;
  const received = await host.prompts(old.agentId, 4000);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const file = join(keptOutOfGit(join(now.cwd, ".seatwork", "handoffs")), `${stamp}_${old.agentId.slice(0, 8)}.md`);
  writeFileSync(file, `# Handoff of ${old.title ?? old.agentId}\n\n${handoff.text}\n`);
  const owner = engine.parentOf(old.agentId);
  const title = nextTitle(old.title);
  const id = await host.create({
    provider: old.provider,
    ...(model ? { model } : {}),
    ...(now.mode ? { mode: now.mode } : {}),
    ...(thinking ? { thinking } : {}),
    cwd: now.cwd,
    ...(owner ? { parent: owner } : {}),
    title,
    prompt: successorPrompt({
      brief: received ? briefInForce(received) : null,
      handoff: handoff.text,
      file,
      threads: engine.threadsFor(old.agentId),
    }),
  });
  // the successor must be a seat of the room before anything is handed to it
  engine.rememberSeat({ ...old, agentId: id, parentAgentId: owner, title, version: deps.version });
  // the successor stands: failures are said; the old seat goes only when nothing is left on it
  const left: string[] = [];
  const failed = (what: string) => (error: unknown) =>
    left.push(`${what} (${error instanceof Error ? error.message : String(error)})`);
  for (const child of engine.allSeats().filter((seat) => engine.parentOf(seat.agentId) === old.agentId)) {
    const adopted = await engine
      .adopt(id, child.agentId)
      .catch((error) => ({ ok: false as const, reason: String(error) }));
    if (!adopted.ok || !adopted.linkMoved) left.push(`${child.role} ${child.title ?? child.agentId}`);
    if (!adopted.ok) continue;
    await engine
      .post({
        from: { agentId: "room", role: "system" },
        to: child.agentId,
        priority: "fyi",
        subject: "OWNER CHANGED: your Owner continues in a fresh seat",
        body: "Your Owner was replaced by a fresh seat that holds its brief and its handoff. Mail addressed `to: owner`, your final messages and your permission requests reach the new seat; your brief stands. Continue your work.",
        needs: "nothing",
        why: "the seat that launched you was rotated out",
      })
      .catch(failed(`the notice to ${child.role} ${child.title ?? child.agentId}`));
  }
  await engine.move(old.agentId, id).catch(failed("its held mail"));
  try {
    deps.handOver(old.agentId, id);
  } catch (error) {
    failed("its claimed work")(error);
  }
  if (left.length === 0) await host.archive(old.agentId).catch(failed("the old seat's archive"));
  return { id, file, model: model || "its provider's default", left };
}
