import { absolute, isTemp, lossOf, valueOf, within } from "../paths";
import { literal, type Word } from "../shell";
import type { Scene, Value } from "../types";
import { protectedTarget } from "./protected";

/** `rm` read as GNU and BSD rm read their options, judged by what it would remove (DCG). */

export interface RmHit {
  rule: string;
  detail: string;
}

export interface RmTools {
  /** git leaves this path out of the project: generated, made again by a build */
  ignored(paths: string[]): Promise<ReadonlySet<string>>;
  exempt(rule: string, paths: string[]): boolean;
}

type Mode = "none" | "always" | "once";

interface Flags {
  recursive: boolean;
  force: boolean;
  combined: boolean;
  longRecursive: boolean;
  longForce: boolean;
  shortForce: boolean;
  mode: Mode;
  operands: Word[];
}

const LONG = [
  "dir",
  "force",
  "help",
  "interactive",
  "no-preserve-root",
  "one-file-system",
  "preserve-root",
  "presume-input-tty",
  "recursive",
  "verbose",
  "version",
];

/** GNU rm: options anywhere before `--`; null when rm would refuse the line or print help. */
function gnu(args: Word[]): Flags | null {
  const flags = blank();
  let ended = false;
  for (const word of args) {
    const text = literal(word);
    if (ended || text === null || text === "-" || !text.startsWith("-")) {
      flags.operands.push(word);
      continue;
    }
    if (text === "--") {
      ended = true;
      continue;
    }
    if (text.startsWith("--")) {
      const [name, value] = text.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const matches = LONG.filter((l) => l.startsWith(name));
      const full = matches.includes(name) ? name : matches.length === 1 ? matches[0] : null;
      if (!full || full === "help" || full === "version") return null;
      if (value !== undefined && full !== "interactive" && full !== "preserve-root") return null;
      if (full === "recursive") {
        flags.recursive = true;
        flags.longRecursive = true;
      } else if (full === "force") {
        flags.force = true;
        flags.longForce = true;
        flags.mode = "none";
      } else if (full === "interactive") {
        const when = value === undefined ? "always" : value;
        if (["never", "no", "none"].some((w) => w.startsWith(when) && when)) flags.mode = "none";
        else if ("once".startsWith(when) && when) flags.mode = "once";
        else if (["always", "yes"].some((w) => w.startsWith(when) && when)) flags.mode = "always";
        else return null;
      }
      continue;
    }
    if (!short(text.slice(1), flags)) return null;
  }
  return flags;
}

/** BSD rm, the one macOS ships: options stop at the first operand, short ones only. */
function bsd(args: Word[]): Flags | null {
  const flags = blank();
  let i = 0;
  for (; i < args.length; i += 1) {
    const text = literal(args[i]);
    if (text === null || text === "-" || !text.startsWith("-")) break;
    if (text === "--") {
      i += 1;
      break;
    }
    if (!short(text.slice(1), flags, "dfiIPRrvWx")) return null;
  }
  flags.operands = args.slice(i);
  return flags;
}

function short(cluster: string, flags: Flags, allowed = "rRfiIdEPvWx"): boolean {
  const hasR = /[rR]/.test(cluster);
  const hasF = cluster.includes("f");
  for (const c of cluster) {
    if (!allowed.includes(c)) return false;
    if (c === "r" || c === "R") flags.recursive = true;
    else if (c === "f") {
      flags.force = true;
      flags.shortForce = true;
      flags.mode = "none";
    } else if (c === "i") flags.mode = "always";
    else if (c === "I") flags.mode = "once";
  }
  if (hasR && hasF) flags.combined = true;
  return true;
}

function blank(): Flags {
  return {
    recursive: false,
    force: false,
    combined: false,
    longRecursive: false,
    longForce: false,
    shortForce: false,
    mode: "none",
    operands: [],
  };
}

