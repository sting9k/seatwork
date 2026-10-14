/** A brief as the room's template writes it: `Label: value` lines, read into fields. */

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

const LABELS: readonly [RegExp, BriefField][] = [
  [/^project$/, "project"],
  [/^outcome$/, "outcome"],
  [/^(?:current )?candidate$/, "candidate"],
  [/^context$/, "context"],
  [/^write scope$/, "writeScope"],
  [/^(?:contract(?: ?\/ ?invariants)?|invariants)$/, "contract"],
  [/^yours to decide$/, "decide"],
  [/^(?:verified )?constraints$/, "constraints"],
  [/^output$/, "output"],
  [/^acceptance(?: evidence)?$/, "acceptance"],
  [/^reopen when$/, "reopenWhen"],
  [/^what was tried$/, "tried"],
  [/^reply with seatwork_mail to$/, "replyTo"],
  [/^non-?goals$/, "nonGoals"],
  [/^authority$/, "authority"],
  [/^open assumptions$/, "openAssumptions"],
  [/^decisions made$/, "decisions"],
  [/^inputs$/, "inputs"],
  [/^lane$/, "lane"],
];
const LABEL_LINE = /^\s*(?:[-*>]\s+)?[*_`"']*([a-z][a-z /_-]*?)[*_]*\s*:\s*(.*)$/i;

/** The fields a brief holds; a value runs to the next label, and a later label of a field wins. */
export function briefFields(text: string): Partial<Record<BriefField, string>> {
  const lines: Partial<Record<BriefField, string[]>> = {};
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    const match = LABEL_LINE.exec(line);
    const label = match?.[1].trim().toLowerCase();
    const field = label ? LABELS.find(([pattern]) => pattern.test(label))?.[1] : undefined;
    if (field) open = lines[field] = match![2].trim() ? [match![2].trim()] : [];
    else if (open && line.trim()) open.push(line.trim());
  }
  return Object.fromEntries(Object.entries(lines).map(([field, own]) => [field, own.join("\n")]));
}

/** Written from the room's template, and not some other prompt that happens to hold a label. */
export const fromTemplate = (prompt: string): boolean => Object.keys(briefFields(prompt)).length >= 3;

const PROGRAM = /^(?:\.{0,2}\/[\w./-]+|[a-z][\w.+-]*)$/i;

/** The commands a brief quotes in backticks: a program first, not an expression or a file name. */
export function quotedCommands(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1].trim())
    .filter((command) => {
      const [first, ...rest] = command.split(/\s+/);
      return PROGRAM.test(first) && (rest.length > 0 || /^\.{0,2}\//.test(first) || !/\.\w+$/.test(first));
    });
}

/** The globs of a write scope, split on commas and new lines. */
export function scopeGlobs(writeScope: string): string[] {
  return writeScope
    .split(/[,\n]/)
    .map((part) => part.trim().replace(/^[`"']|[`"']$/g, ""))
    .filter((part) => part && !/\s/.test(part));
}
