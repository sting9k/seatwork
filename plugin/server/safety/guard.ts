import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Evaluation, type GateConfig, type Tools } from "./gate/evaluate";
import { packsInForce, ruleOf, type Mode } from "./gate/packs";
import { within } from "./gate/paths";
import { guardOf } from "./gate/rules/protected";
import { SEVERITY_RANK, type Doubt, type Finding, type Place } from "./gate/types";
import { redact } from "../redact";
import { codeHash, type Grantor, type SafetyStore } from "./store";
import type { CouncilPolicy } from "./council/council";

/** The command guard: packs, the owner's exceptions and one-time codes. */

/** One exception of the owner's: a `pack:rule` lifted, or a command or prefix that runs as is, in `paths` (anywhere when absent) until `until`. */
export interface AllowEntry {
  rule?: string;
  command?: string;
  prefix?: string;
  paths?: string[];
  until?: string;
}

/** The owner's settings for the guard, the council and the hand-in check, as the policy file holds them. */
export interface SafetyPolicy {
  mode?: "on" | "off";
  packs?: { add?: string[]; remove?: string[] };
  rules?: Record<string, Mode>;
  allow?: AllowEntry[];
  exempt?: Record<string, string[]>;
  budgetMs?: number;
  maxBytes?: number;
  codeHours?: number;
  repeat?: { count: number; minutes: number };
  handin?: { mode: "block" | "warn" | "off" };
  council?: CouncilPolicy;
}

/** The seat a call comes from, as far as the room knows it. */
export interface SeatRef {
  id: string;
  role: string | null;
  project: string | null;
  tmp: string | null;
  start: string | null;
}

/** The guard's answer to one call: whether it runs, what the seat is told, and the code that lets it run once. */
export interface Ruling {
  allow: boolean;
  message: string | null;
  finding: Finding | null;
  code: string | null;
  grantor: Grantor | null;
}

/** What the guard needs of the room; `repeated` lets a seat's Owner hear of a rule the seat keeps hitting. */
interface GuardDeps {
  store(): SafetyStore;
  policy(): SafetyPolicy | undefined;
  tools(seat: SeatRef | null): Tools;
  place(seat: SeatRef | null): Place;
  repeated(seat: SeatRef, rule: string, count: number, command: string): void;
}

/** One call under judgement: who asks, what, where, and when the guard began on it. */
interface Call {
  seat: SeatRef | null;
  cli: string;
  command: string;
  cwd: string | null;
  dry: boolean;
  began: bigint;
}

/** What a project's file asks of the guard: packs to turn on and rules to raise. */
interface ProjectRules {
  add: string[];
  rules: Record<string, Mode>;
}

