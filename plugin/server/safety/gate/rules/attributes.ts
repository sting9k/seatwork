import table from "../../../../shared/safety/handin.json";

/** The `.gitattributes` rule of the hand-in check, read by the guard too: a file that names a filter or driver of the repository's own. */

const rule = (table.rules as { id: string; path?: string; pattern: string; flags?: string }[]).find(
  (r) => r.id === "attributes-driver",
)!;

export const ATTRIBUTES_FILE = new RegExp(rule.path!);
const DRIVER = new RegExp(rule.pattern, rule.flags ?? "");
const BLANK_ESCAPE = /\\(?:[ntr]|x20|040)/g;

/** Whether text written to an attributes file names such a driver on one of its lines, the whitespace escapes of echo and printf read as line breaks. */
export function namesDriver(text: string): boolean {
  return text
    .replace(BLANK_ESCAPE, "\n")
    .split("\n")
    .some((line) => DRIVER.test(line));
}
