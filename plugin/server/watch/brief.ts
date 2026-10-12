import { effectsOf } from "./effects";
import { parseWriteScope, type WriteScope } from "./scope";
import { parseShell } from "./shell";

/** A brief as the room writes it: `Key: value` lines from a fixed template. */

export type BriefField =
  | "project"
  | "outcome"
  | "candidate"
  | "context"
  | "writeScope"
  | "contract"
  | "decide"
  | "constraints"
  | "output"
  | "acceptance"
  | "reopenWhen"
  | "tried"
  | "replyTo"
  | "nonGoals"
  | "authority"
  | "openAssumptions"
  | "decisions"
  | "inputs"
  | "lane";

/** Template label → field. Longer labels first where one is a prefix of another. */
const LABELS: readonly [RegExp, BriefField][] = [
  [/project/, "project"],
  [/outcome/, "outcome"],
  [/(?:current )?candidate/, "candidate"],
  [/context/, "context"],
  [/write scope/, "writeScope"],
  [/contract(?: ?\/ ?invariants)?|invariants/, "contract"],
  [/yours to decide/, "decide"],
  [/(?:verified )?constraints/, "constraints"],
  [/output/, "output"],
  [/acceptance(?: evidence)?/, "acceptance"],
  [/reopen when/, "reopenWhen"],
  [/what was tried/, "tried"],
  [/reply with seatwork_mail to/, "replyTo"],
  [/non-?goals/, "nonGoals"],
  [/authority/, "authority"],
  [/open assumptions/, "openAssumptions"],
  [/decisions made/, "decisions"],
  [/inputs/, "inputs"],
  [/lane/, "lane"],
];
// a label may come as a list item, in bold, in backticks or quoted
const LABEL_LINE = new RegExp(`^\\s*(?:[-*>]\\s+)?[*_\`"']*(${LABELS.map(([label]) => label.source).join("|")})[*_]*\\s*:\\s*(.*)$`, "i");

export interface Brief {
  fields: Partial<Record<BriefField, string>>;
  /** Null when the brief names no path the watcher can read. */
  scope: WriteScope | null;
  /** Commands and test files the brief names as proof. */
  namedChecks: string[];
  /** A review, a research task or a lens: its whole deliverable is a message. */
  readOnly: boolean;
}

function fieldOf(label: string): BriefField | null {
  const lower = label.toLowerCase();
  return LABELS.find(([pattern]) => new RegExp(`^(?:${pattern.source})$`).test(lower))?.[1] ?? null;
}

/** A value runs until the next template line; text before the first label is ignored. */
export function parseBrief(text: string, root: string): Brief {
  const fields: Partial<Record<BriefField, string>> = {};
  let current: BriefField | null = null;
  for (const line of text.split("\n")) {
    const match = LABEL_LINE.exec(line);
    const field = match ? fieldOf(match[1]) : null;
    if (match && field) {
      current = field;
      // a REVISED BRIEF repeats the template: the later line is the one in force
      fields[field] = match[2].trim();
    } else if (current) {
      fields[current] = `${fields[current] ?? ""}\n${line}`.trim();
    }
  }
  const scope = fields.writeScope ? parseWriteScope(fields.writeScope, fields.project?.trim() || root) : null;
  const proof = [fields.acceptance, fields.contract, fields.output].filter((v): v is string => !!v).join("\n");
  return { fields, scope, namedChecks: namedChecks(proof), readOnly: scope?.readOnly === true };
}

/** Written from the room's template, and not some other prompt that happens to hold a label. */
export function fromTemplate(brief: Brief): boolean {
  return Object.keys(brief.fields).length >= 3;
}

/** The lines a Peer cannot work well without; measured in this room, a Peer without the last one stops asking and guesses. */
const NEEDED: readonly [BriefField, string][] = [
  ["outcome", "Outcome"],
  ["writeScope", "Write scope"],
  ["acceptance", "Acceptance evidence"],
  ["reopenWhen", "Reopen when"],
  ["replyTo", "Reply with seatwork_mail to: owner"],
];

/** A needed label near the start of a line, behind whatever a REVISED BRIEF puts there to mark a changed line. */
const marked = (label: string) => new RegExp(`^.{0,30}\\b${label}\\b[^:\\n]{0,30}:`, "im");
const MARKED: Partial<Record<BriefField, RegExp>> = {
  outcome: marked("Outcome"),
  writeScope: marked("Write scope"),
  acceptance: marked("Acceptance(?: evidence)?"),
  reopenWhen: marked("Reopen when"),
  replyTo: /^.{0,30}\bReply with seatwork_mail to\b\s*:\s*[`*_"']*owner\b/im,
};

/**
 * The needed lines a brief lacks; a brief in free prose lacks them all. `mailed` is the text of a brief that came
 * as mail: there a line also counts when its label is found behind the marks of a revision.
 */
export function missingLines(brief: Brief, mailed?: string): string[] {
  const written = (field: BriefField) => (field === "replyTo" ? /^[\s`*_"']*owner\b/i.test(brief.fields.replyTo ?? "") : !!brief.fields[field]?.trim());
  const has = (field: BriefField) => written(field) || (mailed !== undefined && MARKED[field]?.test(mailed) === true);
  return NEEDED.filter(([field]) => !has(field)).map(([, label]) => label);
}

/** A quoted string names a check when it is one command that verifies something: a known runner, or a script of the project run by its path. */
function runsACheck(quoted: string): boolean {
  const line = parseShell(quoted);
  if (!line.complete || line.commands.length !== 1) return false;
  const [command] = line.commands;
  return effectsOf(command, { namedChecks: [] }).some((effect) => effect.kind === "check") || /^\.{1,2}\//.test(command.argv[0] ?? "");
}

/** The check commands a brief quotes in backticks and the test files it names; other quoted words (a branch, a path, a line of output) are not checks. */
export function namedChecks(text: string): string[] {
  const found = new Set<string>();
  for (const [, quoted] of text.matchAll(/`([^`\n]{2,120})`/g)) {
    const command = quoted.trim().replace(/\s+/g, " ");
    if (runsACheck(command)) found.add(command);
  }
  for (const [file] of text.matchAll(/[\w./-]*(?:[._-](?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py|rb)|test_\w+\.py)\b/g)) found.add(file);
  return [...found];
}
