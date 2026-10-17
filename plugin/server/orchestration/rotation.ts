import { writeFileSync } from "node:fs";
import { readJson, writeJson } from "../persisted";
import { join } from "node:path";
import type { MailEngine, SeatRecord } from "../coordination/engine";
import type { Host, LiveSeat } from "../host";
import { keptOutOfGit } from "../sqlite";
import { fromTemplate } from "./brief";
import type { SeatFit } from "./models";
import { ROOM_FOLDER } from "../paths";
import { ROOM_SENDER } from "../coordination/address";

/** A seat whose context has grown is replaced: its handoff is asked for and read, and its successor starts on it. */

const HANDOFF_HEADINGS = ["CURRENT TASK", "PROGRESS", "KEY DECISIONS", "ACTIVE FILES", "BLOCKERS"] as const;
type Heading = (typeof HANDOFF_HEADINGS)[number];

const VERBATIM = "VERBATIM";
const HANDOFF_CHARS = 6000;
const VERBATIM_CHARS = 4000;
const BRIEF_CHARS = 12_000;
const RAISE_AFTER_REJECTIONS = 2;

/** The mail that asks a seat for its handoff. */
export function handoffRequest(why: string): string {
  return [
    `A fresh seat will continue your work${why ? ` (${why})` : ""}: every step a seat takes reads its whole context again, and yours has grown large. Nothing about the work changes, and nothing you did is lost.`,
    "Write the handoff as your whole final message, 500 words at most: first line `HANDOFF`, then these headings, each on a line of its own:",
    "CURRENT TASK: what you are doing, in a sentence or two",
    "PROGRESS: what is done (commit ids, paths) and what is still to do",
    "KEY DECISIONS: what you chose yourself and what you ruled out, with why; the decisions people made and recorded (seatwork_knowledge do=list) go to your successor on their own, so name one only to point at it",
    "ACTIVE FILES: what you were changing or reading, and what is uncommitted",
    "BLOCKERS: what you wait for, and from whom; `none` when nothing",
    `${VERBATIM} (optional): the exact strings your successor needs unchanged: commands, error messages, ids, constants, paths, one per line, ${VERBATIM_CHARS} characters at most and outside the 500 words; the room carries them as written, where a summary would lose them`,
    "Start no new work for it. When your turn ends the room starts your successor on your brief and this handoff, hands it the seats you launched, and archives you.",
  ].join("\n");
}

/** A handoff read from a seat's reply: its headed sections, the summary as one text, and the exact strings as written with the lines the size cut. */
interface Handoff {
  sections: Record<Heading, string>;
  text: string;
  verbatim: { text: string; left: number };
}

/** A heading at the start of a line, behind whatever list or emphasis marks the writer put there on that line. */
const headingAt = (heading: string) => new RegExp(`^[ \\t#>*_\\-\\d.)]*${heading}\\b[*_]*[ \\t]*[:—-]?[ \\t]*`, "im");

/** The handoff in a seat's reply, its exact strings keeping their first line's indentation; null when it does not say what it was doing and how far it got. */
export function parseHandoff(message: string): Handoff | null {
  const found = [...HANDOFF_HEADINGS, VERBATIM]
    .flatMap((heading) => {
      const match = headingAt(heading).exec(message);
      return match ? [{ heading, from: match.index, body: match.index + match[0].length }] : [];
    })
    .sort((a, b) => a.from - b.from);
  const sections = Object.fromEntries(HANDOFF_HEADINGS.map((heading) => [heading, ""])) as Record<Heading, string>;
  let exact = "";
  const summary: string[] = [];
  found.forEach((at, index) => {
    const end = found[index + 1]?.from ?? message.length;
    if (at.heading === VERBATIM) {
      exact = message
        .slice(at.body, end)
        .replace(/^(?:[ \t]*\n)+/, "")
        .trimEnd();
      return;
    }
    sections[at.heading as Heading] = message.slice(at.body, end).trim();
    summary.push(message.slice(at.from, end));
  });
  if (!sections["CURRENT TASK"] || !sections.PROGRESS) return null;
  return { sections, text: cut(summary.join("").trim()), verbatim: capped(exact) };
}

