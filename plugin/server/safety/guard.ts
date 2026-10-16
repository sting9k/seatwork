import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { evaluate, type Evaluation, type GateConfig, type Tools } from "./gate/evaluate";
import { packsInForce, ruleOf } from "./gate/packs";
import { ATTRIBUTES_FILE, namesDriver } from "./gate/rules/attributes";
import { guardThroughLinks } from "./gate/rules/files";
import { guardOf } from "./gate/rules/protected";
import { secretAt } from "./gate/rules/secrets";
import { textWord } from "./gate/shell";
import { SEVERITY_RANK, type Finding, type Place } from "./gate/types";
import { redact } from "../redact";
import type { SafetyStore } from "./store";
import type { CouncilPolicy } from "./council/council";

/** The command guard: reads each call of a seat by the packs in force and keeps what a rule held for; it stops nothing. */

/** The owner's settings for the guard, the council and the hand-in check, as the policy file holds them. */
export interface SafetyPolicy {
  mode?: "on" | "off";
  packs?: { add?: string[]; remove?: string[] };
  budgetMs?: number;
  maxBytes?: number;
  handin?: { mode: "block" | "warn" | "off"; registry?: boolean };
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

/** What the guard needs of the room. */
interface GuardDeps {
  store(): SafetyStore;
  policy(): SafetyPolicy | undefined;
  tools(seat: SeatRef | null): Tools;
  place(seat: SeatRef | null): Place;
}

/** One call being read: who asks, what, where, and when the guard began on it. */
interface Call {
  seat: SeatRef | null;
  cli: string;
  command: string;
  cwd: string | null;
  began: bigint;
}

const DEFAULTS = { budgetMs: 1000, maxBytes: 64 * 1024 };
const SHOWN_CHARS = 4000;
const PACKS_LOOKED_MS = 3000;

/** Reads each shell command, file write and file read of a seat by the packs in force, and keeps the calls a rule held for. */
export class Guard {
  private projectPacks = new Map<string, { mtime: number; at: number; add: string[] }>();

  constructor(private readonly deps: GuardDeps) {}

  /** One shell command a seat is about to run; true when the line writes or removes a file of the seat's tree. */
  async check(seat: SeatRef | null, cli: string, command: string, cwd: string | null): Promise<boolean> {
    return this.read({ seat, cli, command, cwd, began: process.hrtime.bigint() }, async (place) =>
      evaluate(command, cwd, place, this.gateConfig(place), this.deps.tools(seat)),
    );
  }

  /** A file an editing tool is about to write (Write, Edit, apply_patch, a plugin's write), with the text it adds when the call shows it. */
  async checkWrite(seat: SeatRef | null, cli: string, path: string, cwd: string | null, text?: string): Promise<void> {
    const call = { seat, cli, command: `write ${path}`, cwd, began: process.hrtime.bigint() };
    const real = (target: string) => this.deps.tools(seat).real(target);
    await this.read(call, async (place) => ({
      findings: writeFindings(path, text, place, cwd, real),
      doubts: [],
      changes: false,
    }));
  }

  /** A file or folder a reading tool is about to open (Pi's and OpenCode's read, grep, find, list); `whole` when it reads every file under a folder. */
  async checkRead(seat: SeatRef | null, cli: string, path: string, cwd: string | null, whole: boolean): Promise<void> {
    const call = { seat, cli, command: `read ${path}`, cwd, began: process.hrtime.bigint() };
    const real = (target: string) => this.deps.tools(seat).real(target);
    await this.read(call, async (place) => {
      const secrets = place.guard?.secrets ?? [];
      const found = [path, real(path)].some((at) => at !== null && secretAt(at, secrets, whole));
      return {
        findings: found ? [findingOf("room.guard", "secret-read", `read ${path}`)] : [],
        doubts: [],
        changes: false,
      };
    });
  }