/** The rule name for a recursive rm, by how force was written and what it targets. */
function recursiveRule(flags: Flags, severe: boolean): string {
  if (!flags.force) return severe ? "rm-recursive-root-home" : "rm-recursive-general";
  if (flags.combined) return severe ? "rm-rf-root-home" : "rm-rf-general";
  if (flags.longRecursive && flags.longForce && !flags.shortForce)
    return severe ? "rm-recursive-force-root-home" : "rm-recursive-force-long";
  return severe ? "rm-r-f-separate-root-home" : "rm-r-f-separate";
}

/** What one reading of rm's options makes of the line: a rule, allowed, or nothing. */
async function judge(flags: Flags | null, scene: Scene, tools: RmTools): Promise<RmHit | "allow" | null> {
  if (!flags || !flags.operands.length) return null;
  // a real prompt with nobody feeding stdin deletes nothing unattended
  const prompts = flags.mode === "always" || (flags.mode === "once" && (flags.recursive || flags.operands.length > 3));
  if (prompts && !scene.stdinFed) return "allow";
  const values = flags.operands.map((w) => valueOf(w, scene));
  if (flags.recursive) {
    let severe = false;
    let generated = true;
    const named: string[] = [];
    const inside: string[] = [];
    for (const value of values) {
      if (isTemp(value, scene)) continue;
      const loss = lossOf(value, scene, scene.place.project);
      if (loss === "critical") severe = true;
      const path = absolute(value, scene.cwd);
      named.push(path ?? value.word.raw);
      const inProject =
        path !== null &&
        scene.place.project !== null &&
        within(path, scene.place.project) &&
        path !== scene.place.project;
      if (inProject && !value.glob) inside.push(path!);
      else generated = false;
    }
    if (!named.length) return "allow";
    // git is asked once, and only when every target could be something a build makes again
    if (!severe && generated) generated = (await tools.ignored(inside)).size === inside.length;
    const rule = recursiveRule(flags, severe);
    if (tools.exempt(rule, named)) return "allow";
    if (!severe && generated) return { rule: "rm-generated", detail: named.join(", ") };
    return { rule, detail: named.join(", ") };
  }
  for (const value of values) {
    if (value.text === null || value.quoted) continue;
    if (value.text === "/*") return { rule: "rm-bare-glob-root", detail: "/*" };
  }
  for (const value of values) {
    if (value.text === null || value.quoted) continue;
    if (value.text === "*" || value.text === "./*") return { rule: "rm-bare-glob", detail: value.text };
  }
  for (const value of values) {
    const target = protectedTarget(value, scene);
    if (target) return { rule: "rm-protected-file", detail: target };
  }
  for (const value of values) {
    if (!value.glob || value.text === null) continue;
    const path = value.text;
    if (within(path, scene.place.home) || /^\/(Users|home)\//.test(path)) return { rule: "rm-glob-home", detail: path };
  }
  return null;
}

/** DCG's rm rules for a command that runs rm (or rimraf, which is `rm -rf`). */
export async function rmRules(scene: Scene, tools: RmTools): Promise<RmHit | null> {
  const args = scene.call.args;
  if (scene.call.name === "rimraf") {
    const operands = args.filter((w) => !(literal(w) ?? "").startsWith("-"));
    const flags = { ...blank(), recursive: true, force: true, combined: true, operands };
    const found = await judge(flags, scene, tools);
    return found === "allow" ? null : found;
  }
  const [a, b] = await Promise.all([judge(gnu(args), scene, tools), judge(bsd(args), scene, tools)]);
  if (a && a !== "allow") return a;
  if (b && b !== "allow") return b;
  return null;
}

/** True when these arguments would be blocked had the command word been `rm`. */
export async function wouldBlockAsRm(scene: Scene, tools: RmTools): Promise<boolean> {
  const found = await rmRules({ ...scene, call: { ...scene.call, name: "rm" } }, tools);
  return found !== null && found.rule !== "rm-generated";
}

export type { Value };
