import { resolve } from "node:path";
import table from "../../shared/safety/acceptance.json";
import { runGit } from "../git";
import type { TurnEvent } from "../host";
import { NOT_ROOM_FOLDER } from "../paths";
import { maskOf, pathsOf, runsOneOf, turnFacts } from "./council/facts";
import type { AcceptRow, FindingRow, HandedWork } from "./store";

/** The gates on accepted work, by facts: before ACCEPT, before DONE, at push. */

type Rule = keyof typeof table.rules;

/** One thing a gate found missing, and the line that says it. */
export interface Gap {
  rule: Rule;
  line: string;
}

/** What the ACCEPT gate reads; a null turn or digest could not be read. */
export interface Acceptance {
  wanted: readonly string[];
  events: readonly TurnEvent[] | null;
  handed: HandedWork | null;
  now: string | null;
  blocking: readonly FindingRow[];
  text: string;
}

/** A gate's mode and gaps, and the record it keeps once the mail goes clean. */
export interface Gate {
  mode: "block" | "warn";
  gaps: Gap[];
  keep(): void;
}

/** A push and the first of its commits no gate holds; null when unknown. */
export interface Pushed {
  dir: string;
  remote: string;
  ref: string;
  sha: string;
  uncovered: string[] | null;
  more: boolean;
}

/** A push as its shell line gives it: folder, remote, refspecs, every branch. */
interface PushLine {
  dir: string;
  remote: string;
  refspecs: string[];
  all: boolean;
}

export const TURN_ENTRIES: number = table.turnEntries;
export const ACCEPTS_READ: number = table.acceptsRead;
export const HEADS_READ: number = table.headsRead;
export const PUSHES_READ: number = table.pushesRead;
export const GATE_KEEP_DAYS: number = table.keepDays;
export const OPEN_MOST: number = table.openMost;
const WAIVE = new RegExp(table.waive, "i");
const PUSH = /\bgit\b.*\bpush\b/;
const NAMED = 8;
const REFS_READ = 10;
const PARALLEL = 4;
const GIT = { timeoutMs: 15_000, maxBytes: 4 << 20 };

const gap = (rule: Rule, fill: Record<string, string> = {}): Gap => ({
  rule,
  line: table.rules[rule].replace(/\{(\w+)\}/g, (whole, name: string) => fill[name] ?? whole),
});

/** A list cut to its first few, with an ellipsis for the rest. */
const named = (items: readonly string[]) => `${items.slice(0, NAMED).join(", ")}${items.length > NAMED ? ", …" : ""}`;

/** The paths a run names beyond its command's own: it checks only those. */
function narrowedTo(run: string, command: string): string[] | null {
  const ran = pathsOf(run.replace(/\s\d*[<>]{1,2}&?\s*\S+/g, " "), [command], "/");
  if (!ran) return null;
  const own = pathsOf(command, [command], "/") ?? [];
  const extra = ran.filter((path) => !own.includes(path));
  return extra.length ? extra : null;
}

/** The commands of `wanted` the turn did not run whole, unmasked and passing. */
export function runGaps(wanted: readonly string[], events: readonly TurnEvent[] | null, turn: string): Gap[] {
  if (events === null) return wanted.map((command) => gap("unread", { turn, command: `\`${command}\`` }));
  const after = events.slice(turnFacts(events, wanted).lastChange + 1);
  const gaps: Gap[] = [];
  for (const command of wanted) {
    const fill = { turn, command: `\`${command}\`` };
    const runs = after
      .filter(
        (event): event is Extract<TurnEvent, { kind: "shell" }> =>
          event.kind === "shell" &&
          event.status !== "running" &&
          event.exitCode === 0 &&
          runsOneOf(event.command, [command]),
      )
      .map((event) => ({ masked: maskOf(event.command, wanted), narrowed: narrowedTo(event.command, command) }));
    if (runs.some((run) => run.masked === null && run.narrowed === null)) continue;
    const last = runs.at(-1);
    gaps.push(
      !last
        ? gap("unrun", fill)
        : last.masked
          ? gap("masked", { ...fill, why: last.masked })
          : gap("narrowed", { ...fill, paths: named(last.narrowed!) }),
    );
  }
  return gaps;
}