/** Exact strings held to VERBATIM_CHARS at whole lines; a first line past the size is cut in the line. */
function capped(exact: string): Handoff["verbatim"] {
  if (exact.length <= VERBATIM_CHARS) return { text: exact, left: 0 };
  const lines = exact.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + (kept.length ? 1 : 0) > VERBATIM_CHARS) break;
    used += line.length + (kept.length ? 1 : 0);
    kept.push(line);
  }
  if (kept.length === 0) return { text: lines[0].slice(0, VERBATIM_CHARS), left: lines.length };
  return { text: kept.join("\n"), left: lines.length - kept.length };
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

/** The exact strings in a fence they cannot close, and how many lines the size cut. */
function exactBlock(verbatim: Handoff["verbatim"]): string[] {
  const longest = Math.max(0, ...[...verbatim.text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [
    "## Exact strings the old seat kept (the room changed nothing inside the fence)",
    fence,
    verbatim.text,
    fence,
    ...(verbatim.left > 0
      ? [
          `${verbatim.left} more lines were left out to hold the strings to ${VERBATIM_CHARS} characters; the old seat's last turn in the room's record has them.`,
        ]
      : []),
    "",
  ];
}

/** What the successor reads first: the brief in force, the handoff, its exact strings, what the room kept for the task, and the threads the old seat was in. */
export function successorPrompt(input: {
  brief: string | null;
  handoff: string;
  file: string;
  verbatim?: Handoff["verbatim"];
  kept?: readonly string[];
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
    ...(input.verbatim?.text ? exactBlock(input.verbatim) : []),
    ...(input.kept?.length ? [...input.kept, ""] : []),
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
interface Asked {
  by: string;
  mailId: number;
  at: number;
  state: "asked" | "starting";
}

/** Rotations asked for and not done, kept on disk: a restart neither repeats one nor forgets it; those a stop left `starting` are in `interrupted`, to be told once. */
export class Rotations {
  private readonly items = new Map<string, Asked>();
  readonly interrupted: [string, Asked][] = [];

  constructor(private readonly file: string) {
    for (const [seat, asked] of Object.entries(readJson<Record<string, Asked>>(file, {}))) {
      if (asked.state === "starting") this.interrupted.push([seat, asked]);
      else this.items.set(seat, asked);
    }
    if (this.interrupted.length > 0) this.save();
  }

  /** The rotation asked of a seat, if one waits. */
  get(seat: string): Asked | undefined {
    return this.items.get(seat);
  }

  /** `by` asked for a seat's handoff with the mail `mailId`. */
  ask(seat: string, by: string, mailId: number, at: number): void {
    this.items.set(seat, { by, mailId, at, state: "asked" });
    this.save();
  }

  /** Marks the rotation as begun: the claim is written before the successor is started. */
  starting(seat: string): void {
    const asked = this.items.get(seat);
    if (!asked) return;
    asked.state = "starting";
    this.save();
  }

  /** The rotation is over, done or failed. */
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

/** What starting a successor needs: the app, the mail engine, the table in force at a folder (`fit`, `up`), and moving what the room keeps for the old seat (`handOver`). */
interface RotateDeps {
  host: Host;
  engine: MailEngine;
  version: string;
  fit(cwd: string, role: string, provider: string, model: string | undefined): SeatFit;
  up(cwd: string, role: string, provider: string, model: string): string | undefined;
  handOver(from: string, to: string): void;
}

/** Starts a seat's successor on its brief, handoff and `kept` lines, hands it over and archives the seat; a task sent back twice (`rejected`) starts a tier up where the table lists one. */
export async function rotate(
  deps: RotateDeps,
  old: SeatRecord,
  handoff: Handoff,
  kept: readonly string[] = [],
  rejected = 0,
): Promise<{ id: string; file: string; model: string; raised: boolean; left: string[] }> {
  const { host, engine } = deps;
  const now = await host.seat(old.agentId);
  if (!now) throw new Error("the app no longer has the seat");
  const { model, thinking, raised } = successorModel(deps, old, now, rejected);
  const received = await host.prompts(old.agentId, 4000);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const file = writeHandoff(now.cwd, old, handoff, stamp);
  const owner = engine.parentOf(old.agentId);
  const title = nextTitle(old.title);
  const id = await host.create({
    key: `rotation:${old.agentId}:${stamp}`,
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
      verbatim: handoff.verbatim,
      kept,
      threads: engine.threadsFor(old.agentId),
    }),
  });
  // the successor must be a seat of the room before anything is handed to it
  engine.rememberSeat({ ...old, agentId: id, parentAgentId: owner, title, version: deps.version });
  // the successor stands: failures are said; the old seat goes only when nothing is left on it
  const left = await moveOver(deps, old, id);
  if (left.length === 0) await host.archive(old.agentId).catch(failedTo(left, "the old seat's archive"));
  return { id, file, model: model || "its provider's default", raised, left };
}

/** The successor's model and thinking: the old seat's while the table in force still lists it, else the table's, a tier up for a task sent back twice where the table lists one. */
function successorModel(
  deps: RotateDeps,
  old: SeatRecord,
  now: LiveSeat,
  rejected: number,
): { model: string; thinking: string | null | undefined; raised: boolean } {
  const fit = deps.fit(now.cwd, old.role, old.provider, now.model ?? undefined);
  if (!fit.ok)
    throw new Error(`the table in force lists for ${old.role} only ${fit.listed.join(", ")}, none on ${old.provider}`);
  const same = fit.model ?? now.model ?? "";
  const higher =
    rejected >= RAISE_AFTER_REJECTIONS && same ? deps.up(now.cwd, old.role, old.provider, same) : undefined;
  const thinking = fit.model ? (fit.thinking === "default" ? undefined : fit.thinking) : now.thinking;
  return { model: higher ?? same, thinking, raised: higher !== undefined };
}

/** Writes the handoff where the successor and the seats above read it, with its exact strings fenced; its path. */
function writeHandoff(cwd: string, old: SeatRecord, handoff: Handoff, stamp: string): string {
  const file = join(keptOutOfGit(join(cwd, ROOM_FOLDER, "handoffs")), `${stamp}_${old.agentId.slice(0, 8)}.md`);
  const exact = handoff.verbatim.text ? `\n${exactBlock(handoff.verbatim).join("\n")}` : "";
  writeFileSync(file, `# Handoff of ${old.title ?? old.agentId}\n\n${handoff.text}\n${exact}`);
  return file;
}

/** Moves what hangs on the old seat to its successor `id`: the seats it launched, each told, its held mail, and what the room keeps for it; what did not move, said. */
async function moveOver(deps: RotateDeps, old: SeatRecord, id: string): Promise<string[]> {
  const { engine } = deps;
  const left: string[] = [];
  for (const child of engine.allSeats().filter((seat) => engine.parentOf(seat.agentId) === old.agentId)) {
    const adopted = await engine
      .adopt(id, child.agentId)
      .catch((error) => ({ ok: false as const, reason: String(error) }));
    if (!adopted.ok || !adopted.linkMoved) left.push(`${child.role} ${child.title ?? child.agentId}`);
    if (!adopted.ok) continue;
    await engine
      .post({
        from: ROOM_SENDER,
        to: child.agentId,
        priority: "fyi",
        subject: "OWNER CHANGED: your Owner continues in a fresh seat",
        body: "Your Owner was replaced by a fresh seat that holds its brief and its handoff. Mail addressed `to: owner`, your final messages and your permission requests reach the new seat; your brief stands. Continue your work.",
        needs: "nothing",
        why: "the seat that launched you was rotated out",
      })
      .catch(failedTo(left, `the notice to ${child.role} ${child.title ?? child.agentId}`));
  }
  await engine.move(old.agentId, id).catch(failedTo(left, "its held mail"));
  try {
    deps.handOver(old.agentId, id);
  } catch (error) {
    failedTo(left, "its claimed work")(error);
  }
  return left;
}

/** Notes in `left` what failed to move, with its error. */
const failedTo = (left: string[], what: string) => (error: unknown) =>
  void left.push(`${what} (${error instanceof Error ? error.message : String(error)})`);
