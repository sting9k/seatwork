import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Tools } from "./gate/evaluate";
import { packsInForce, ruleOf, type Mode } from "./gate/packs";
import { within } from "./gate/paths";
import { guardOf } from "./gate/rules/protected";
import { SEVERITY_RANK, type Doubt, type Finding, type Place } from "./gate/types";
import { redact } from "../redact";
import { codeHash, type Grantor, type SafetyStore } from "./store";
import type { CouncilPolicy } from "./council/council";

/** The command guard: packs, the owner's exceptions and one-time codes. */

export interface AllowEntry {
  /** `pack:rule`; its findings are lifted */
  rule?: string;
  command?: string;
  prefix?: string;
  /** folders the entry holds in; anywhere when absent */
  paths?: string[];
  until?: string;
}

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

export interface SeatRef {
  id: string;
  role: string | null;
  project: string | null;
  tmp: string | null;
  start: string | null;
}

export interface Verdict {
  allow: boolean;
  message: string | null;
  finding: Finding | null;
  code: string | null;
  grantor: Grantor | null;
}

export interface GuardDeps {
  store(): SafetyStore;
  policy(): SafetyPolicy | undefined;
  tools: Tools;
  place(seat: SeatRef | null): Place;
  /** its Owner hears of a rule a seat keeps hitting */
  repeated(seat: SeatRef, rule: string, count: number, command: string): void;
}