/** The finding ids an ACCEPT waives, on lines that give a reason. */
function waivedIn(text: string): string[] {
  return text.split("\n").flatMap((line) => WAIVE.exec(line)?.[1]?.toLowerCase() ?? []);
}

/** The gaps between an ACCEPT and its turn, its hand-in and its waivers. */
export function gapsOf(input: Acceptance): Gap[] {
  const gaps = runGaps(input.wanted, input.events, "the accepting turn");
  if (!input.handed?.head) gaps.push(gap("unhanded"));
  else if (input.now === null) gaps.push(gap("unreadWork"));
  else if (input.now !== input.handed.digest) gaps.push(gap("changed"));
  const names = (id: string) => input.blocking.filter((finding) => finding.fingerprint.startsWith(id)).length === 1;
  const waived = waivedIn(input.text).filter(names);
  const standing = input.blocking.filter((finding) => !waived.some((id) => finding.fingerprint.startsWith(id)));
  if (standing.length)
    gaps.push(
      gap("unwaived", {
        findings: named(
          standing.map(
            (finding) =>
              `${finding.fingerprint} ${finding.rule} at ${finding.path}${finding.line ? `:${finding.line}` : ""}`,
          ),
        ),
      }),
    );
  return gaps;
}

/** One line of git's output; null when git failed or said nothing. */
async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  const ran = await runGit(cwd, args, GIT);
  return ran.code === 0 ? ran.out.trim() || null : null;
}

/** Paths changed from `from` to `to`, or the work tree; null when git fails. */
async function changedBetween(
  cwd: string,
  from: string,
  to: string | null,
  paths: readonly string[],
): Promise<string[] | null> {
  const within = paths.length ? paths : [NOT_ROOM_FOLDER];
  const range = to ? [from, to] : [from];
  const ran = await runGit(
    cwd,
    ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", ...range, "--", ...within],
    GIT,
  );
  return ran.code === 0 ? ran.out.split("\0").filter(Boolean) : null;
}

/** The gaps between a DONE and its accepted heads, files and runs. */
export async function doneGaps(
  cwd: string,
  open: readonly AcceptRow[],
  more: boolean,
  events: readonly TurnEvent[],
): Promise<{ gaps: Gap[]; head: string | null }> {
  const commands = [...new Set(open.flatMap((accept) => JSON.parse(accept.commands) as string[]))];
  const gaps = runGaps(commands, events, "the DONE turn");
  if (more) gaps.push(gap("many", { n: String(open.length) }));
  const head = await gitLine(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head) return { gaps: [...gaps, gap("unreadHead")], head: null };
  for (let at = 0; at < open.length; at += PARALLEL)
    for (const found of await Promise.all(open.slice(at, at + PARALLEL).map((accept) => heldIn(cwd, accept, head))))
      if (found) gaps.push(found);
  return { gaps, head };
}

/** The gap when `head` lacks an accepted head or an accepted file changed. */
async function heldIn(cwd: string, accept: AcceptRow, head: string): Promise<Gap | null> {
  const fill = { task: accept.task, head: accept.head.slice(0, 8) };
  const holds = await runGit(cwd, ["merge-base", "--is-ancestor", accept.head, head], GIT);
  if (holds.code !== 0) return gap(holds.code === 1 ? "missing" : "untold", fill);
  const files = await changedBetween(cwd, accept.base, accept.head, []);
  const changed = files?.length ? await changedBetween(cwd, accept.head, null, files.slice(0, table.filesRead)) : files;
  if (changed === null) return gap("untold", fill);
  return changed.length ? gap("altered", { ...fill, files: named(changed) }) : null;
}

