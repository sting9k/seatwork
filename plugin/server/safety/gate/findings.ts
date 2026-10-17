import grades from "../../../shared/safety/grades.json";
import { namedRule } from "./commands";
import type { Where } from "./places";
import { SEVERITY_RANK, type Doubt, type Finding, type Severity } from "./types";

/** What a command did, graded: a named rule, or an effect on files or a repository by the place it lands in. */

/** A row of the file table: an effect, `-tree` when it takes a folder with what it holds. */
export type FileRow = keyof typeof grades.files;
export type GitEffect = keyof typeof grades.git;

const FILES = grades.files as Record<FileRow, Partial<Record<Where, Severity>>>;
const GIT = grades.git as Record<GitEffect, Partial<Record<Where, Severity>>>;
const EFFECTS = grades.effects as Record<string, string>;
const PLACES = grades.places as Record<string, string>;

/** How grave an effect on a place is, or null when the table keeps none; a repository the room cannot place counts as another's. */
function severityOf(row: FileRow | GitEffect, where: Where | null): Severity | null {
  if (where === null) return null;
  if (row in GIT) return GIT[row as GitEffect][where === "seat" ? "seat" : "outside"] ?? null;
  return FILES[row as FileRow][where] ?? null;
}

/** The finding of an effect on a place, or null when the table keeps none. */
export function effectFinding(
  row: FileRow | GitEffect,
  where: Where | null,
  text: string,
  detail?: string,
): Finding | null {
  const severity = severityOf(row, where);
  if (!severity || where === null) return null;
  const effect = row.replace(/-tree$/, "");
  const at = row in GIT && where !== "seat" ? "outside" : where;
  const reason = `${EFFECTS[effect]} ${PLACES[at]}`;
  return { effect, rule: at, severity, reason: detail ? `${reason} (${detail})` : reason, text };
}

/** The finding of a named rule of shared/safety/commands.json. */
export function namedFinding(id: string, text: string, detail?: string): Finding {
  const rule = namedRule(id);
  const [effect, name] = id.split(":");
  return {
    effect,
    rule: name,
    severity: rule.severity,
    reason: detail ? `${rule.reason} (${detail})` : rule.reason,
    text,
  };
}

/** Of two places for one effect, the one the table grades worse. */
export function worse(row: FileRow, a: Where | null, b: Where | null): Where | null {
  const rank = (where: Where | null) => {
    const severity = severityOf(row, where);
    return severity ? SEVERITY_RANK[severity] : -1;
  };
  return rank(b) > rank(a) ? b : a;
}

/** The findings and doubts of one evaluation; one finding found twice in the same command text is kept once. */
export class Findings {
  readonly found: Finding[] = [];
  readonly doubts: Doubt[] = [];
  private readonly keys = new Set<string>();

  /** A named rule that held for a command. */
  named(id: string, text: string, detail?: string): void {
    this.keep(namedFinding(id, text, detail));
  }

  /** An effect on files or a repository, kept when the table grades it for that place. */
  effect(row: FileRow | GitEffect, where: Where | null, text: string, detail?: string): void {
    const found = effectFinding(row, where, text, detail);
    if (found) this.keep(found);
  }

  doubt(reason: string, text: string): void {
    this.doubts.push({ reason, text });
  }

  private keep(found: Finding): void {
    const key = `${found.effect}\0${found.rule}\0${found.text}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.found.push(found);
  }
}