const DEFAULTS = { budgetMs: 1000, maxBytes: 64 * 1024, codeHours: 24, repeat: { count: 3, minutes: 30 } };
const CHAIN = /[;&|`\n<>]|\$\(/;
const RANK: Record<Mode, number> = { log: 0, warn: 1, ask: 2, deny: 3 };
const RULES_LOOKED_MS = 3000;
const NO_RULES: ProjectRules = { add: [], rules: {} };

/** Judges each shell command and file write of a seat by the packs in force, the owner's exceptions and granted codes. */
export class Guard {
  private projectRules = new Map<string, { mtime: number; at: number; rules: ProjectRules }>();

  constructor(private readonly deps: GuardDeps) {}

  /** One shell command a seat is about to run; `dry` keeps nothing. */
  async check(seat: SeatRef | null, cli: string, command: string, cwd: string | null, dry = false): Promise<Ruling> {
    return this.judge({ seat, cli, command, cwd, dry, began: process.hrtime.bigint() }, async (place) =>
      evaluate(command, cwd, place, this.gateConfig(place), this.deps.tools(seat)),
    );
  }

  /** A file an editing tool is about to write (Write, Edit, apply_patch, a plugin's write). */
  async checkWrite(seat: SeatRef | null, cli: string, path: string, cwd: string | null): Promise<Ruling> {
    const call = { seat, cli, command: `write ${path}`, cwd, dry: false, began: process.hrtime.bigint() };
    return this.judge(call, async (place) => ({ findings: writeFindings(path, place, cwd), doubts: [] }));
  }

  /** The gate's settings at a place: the policy's, with the packs the place's project adds. */
  gateConfig(place: Place): GateConfig {
    const policy = this.deps.policy() ?? {};
    const added = [...(policy.packs?.add ?? []), ...this.rulesOf(place.project).add];
    return {
      packs: packsInForce(added, policy.packs?.remove ?? []),
      exempt: policy.exempt ?? {},
      budgetMs: policy.budgetMs ?? DEFAULTS.budgetMs,
      maxBytes: policy.maxBytes ?? DEFAULTS.maxBytes,
    };
  }

  /** The owner's exceptions, then a code granted for this call, then what the rules find. */
  private async judge(call: Call, read: (place: Place) => Promise<Evaluation>): Promise<Ruling> {
    const { seat, command, cwd } = call;
    const policy = this.deps.policy() ?? {};
    if ((policy.allow ?? []).some((e) => live(e) && inPaths(e, cwd) && runsAsIs(e, command))) return pass();
    const used = call.dry ? null : this.deps.store().consume(codeHash(seat?.id ?? null, cwd, command));
    if (used) {
      this.record(call, { verdict: "granted", pack: used.pack, rule: used.rule, severity: null, code: used.code });
      return pass();
    }
    const place = this.deps.place(seat);
    const found = await read(place);
    const lifted = (f: Finding) =>
      (policy.allow ?? []).some((e) => live(e) && e.rule === `${f.pack}:${f.rule}` && inPaths(e, cwd));
    const rules = { ...this.rulesOf(place.project).rules, ...(policy.rules ?? {}) };
    return this.conclude(
      call,
      found.findings.filter((f) => !lifted(f)),
      found.doubts,
      { ...policy, rules },
    );
  }

  /** Ranks what was found by how the rules treat it: a deny or an ask stops the call, anything else lets it run. */
  private conclude(call: Call, findings: Finding[], doubts: Doubt[], policy: SafetyPolicy): Ruling {
    const ranked = findings
      .map((f) => ({ f, mode: modeOf(f, policy.rules ?? {}) }))
      .sort((a, b) => RANK[b.mode] - RANK[a.mode] || SEVERITY_RANK[b.f.severity] - SEVERITY_RANK[a.f.severity]);
    const blocks = ranked.filter((r) => r.mode === "deny" || r.mode === "ask");
    if (blocks.length || doubts.length) return this.stop(call, blocks, doubts, policy);
    const top = ranked[0];
    const verdict = top ? (top.mode === "warn" ? "warn" : "log") : "allow";
    // a command that only passes is no news: what is kept is what a rule said something of
    if (!call.dry && verdict !== "allow")
      this.record(call, {
        verdict,
        pack: top?.f.pack ?? null,
        rule: top?.f.rule ?? null,
        severity: top?.f.severity ?? null,
        code: null,
      });
    return {
      allow: true,
      message: top?.mode === "warn" ? warning(top.f) : null,
      finding: top?.f ?? null,
      code: null,
      grantor: null,
    };
  }

  /** Stops a call: a code for it, a record, and a word to the seat's Owner when the seat keeps hitting the same rule. */
  private stop(call: Call, blocks: { f: Finding }[], doubts: Doubt[], policy: SafetyPolicy): Ruling {
    const { seat, command, cwd } = call;
    const store = this.deps.store();
    const decided = blocks[0]?.f ?? null;
    const grantor: Grantor = blocks.some((b) => ruleOf(b.f.pack, b.f.rule)?.grant === "human") ? "human" : "owner";
    const hours = policy.codeHours ?? DEFAULTS.codeHours;
    if (call.dry)
      return {
        allow: false,
        message: blocked(decided, doubts, "(none: a check gives no code)", grantor, command, 0),
        finding: decided,
        code: null,
        grantor,
      };
    const pack = decided?.pack ?? "gate";
    const rule = decided?.rule ?? "unverified";
    const code = store.issue({
      hash: codeHash(seat?.id ?? null, cwd, command),
      seat: seat?.id ?? null,
      cwd,
      shown: redact(command),
      pack,
      rule,
      grantor,
      hours,
    });
    this.record(call, { verdict: "deny", pack, rule, severity: decided?.severity ?? null, code });
    if (seat && decided) {
      const repeat = policy.repeat ?? DEFAULTS.repeat;
      const since = new Date(Date.now() - repeat.minutes * 60_000);
      const count = store.denials(seat.id, decided.rule, since);
      if (count >= repeat.count && store.escalate(seat.id, decided.rule, since))
        this.deps.repeated(seat, `${decided.pack}:${decided.rule}`, count, redact(command));
    }
    return {
      allow: false,
      message: blocked(decided, doubts, code, grantor, command, hours),
      finding: decided,
      code,
      grantor,
    };
  }

  /** Keeps what the guard decided of a call. */
  private record(
    call: Call,
    what: {
      verdict: "granted" | "warn" | "log" | "deny";
      pack: string | null;
      rule: string | null;
      severity: string | null;
      code: string | null;
    },
  ): void {
    const { seat } = call;
    this.deps.store().record({
      seat: seat?.id ?? null,
      role: seat?.role ?? null,
      cli: call.cli,
      cwd: call.cwd,
      command: redact(call.command),
      ...what,
      elapsedUs: Number(process.hrtime.bigint() - call.began) / 1000,
    });
  }

  /** A project's `.seatwork/safety.json`: turns packs on and raises rules, never loosens. */
  private rulesOf(project: string | null): ProjectRules {
    if (!project) return NO_RULES;
    const file = join(project, ".seatwork", "safety.json");
    const cached = this.projectRules.get(file);
    // the file is looked at again every few seconds, not on every command
    if (cached && Date.now() - cached.at < RULES_LOOKED_MS) return cached.rules;
    let mtime = -1;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      // no file raises no rule
    }
    if (cached && cached.mtime === mtime) {
      cached.at = Date.now();
      return cached.rules;
    }
    const rules = mtime < 0 ? NO_RULES : readRules(file);
    this.projectRules.set(file, { mtime, at: Date.now(), rules });
    return rules;
  }
}

/** The packs and raised rules a project file names; an unreadable file names none. */
function readRules(file: string): ProjectRules {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { packs?: { add?: string[] }; rules?: Record<string, Mode> };
    const raised = Object.entries(raw.rules ?? {}).filter(
      ([key, mode]) => RANK[mode] !== undefined && RANK[mode] >= RANK[baseMode(key)],
    );
    return { add: raw.packs?.add ?? [], rules: Object.fromEntries(raised) };
  } catch {
    return NO_RULES;
  }
}

/** What the file rules say of writing one path. */
function writeFindings(path: string, place: Place, cwd: string | null): Finding[] {
  const word = {
    raw: path,
    start: 0,
    end: 0,
    parts: [{ kind: "text" as const, text: path, quote: "single" as const }],
  };
  const found = guardOf({ text: path, prefix: path, quoted: true, glob: false, temp: false, word }, "write", {
    place,
    cwd,
  });
  if (!found) return [];
  const rule = ruleOf(found.pack, found.rule)!;
  return [
    {
      pack: found.pack,
      rule: found.rule,
      severity: rule.severity,
      reason: `${rule.reason} (${found.path})`,
      explanation: rule.explanation,
      safer: rule.safer,
      text: `write ${path}`,
    },
  ];
}

const pass = (): Ruling => ({ allow: true, message: null, finding: null, code: null, grantor: null });
const live = (e: AllowEntry) => !e.until || Date.parse(e.until) > Date.now();
const inPaths = (e: AllowEntry, cwd: string | null) =>
  !e.paths?.length || (cwd !== null && e.paths.some((p) => within(cwd, p)));
const runsAsIs = (e: AllowEntry, command: string) =>
  e.command === command ||
  (e.prefix !== undefined && command.startsWith(e.prefix) && !CHAIN.test(command.slice(e.prefix.length)));

/** The mode a rule has with no setting of the owner's: its own, else by its level. */
function baseMode(key: string): Mode {
  const [pack, rule] = key.split(":");
  const declared = ruleOf(pack, rule);
  if (!declared) return "log";
  return (
    declared.mode ??
    (declared.severity === "critical" || declared.severity === "high"
      ? "deny"
      : declared.severity === "medium"
        ? "warn"
        : "log")
  );
}

/** How a finding is treated: the owner's rule setting, else the pack's, else its level. */
function modeOf(f: Finding, rules: Record<string, Mode>): Mode {
  const exact = rules[`${f.pack}:${f.rule}`];
  if (exact) return exact;
  const base = baseMode(`${f.pack}:${f.rule}`);
  const broad = rules[`${f.pack}:*`];
  // a pack-wide setting never lowers a critical rule; only the rule's own name can
  if (broad && !(f.severity === "critical" && RANK[broad] < RANK[base])) return broad;
  return base;
}

/** What a stopped seat reads: why, that the answer is final, and how its Owner lets it run once. */
function blocked(
  f: Finding | null,
  doubts: Doubt[],
  code: string,
  grantor: Grantor,
  command: string,
  hours: number,
): string {
  const lines: string[] = [];
  if (f) {
    lines.push(`The room's guard blocked this command: ${f.reason}.`);
    lines.push(`Rule ${f.pack}:${f.rule} (${f.severity}).${f.explanation ? ` ${f.explanation}` : ""}`);
    if (f.safer?.length) lines.push(`Safer: ${f.safer.join("; ")}.`);
  } else
    lines.push(
      `The room's guard could not read this command, so it does not run: ${doubts.map((d) => d.reason).join("; ")}.`,
    );
  lines.push(
    "This answer is final for this command: do not try another spelling, a script, an alias or another tool to do the same thing.",
  );
  lines.push(
    grantor === "human"
      ? `Only the person can let it run: tell your Owner why you need it and give code ${code}.`
      : `If you need it, ask your Owner to allow it once with code ${code}: this exact command, in this folder, within ${hours} hours.`,
  );
  const shown = redact(command);
  lines.push(`Command: ${shown.length > 400 ? `${shown.slice(0, 400)}...` : shown}`);
  return lines.join("\n");
}

/** The note that rides on a call the guard let run. */
function warning(f: Finding): string {
  return `The room's guard let this run with a note: ${f.reason} (rule ${f.pack}:${f.rule}).${f.explanation ? ` ${f.explanation}` : ""}`;
}
