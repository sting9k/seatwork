/** A brief as the room's template writes it, `Label: value` lines, or as a seat writes it with each label alone on its line, read into fields. */

type BriefField =
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
const LABEL_LINE =
  /^\s*(?:[-*>]\s+)?[*_`"']*([a-z][a-z /_-]{0,40}?)[*_]*(?:\s*\([^()\n]{0,200}\))?[*_]*(?:\s*:|\s+[—–](?=\s))\s*(.*)$/i;
const HEADING_LINE = /^(?:#{1,6} +)?[*_`]*([a-z][a-z /_-]{0,40}?)[*_`]*(?:\s*\([^()\n]{0,200}\))?[*_`]*:?$/i;
const HEADING_MOST = 260;

/** The fields a brief holds; a label may carry a note in brackets, end in a colon or a dash, or stand alone on its line as a heading; a value runs to the next label with its blank lines kept as one, and a later label of a field wins. */
export function briefFields(text: string): Partial<Record<BriefField, string>> {
  const lines: Partial<Record<BriefField, string[]>> = {};
  let open: string[] | null = null;
  for (const line of text.split("\n")) {
    const bare = line.trim();
    const match = LABEL_LINE.exec(line) ?? (bare.length <= HEADING_MOST ? HEADING_LINE.exec(bare) : null);
    const label = match?.[1].trim().toLowerCase();
    const field = label ? LABELS.find(([pattern]) => pattern.test(label))?.[1] : undefined;
    const value = match?.[2]?.trim() ?? "";
    if (field) open = lines[field] = value ? [value] : [];
    else if (open && (line.trim() || open.at(-1))) open.push(line.trim());
  }
  return Object.fromEntries(Object.entries(lines).map(([field, own]) => [field, own.join("\n").trim()]));
}

/** Whether a prompt was written from the room's template: it holds at least three of its labels, not one stray one. */
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

const ITEM_HEAD = /^\s*(?:[-*+]|\d+[.)])?\s*(?:run(?:ning)?\s+)?[*_]*`([^`\n]+)`[*_]*/i;
const AND_NEXT = /^\s*(?:,|and|&)\s*[*_]*`([^`\n]+)`[*_]*/i;
const PLACEHOLDER = /<[A-Za-z][^<>\n]*>/;

/** The commands an acceptance evidence asks for: those in backticks at the head of its lines or list items, after a "run" and joined by "and"; a quote inside a sentence names a thing, and one with a `<placeholder>` is a form to fill, not a check. */
export function acceptanceCommands(text: string): string[] {
  const heads: string[] = [];
  for (const line of text.split("\n")) {
    let match = ITEM_HEAD.exec(line);
    let rest = line;
    while (match) {
      heads.push(`\`${match[1]}\``);
      rest = rest.slice(rest.indexOf(match[0]) + match[0].length);
      match = AND_NEXT.exec(rest);
    }
  }
  return quotedCommands(heads.join("\n")).filter((command) => !PLACEHOLDER.test(command));
}

/** The globs of a write scope's first paragraph: its parts, split on commas, semicolons and new lines, each giving the paths it names before any word that turns it down (not, never, except, nothing). */
export function scopeGlobs(writeScope: string): string[] {
  const bare = (word: string) => word.replace(/^[`"'(]+|[`"'),.;:]+$/g, "");
  return writeScope
    .split(/\n\s*\n/)[0]
    .split(/[,;\n]/)
    .flatMap((part) => {
      const words = part.trim().split(/\s+/).filter(Boolean);
      if (words.length === 1) return bare(words[0]) ? [bare(words[0])] : [];
      const paths: string[] = [];
      for (const word of words) {
        if (/^(not|never|except|nothing|no|don't|dont)$/i.test(bare(word))) break;
        if (/[/*]|\.\w+$/.test(bare(word))) paths.push(bare(word));
      }
      return paths;
    });
}