/** A shell word without the quotes around it. */
const bare = (word: string) => word.replace(/^(['"])(.*)\1$/, "$2");

/** The pushes in a shell line, with their folders; dry runs and deletes left out. */
export function pushesIn(command: string, cwd: string): PushLine[] {
  const out: PushLine[] = [];
  let dir = cwd;
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean).map(bare);
    if (words[0] === "cd" && words.length === 2 && !words[1].startsWith("~")) dir = resolve(dir, words[1]);
    const at = words.findIndex((word) => word === "git" || word.endsWith("/git"));
    if (at < 0 || !PUSH.test(part)) continue;
    let here = dir;
    let i = at + 1;
    for (; i < words.length && words[i].startsWith("-"); i += 1)
      if (words[i] === "-C") here = resolve(here, words[(i += 1)] ?? ".");
      else if (words[i] === "-c") i += 1;
    if (words[i] !== "push") continue;
    const flags: string[] = [];
    const positional: string[] = [];
    for (let j = i + 1; j < words.length; j += 1) {
      if (["-o", "--push-option", "--receive-pack", "--exec", "--repo"].includes(words[j])) j += 1;
      else if (words[j].startsWith("-")) flags.push(words[j]);
      else positional.push(words[j]);
    }
    const short = (letter: string) => flags.some((flag) => /^-[^-]/.test(flag) && flag.includes(letter));
    if (flags.some((flag) => /^--(dry-run|delete)$/.test(flag)) || short("n") || short("d")) continue;
    const all = flags.some((flag) => /^--(all|mirror|branches)$/.test(flag));
    if (!all && positional.length < 2 && flags.includes("--tags")) continue;
    out.push({ dir: here, remote: positional[0] ?? "(default)", refspecs: positional.slice(1, 1 + REFS_READ), all });
  }
  return out;
}

/** The commits a push sent, by ref. */
async function targetsOf(line: PushLine): Promise<{ ref: string; sha: string }[]> {
  if (line.all) {
    const listed = await runGit(
      line.dir,
      ["for-each-ref", `--count=${REFS_READ}`, "--format=%(objectname) %(refname:short)", "refs/heads"],
      GIT,
    );
    if (listed.code !== 0) return [];
    return listed.out
      .split("\n")
      .filter(Boolean)
      .map((row) => ({ sha: row.slice(0, row.indexOf(" ")), ref: row.slice(row.indexOf(" ") + 1) }));
  }
  const out: { ref: string; sha: string }[] = [];
  for (const spec of line.refspecs.length ? line.refspecs : ["HEAD"]) {
    const [src, dst] = spec.replace(/^\+/, "").split(":", 2);
    if (!src || src.startsWith("-")) continue;
    const sha = await gitLine(line.dir, ["rev-parse", "--verify", "--quiet", `${src}^{commit}`]);
    const ref = dst || (src === "HEAD" ? await gitLine(line.dir, ["rev-parse", "--abbrev-ref", "HEAD"]) : src);
    if (sha) out.push({ sha, ref: (ref ?? src).replace(/^refs\/heads\//, "") });
  }
  return out;
}

/** The pushes a shell line made, each with its commits no ACCEPT or DONE holds. */
export async function pushedBy(
  command: string,
  cwd: string,
  facts: (dir: string) => Promise<{ base: string | null; heads: readonly string[] } | null>,
): Promise<Pushed[]> {
  const out: Pushed[] = [];
  for (const line of pushesIn(command, cwd)) {
    const known = await facts(line.dir);
    for (const target of await targetsOf(line)) {
      const listed = known?.base
        ? await runGit(
            line.dir,
            [
              "rev-list",
              "--ignore-missing",
              `--max-count=${table.uncoveredShown + 1}`,
              target.sha,
              "--not",
              known.base,
              ...known.heads,
            ],
            GIT,
          )
        : null;
      const uncovered = listed?.code === 0 ? listed.out.split("\n").filter(Boolean) : null;
      out.push({
        dir: line.dir,
        remote: line.remote,
        ref: target.ref,
        sha: target.sha,
        uncovered: uncovered?.slice(0, table.uncoveredShown) ?? null,
        more: (uncovered?.length ?? 0) > table.uncoveredShown,
      });
    }
  }
  return out;
}

/** Whether a turn's shell step pushed and passed. */
export const isPush = (event: TurnEvent): event is Extract<TurnEvent, { kind: "shell" }> =>
  event.kind === "shell" && event.status === "completed" && event.exitCode === 0 && PUSH.test(event.command);
