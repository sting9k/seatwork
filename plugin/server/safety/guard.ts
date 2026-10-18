import { evaluate, type Evaluation, type GateConfig, type Tools } from "./gate/evaluate";
import { effectFinding, namedFinding, worse } from "./gate/findings";
import { valueOf } from "./gate/paths";
import { throughLinks, whereOf, whereOfPath } from "./gate/places";
import { ATTRIBUTES_FILE, namesDriver } from "./gate/rules/attributes";
import { secretAt } from "./gate/rules/secrets";
import { textWord } from "./gate/shell";
import { SEVERITY_RANK, type Finding, type Place } from "./gate/types";
import { redact } from "../redact";
import type { SafetyStore } from "./store";
import type { CouncilPolicy } from "./council/council";

/** The command guard: reads each call of a seat and keeps what it did that the owner would want to see; it stops nothing. */

/** The owner's safety settings, as the policy file holds them. */
export interface SafetyPolicy {
  mode?: "on" | "off";
  budgetMs?: number;
  maxBytes?: number;
  handin?: { mode: "block" | "warn" | "off" };
  acceptance?: { mode: "block" | "warn" | "off" };
  done?: { mode: "block" | "warn" | "off" };
  push?: { mode: "warn" | "off" };
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

/** Reads each shell command, file write and file read of a seat, and keeps the calls that did something it grades. */
export class Guard {
  constructor(private readonly deps: GuardDeps) {}

  /** One shell command a seat is about to run; true when the line writes or removes a file of the seat's tree. */
  async check(seat: SeatRef | null, cli: string, command: string, cwd: string | null): Promise<boolean> {
    return this.read({ seat, cli, command, cwd, began: process.hrtime.bigint() }, async (place) =>
      evaluate(command, cwd, place, this.gateConfig(), this.deps.tools(seat)),
    );
  }

  /** A file an editing tool is about to write (Write, Edit, apply_patch, a plugin's write), with the text it adds when the call shows it. */
  async checkWrite(seat: SeatRef | null, cli: string, path: string, cwd: string | null, text?: string): Promise<void> {
    const call = { seat, cli, command: `write ${path}`, cwd, began: process.hrtime.bigint() };
    await this.read(call, async (place) => ({
      findings: writeFindings(path, text, place, cwd, this.deps.tools(seat)),
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
      const paths = [path, real(path)].filter((at): at is string => at !== null);
      const where = paths.some((at) => secretAt(at, secrets, whole))
        ? "room"
        : paths.some((at) => at.startsWith("/") && whereOfPath(at, place) === "credentials")
          ? "credentials"
          : null;
      const found = effectFinding("read", where, `read ${path}`);
      return { findings: found ? [found] : [], doubts: [], changes: false };
    });
  }

  /** The gate's settings, as the policy sets them. */
  gateConfig(): GateConfig {
    const policy = this.deps.policy() ?? {};
    return {
      budgetMs: policy.budgetMs ?? DEFAULTS.budgetMs,
      maxBytes: policy.maxBytes ?? DEFAULTS.maxBytes,
    };
  }

  /** Reads a call and keeps the gravest thing it did, or that the gate could not read it; true when the call writes the seat's tree. */
  private async read(call: Call, look: (place: Place) => Promise<Evaluation>): Promise<boolean> {
    const found = await look(this.deps.place(call.seat));
    const top = [...found.findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0] ?? null;
    if (top) this.record(call, top.effect, top.rule, top.severity);
    else if (found.doubts.length) this.record(call, "unread", "command", null);
    return found.changes;
  }

  /** Keeps a call, under its effect and rule. */
  private record(call: Call, effect: string, rule: string, severity: string | null): void {
    const { seat } = call;
    this.deps.store().record({
      seat: seat?.id ?? null,
      role: seat?.role ?? null,
      cli: call.cli,
      cwd: call.cwd,
      command: shownOf(call.command),
      pack: effect,
      rule,
      severity,
      elapsedUs: Number(process.hrtime.bigint() - call.began) / 1000,
    });
  }
}

/** What writing one path does, straight or through a link, and the text the call adds to an attributes file; a new file outside the seat's tree takes nothing from the owner. */
function writeFindings(
  path: string,
  text: string | undefined,
  place: Place,
  cwd: string | null,
  tools: Tools,
): Finding[] {
  const value = valueOf(textWord(path, "single"), { vars: new Map(), place, cwd });
  let where = whereOf(value, { vars: new Map(), place, cwd });
  const real = path.startsWith("/") ? throughLinks(path, (at) => tools.real(at)) : null;
  if (real) where = worse("overwrite", where, whereOfPath(real, place));
  const file = path.startsWith("/") ? tools.stat(path) : null;
  if (where === "outside" && file && !file.exists) where = null;
  const found = [effectFinding("overwrite", where, `write ${path}`)];
  if (text !== undefined && ATTRIBUTES_FILE.test(path) && namesDriver(text))
    found.push(namedFinding("room:attributes-driver", `write ${path}`));
  return found.filter((f): f is Finding => f !== null);
}

/** A command as the room keeps and shows it: its start, cut between words so no secret is cut in half, with secrets hidden. */
function shownOf(command: string): string {
  if (command.length <= SHOWN_CHARS) return redact(command);
  const start = command.slice(0, SHOWN_CHARS);
  const space = start.search(/\s\S*$/);
  return redact(space > SHOWN_CHARS / 2 ? start.slice(0, space) : start);
}