const DEFAULTS = { budgetMs: 1000, maxBytes: 64 * 1024, codeHours: 24, repeat: { count: 3, minutes: 30 } };
const CHAIN = /[;&|`\n<>]|\$\(/;
const RANK: Record<Mode, number> = { log: 0, warn: 1, ask: 2, deny: 3 };
const RULES_LOOKED_MS = 3000;

export class Guard {
  private projectRules = new Map<string, { mtime: number; at: number; rules: ProjectRules }>();

  constructor(private readonly deps: GuardDeps) {}

  /** One shell command a seat is about to run; `dry` keeps nothing. */
  async check(seat: SeatRef | null, cli: string, command: string, cwd: string | null, dry = false): Promise<Verdict> {
    const started = process.hrtime.bigint();
    const policy = this.deps.policy() ?? {};
    const store = this.deps.store();
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1000;
    const base = { seat: seat?.id ?? null, role: seat?.role ?? null, cli, cwd, command: redact(command) };
    const allowAll = (policy.allow ?? []).find(
      (e) =>
        live(e) &&
        inPaths(e, cwd) &&
        (e.command === command ||
          (e.prefix !== undefined && command.startsWith(e.prefix) && !CHAIN.test(command.slice(e.prefix.length)))),
    );
    if (allowAll) return pass();
    const hash = codeHash(seat?.id ?? null, cwd, command);
    const used = dry ? null : store.consume(hash);
    if (used) {
      store.record({
        ...base,
        verdict: "granted",
        pack: used.pack,
        rule: used.rule,
        severity: null,
        code: used.code,
        elapsedUs: elapsed(),
      });
      return pass();
    }
    const place = this.deps.place(seat);
    const project = this.rulesOf(place.project);
    const packs = packsInForce([...(policy.packs?.add ?? []), ...project.add], policy.packs?.remove ?? []);
    const found = await evaluate(
      command,
      cwd,
      place,
      {
        packs,
        exempt: policy.exempt ?? {},
        budgetMs: policy.budgetMs ?? DEFAULTS.budgetMs,
        maxBytes: policy.maxBytes ?? DEFAULTS.maxBytes,
      },
      this.deps.tools,
    );
    const lifted = (f: Finding) =>
      (policy.allow ?? []).some((e) => live(e) && e.rule === `${f.pack}:${f.rule}` && inPaths(e, cwd));
    const findings = found.findings.filter((f) => !lifted(f));
    return this.conclude(
      seat,
      command,
      cwd,
      findings,
      found.doubts,
      { ...policy, rules: { ...project.rules, ...(policy.rules ?? {}) } },
      base,
      elapsed,
      dry,
    );
  }

  /** A file an editing tool is about to write (Write, Edit, apply_patch, a plugin's write). */
  async checkWrite(seat: SeatRef | null, cli: string, path: string, cwd: string | null): Promise<Verdict> {
    const started = process.hrtime.bigint();
    const policy = this.deps.policy() ?? {};
    const place = this.deps.place(seat);
    const word = {
      raw: path,
      start: 0,
      end: 0,
      parts: [{ kind: "text" as const, text: path, quote: "single" as const }],
    };
    const value = { text: path, prefix: path, quoted: true, glob: false, temp: false, word };
    const found = guardOf(value, "write", { place, cwd });
    const findings: Finding[] = [];
    if (found) {
      const rule = ruleOf(found.pack, found.rule)!;
      findings.push({
        pack: found.pack,
        rule: found.rule,
        severity: rule.severity,
        reason: `${rule.reason} (${found.path})`,
        explanation: rule.explanation,
        safer: rule.safer,
        text: `write ${path}`,
      });
    }
    const command = `write ${path}`;
    const base = { seat: seat?.id ?? null, role: seat?.role ?? null, cli, cwd, command };
    return this.conclude(
      seat,
      command,
      cwd,
      findings,
      [],
      policy,
      base,
      () => Number(process.hrtime.bigint() - started) / 1000,
    );
  }

  private conclude(
    seat: SeatRef | null,
    command: string,
    cwd: string | null,
    findings: Finding[],
    doubts: Doubt[],
    policy: SafetyPolicy,
    base: { seat: string | null; role: string | null; cli: string; cwd: string | null; command: string },
    elapsed: () => number,
    dry = false,
  ): Verdict {
    const store = this.deps.store();
    const ranked = findings
      .map((f) => ({ f, mode: modeOf(f, policy.rules ?? {}) }))
      .sort((a, b) => RANK[b.mode] - RANK[a.mode] || SEVERITY_RANK[b.f.severity] - SEVERITY_RANK[a.f.severity]);
    const top = ranked[0];
    const blocks = ranked.filter((r) => r.mode === "deny" || r.mode === "ask");
    if (!blocks.length && !doubts.length) {
      const verdict = top ? (top.mode === "warn" ? "warn" : "log") : "allow";
      // a command that only passes is no news: what is kept is what a rule said something of
      if (!dry && verdict !== "allow")
        store.record({
          ...base,
          verdict,
          pack: top?.f.pack ?? null,
          rule: top?.f.rule ?? null,
          severity: top?.f.severity ?? null,
          code: null,
          elapsedUs: elapsed(),
        });
      return {
        allow: true,
        message: top?.mode === "warn" ? warning(top.f) : null,
        finding: top?.f ?? null,
        code: null,
        grantor: null,
      };
    }
    const decided = blocks[0]?.f ?? null;
    const grantor: Grantor = blocks.some((b) => ruleOf(b.f.pack, b.f.rule)?.grant === "human") ? "human" : "owner";
    if (dry)
      return {
        allow: false,
        message: blocked(decided, doubts, "(none: a check gives no code)", grantor, command, 0),
        finding: decided,
        code: null,
        grantor,
      };
    const code = store.issue({
      hash: codeHash(seat?.id ?? null, cwd, command),
      seat: seat?.id ?? null,
      cwd,
      shown: redact(command),
      pack: decided?.pack ?? "gate",
      rule: decided?.rule ?? "unverified",
      grantor,
      hours: policy.codeHours ?? DEFAULTS.codeHours,
    });
    store.record({
      ...base,
      verdict: "deny",
      pack: decided?.pack ?? "gate",
      rule: decided?.rule ?? "unverified",
      severity: decided?.severity ?? null,
      code,
      elapsedUs: elapsed(),
    });
    if (seat && decided) {
      const repeat = policy.repeat ?? DEFAULTS.repeat;
      const since = new Date(Date.now() - repeat.minutes * 60_000);
      const count = store.denials(seat.id, decided.rule, since);
      if (count >= repeat.count && store.escalate(seat.id, decided.rule, since))
        this.deps.repeated(seat, `${decided.pack}:${decided.rule}`, count, redact(command));
    }
    return {
      allow: false,
      message: blocked(decided, doubts, code, grantor, command, policy.codeHours ?? DEFAULTS.codeHours),
      finding: decided,
      code,
      grantor,
    };
  }

  /** A project's `.seatwork/safety.json`: turns packs on and raises rules, never loosens. */
  private rulesOf(project: string | null): ProjectRules {
    const none: ProjectRules = { add: [], rules: {} };
    if (!project) return none;
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
    if (mtime < 0) {
      this.projectRules.set(file, { mtime, at: Date.now(), rules: none });
      return none;
    }
    if (cached?.mtime === mtime) {
      cached.at = Date.now();
      return cached.rules;
    }
    let rules = none;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        packs?: { add?: string[] };
        rules?: Record<string, Mode>;
      };
      const raised = Object.fromEntries(
        Object.entries(raw.rules ?? {}).filter(
          ([key, mode]) => RANK[mode] !== undefined && RANK[mode] >= RANK[baseMode(key)],
        ),
      );
      rules = { add: raw.packs?.add ?? [], rules: raised };
    } catch {
      rules = none;
    }
    this.projectRules.set(file, { mtime, at: Date.now(), rules });
    return rules;
  }
}

interface ProjectRules {
  add: string[];
  rules: Record<string, Mode>;
}

const pass = (): Verdict => ({ allow: true, message: null, finding: null, code: null, grantor: null });
const live = (e: AllowEntry) => !e.until || Date.parse(e.until) > Date.now();
const inPaths = (e: AllowEntry, cwd: string | null) =>
  !e.paths?.length || (cwd !== null && e.paths.some((p) => within(cwd, p)));

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
export function modeOf(f: Finding, rules: Record<string, Mode>): Mode {
  const exact = rules[`${f.pack}:${f.rule}`];
  if (exact) return exact;
  const base = baseMode(`${f.pack}:${f.rule}`);
  const broad = rules[`${f.pack}:*`];
  // a pack-wide setting never lowers a critical rule; only the rule's own name can
  if (broad && !(f.severity === "critical" && RANK[broad] < RANK[base])) return broad;
  return base;
}

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

function warning(f: Finding): string {
  return `The room's guard let this run with a note: ${f.reason} (rule ${f.pack}:${f.rule}).${f.explanation ? ` ${f.explanation}` : ""}`;
}
