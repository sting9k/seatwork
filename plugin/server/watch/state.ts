import type { Brief } from "./brief";
import type { TurnFacts } from "./facts";
import type { DecisionQuestion, DecisionRequest, JsonValue } from "./jev";
import { BRIEF_FIELD, type Inquiry, type StateField } from "./questions";
import { redactDeep } from "./redact";
import { digest } from "./repeat";

/** The state sent with a set of questions: only the fields they read, cut to size, secrets blanked. */

export interface StateLimits {
  messageChars: number;
  briefLineChars: number;
}

const SKIPPED = "[…]";
const LINE_MAX = 320;
const NOT_STATED = "not stated in the brief";
const MAX_FILES = 12;
/** Fixed order, so equal situations give equal bytes: brief, then facts, then the agent's words. */
const ORDER: readonly StateField[] = ["brief.outcome", "brief.yours_to_decide", "brief.contract", "brief.constraints", "brief.authority", "brief.reopen_when", "changed_files", "action", "final_message"];

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

export interface Excerpt {
  text: string;
  whole: boolean;
}

/** A message within the limit goes whole; a longer one keeps its first line, its RECAP and the `relevant` lines. */
export function excerpt(text: string, relevant: RegExp, maxChars: number): Excerpt {
  const message = text.replace(/\r\n?/g, "\n").trim();
  if (message.length <= maxChars) return { text: message, whole: true };
  const lines = message.split("\n").map((line) => clip(line.trimEnd(), LINE_MAX));
  const rank = new Array<number>(lines.length).fill(Number.POSITIVE_INFINITY);
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first >= 0) rank[first] = 0;
  lines.forEach((line, index) => {
    if (/^\W*RECAP\b/.test(line)) rank[index] = 0;
    else if (line.trim() && relevant.test(line)) rank[index] = Math.min(rank[index], 1);
  });
  lines.forEach((_line, index) => {
    if (rank[index] !== 1) return;
    for (const neighbour of [index - 1, index + 1]) {
      if (neighbour >= 0 && neighbour < lines.length && lines[neighbour].trim() && rank[neighbour] > 2) rank[neighbour] = 2;
    }
  });
  const kept = new Set<number>();
  let used = 0;
  let whole = true;
  const candidates = lines.map((_, index) => index).filter((index) => Number.isFinite(rank[index])).sort((a, b) => rank[a] - rank[b] || a - b);
  for (const index of candidates) {
    const cost = lines[index].length + 1;
    if (used + cost > maxChars) {
      if (rank[index] <= 1) whole = false;
      continue;
    }
    kept.add(index);
    used += cost;
  }
  const out: string[] = [];
  let previous = -1;
  for (const index of [...kept].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push(SKIPPED);
    out.push(lines[index]);
    previous = index;
  }
  if (previous < lines.length - 1) out.push(SKIPPED);
  return { text: out.join("\n"), whole };
}

const readsMessage = (inquiry: Inquiry) => inquiry.reads.includes("final_message");
const relevantTo = (inquiries: readonly Inquiry[]) => new RegExp(inquiries.map((inquiry) => `(?:${inquiry.relevant.source})`).join("|"), "i");

/** The inquiries whose evidence fits: a question goes with every line it reads, or it is not asked. */
export function fitting(inquiries: readonly Inquiry[], message: string, limits: StateLimits): Inquiry[] {
  const lines = message.split("\n");
  const need = (inquiry: Inquiry) => lines.filter((line) => line.trim() && inquiry.relevant.test(line)).length;
  const chosen: Inquiry[] = [];
  for (const inquiry of inquiries.filter(readsMessage).sort((a, b) => need(a) - need(b))) {
    if (excerpt(message, relevantTo([...chosen, inquiry]), limits.messageChars).whole) chosen.push(inquiry);
  }
  return inquiries.filter((inquiry) => !readsMessage(inquiry) || chosen.includes(inquiry));
}

export interface BuiltRequest {
  request: DecisionRequest;
  hash: string;
}

/** The request for inquiries that fit (see `fitting`). */
export function buildRequest(inquiries: readonly Inquiry[], facts: TurnFacts, brief: Brief | null, limits: StateLimits): BuiltRequest {
  const reads = new Set<StateField>(inquiries.flatMap((inquiry) => inquiry.reads));
  const state: Record<string, JsonValue> = {};
  const briefLines: Record<string, JsonValue> = {};
  for (const field of ORDER) {
    if (!reads.has(field)) continue;
    if (field === "final_message") {
      state.final_message = excerpt(facts.message, relevantTo(inquiries.filter(readsMessage)), limits.messageChars).text;
    } else if (field === "changed_files") {
      const paths = [...new Set([...facts.edits.map((edit) => edit.path), ...(facts.lastEdit ? [facts.lastEdit.path] : [])])];
      state.changed_files = paths.slice(0, MAX_FILES);
    } else if (field === "action") {
      const deed = facts.external[0];
      state.action = deed ? { kind: deed.what, command: clip(deed.command.replace(/\s+/g, " ").trim(), LINE_MAX) } : NOT_STATED;
    } else {
      const line = brief?.fields[BRIEF_FIELD[field]]?.trim();
      briefLines[field.slice("brief.".length)] = line ? clip(line.replace(/\s+/g, " "), limits.briefLineChars) : NOT_STATED;
    }
  }
  const ordered: Record<string, JsonValue> = { ...(Object.keys(briefLines).length > 0 ? { brief: briefLines } : {}), ...state };
  const questions: Record<string, DecisionQuestion> = {};
  for (const inquiry of inquiries) Object.assign(questions, inquiry.questions);
  const request: DecisionRequest = { state: redactDeep(ordered), questions };
  return { request, hash: digest(JSON.stringify(request)) };
}
