import { fromTemplate, parseBrief } from "../watch/brief";

/** Replacing a seat whose context has grown: the handoff it is asked for, and what its successor is started with. */

export const HANDOFF_HEADINGS = ["CURRENT TASK", "PROGRESS", "KEY DECISIONS", "ACTIVE FILES", "BLOCKERS"] as const;
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
  return { sections, text: message.slice(found[0].from).trim().slice(0, HANDOFF_CHARS) };
}

/** The latest prompt written from the room's brief template; a seat that got none of those keeps its first prompt. */
export function briefInForce(received: readonly string[], cwd: string): string | null {
  const brief = received.findLast((prompt) => fromTemplate(parseBrief(prompt, cwd))) ?? received[0];
  return brief ? brief.slice(0, BRIEF_CHARS) : null;
}

export function successorPrompt(input: { brief: string | null; handoff: string; file: string }): string {
  return [
    "You continue the work of a seat that was replaced because its context had grown large. Nothing else changed: its brief stands, and the tree is as that seat left it.",
    "",
    "## The brief in force",
    input.brief ?? "(the room could not read it: ask your Owner for the brief before you edit)",
    "",
    `## The handoff (kept at ${input.file})`,
    input.handoff,
    "",
    "Before your first edit hold the handoff against the tree (git status, git log, the files it names) and trust the tree where the two differ. Then continue from PROGRESS, and report to your Owner as the brief says.",
  ].join("\n");
}

/** `[Lead] store` → `[Lead] store (2)` → `[Lead] store (3)`. */
export function nextTitle(title: string | null): string {
  const numbered = /^(.*) \((\d+)\)$/.exec(title ?? "");
  return numbered ? `${numbered[1]} (${Number(numbered[2]) + 1})` : `${title ?? "seat"} (2)`;
}