  /** The gate's settings at a place: the policy's, with the packs the place's project adds. */
  gateConfig(place: Place): GateConfig {
    const policy = this.deps.policy() ?? {};
    return {
      packs: packsInForce([...(policy.packs?.add ?? []), ...this.packsOf(place.project)], policy.packs?.remove ?? []),
      budgetMs: policy.budgetMs ?? DEFAULTS.budgetMs,
      maxBytes: policy.maxBytes ?? DEFAULTS.maxBytes,
    };
  }

  /** Reads a call and keeps the gravest rule that held for it, or that the gate could not read it; true when the call writes the seat's tree. */
  private async read(call: Call, look: (place: Place) => Promise<Evaluation>): Promise<boolean> {
    const found = await look(this.deps.place(call.seat));
    const top = [...found.findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0] ?? null;
    // a call no rule holds for is no news: what is kept is what a rule said something of
    if (top) this.record(call, top.pack, top.rule, top.severity);
    else if (found.doubts.length) this.record(call, "gate", "unverified", null);
    return found.changes;
  }

  /** The packs a project's `.seatwork/safety.json` turns on; the file is looked at again every few seconds, not on every call. */
  private packsOf(project: string | null): string[] {
    if (!project) return [];
    const file = join(project, ".seatwork", "safety.json");
    const cached = this.projectPacks.get(file);
    if (cached && Date.now() - cached.at < PACKS_LOOKED_MS) return cached.add;
    let mtime = -1;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      // no file turns no pack on
    }
    if (cached && cached.mtime === mtime) {
      cached.at = Date.now();
      return cached.add;
    }
    const add = mtime < 0 ? [] : readPacks(file);
    this.projectPacks.set(file, { mtime, at: Date.now(), add });
    return add;
  }

  /** Keeps a call a rule held for. */
  private record(call: Call, pack: string, rule: string, severity: string | null): void {
    const { seat } = call;
    this.deps.store().record({
      seat: seat?.id ?? null,
      role: seat?.role ?? null,
      cli: call.cli,
      cwd: call.cwd,
      command: shownOf(call.command),
      pack,
      rule,
      severity,
      elapsedUs: Number(process.hrtime.bigint() - call.began) / 1000,
    });
  }
}

/** The packs a project file turns on; an unreadable file turns none on. */
function readPacks(file: string): string[] {
  try {
    const add = (JSON.parse(readFileSync(file, "utf8")) as { packs?: { add?: unknown } }).packs?.add;
    return Array.isArray(add) ? add.filter((pack): pack is string => typeof pack === "string") : [];
  } catch {
    return [];
  }
}

/** What the rules say of writing one path, straight or through a link, and of the text the call adds to an attributes file. */
function writeFindings(
  path: string,
  text: string | undefined,
  place: Place,
  cwd: string | null,
  real: (path: string) => string | null,
): Finding[] {
  const word = textWord(path, "single");
  const found =
    guardOf({ text: path, prefix: path, quoted: true, glob: false, temp: false, word }, "write", { place, cwd }) ??
    (path.startsWith("/") ? guardThroughLinks(path, "write", { place }, real) : null);
  const hits: { pack: string; rule: string }[] = found ? [{ pack: found.pack, rule: found.rule }] : [];
  if (text !== undefined && ATTRIBUTES_FILE.test(path) && namesDriver(text))
    hits.push({ pack: "room.guard", rule: "git-attributes-driver" });
  return hits.map((hit) => findingOf(hit.pack, hit.rule, `write ${path}`));
}

/** A finding of a pack's rule, as a file tool's call meets it. */
function findingOf(pack: string, name: string, text: string): Finding {
  const rule = ruleOf(pack, name)!;
  return { pack, rule: name, severity: rule.severity, reason: rule.reason, text };
}

/** A command as the room keeps and shows it: its start, cut between words so no secret is cut in half, with secrets hidden. */
function shownOf(command: string): string {
  if (command.length <= SHOWN_CHARS) return redact(command);
  const start = command.slice(0, SHOWN_CHARS);
  const space = start.search(/\s\S*$/);
  return redact(space > SHOWN_CHARS / 2 ? start.slice(0, space) : start);
}
