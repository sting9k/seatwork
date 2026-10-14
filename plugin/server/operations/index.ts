import forkCatalog from "../../shared/forks.json";
import settings from "../../shared/operations.json";
import { notEnglish } from "../english";
import { readJson, writeJson } from "../persisted";
import { hasSecret } from "../redact";
import { districtOf, incidentOf } from "./lines";
import { OperationsStore, type Incident, type Tune } from "./store";

/** The Operations district: the room's log and incidents, told to its operator seat, and the policy that seat tunes from measurement. */

export interface OperationsDeps {
  dir: string;
  busyTimeoutMs: number;
  policy(): Record<string, unknown>;
  persist(path: string, value: unknown): void;
  operators(): string[];
  mail(to: string, subject: string, body: string): Promise<unknown>;
  readings: Record<string, () => unknown>;
  echo(line: string): void;
  now?: () => Date;
}

/** A refusal of an operator's call that it can fix. */
export class OperationsRefused extends Error {
  readonly code = "BAD_REQUEST";
  readonly retryable = false;
}

interface Tunable {
  district: string;
  type: "integer" | "number" | "boolean" | "forks";
  min?: number;
  max?: number;
}

const TUNABLES = settings.tunables as Record<string, Tunable>;
const FORK_NAMES = Object.keys(forkCatalog.forks);
const HOUR = 3_600_000;
const SHOWN = { lines: 50, linesMost: 500, incidents: 20, tunes: 10, untold: 20 } as const;

/** The value at a dotted path of an object; undefined when a step is missing. */
function valueAt(root: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (at, key) => (at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined),
      root,
    );
}

/** Sets the value at a dotted path, making the objects on the way; undefined removes the key. */
function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let at = root;
  for (const key of keys.slice(0, -1)) {
    if (!at[key] || typeof at[key] !== "object") at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  if (value === undefined) delete at[keys.at(-1)!];
  else at[keys.at(-1)!] = value;
}

/** Writes one key of a policy file, keeping the rest as it is; undefined removes the key. */
export function writePolicyKey(file: string, path: string, value: unknown): void {
  const policy = readJson<Record<string, unknown>>(file, {});
  setAt(policy, path, value);
  writeJson(file, policy, 0o600);
}

/** A value an operator gave for a key, checked against the key's type and range. */
function checked(path: string, tunable: Tunable, raw: unknown): unknown {
  if (tunable.type === "boolean") {
    if (typeof raw !== "boolean") throw new OperationsRefused(`${path} is true or false`);
    return raw;
  }
  if (tunable.type === "forks") {
    const names = Array.isArray(raw) ? raw.map(String) : null;
    const unknown = names?.find((name) => !FORK_NAMES.includes(name));
    if (!names || unknown !== undefined)
      throw new OperationsRefused(`${path} is a list of forks among ${FORK_NAMES.join(", ")}`);
    return [...new Set(names)];
  }
  const n = typeof raw === "number" ? raw : Number.NaN;
  const whole = tunable.type === "integer" ? Number.isInteger(n) : Number.isFinite(n);
  if (!whole || n < (tunable.min ?? -Infinity) || n > (tunable.max ?? Infinity))
    throw new OperationsRefused(
      `${path} is ${tunable.type === "integer" ? "a whole number" : "a number"} from ${tunable.min} to ${tunable.max}`,
    );
  return n;
}

/** Why an operator's words cannot be kept, or null: present, English, short enough, no secret. */
function wordsFault(what: string, text: string, most: number): string | null {
  if (text.length < 10) return `${what}: say it in a sentence`;
  if (text.length > most) return `${what}: at most ${most} characters`;
  const foreign = notEnglish(text);
  if (foreign) return `${what}: in English (${foreign})`;
  return hasSecret(text) ? `${what}: it holds a secret` : null;
}

/** An incident as one line of a mail or an answer. */
const incidentLine = (one: Incident): string =>
  `- [${one.district}] ${one.line} (${one.count}x, last ${one.lastAt.slice(0, 16).replace("T", " ")} UTC)`;

/** A change as one line, with what it undid. */
const tuneLine = (one: Tune): string =>
  `#${one.id} ${one.at.slice(0, 16).replace("T", " ")} ${one.path}: ${one.before ?? "unset"} -> ${one.after ?? "unset"}${one.reverts ? ` (reverts #${one.reverts})` : ""}; ${one.reason}`;

export class Operations {
  private readonly store: OperationsStore;
  private readonly readThisTurn = new Map<string, Set<string>>();
  private lastIncidentMail = 0;
  private lastDigest: number;
  private sending = false;

  constructor(private readonly deps: OperationsDeps) {
    this.store = new OperationsStore(deps.dir, deps.busyTimeoutMs, () => this.now());
    // a room that starts again sends its first digest a full period later, never at once
    this.lastDigest = this.now().getTime();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One line of the room's log: echoed to the app's log, kept, and counted when it reports trouble. */
  log(line: string): void {
    this.deps.echo(line);
    const kept = line.slice(0, settings.lineChars);
    try {
      this.store.record(districtOf(kept), kept, incidentOf(kept));
    } catch (error) {
      // a store that cannot keep the line must not log about itself again
      this.deps.echo(`operations: a log line was not kept: ${(error as Error).message}`);
    }
  }

  /** A turn of an operator began: what it reads from now on is what its changes may rest on. */
  turnStarted(agent: string): void {
    this.readThisTurn.delete(agent);
  }

  /** The minute's pass: incidents not yet told go to the operators at most every few minutes, the digest once a period. */
  async tick(): Promise<void> {
    if (this.sending) return;
    const operators = this.deps.operators();
    if (operators.length === 0) return;
    this.sending = true;
    try {
      const now = this.now().getTime();
      if (now - this.lastIncidentMail >= settings.incidentMinutes * 60_000) await this.tellIncidents(operators, now);
      if (now - this.lastDigest >= settings.digestHours * HOUR) {
        this.lastDigest = now;
        await this.send(operators, "DIGEST: the room in the last day", this.digest(now));
      }
    } catch (error) {
      this.deps.echo(`operations: the operators were not told: ${(error as Error).message}`);
    } finally {
      this.sending = false;
    }
  }

  private async tellIncidents(operators: readonly string[], now: number): Promise<void> {
    const due = this.store.untold(new Date(now - settings.retellHours * HOUR).toISOString(), SHOWN.untold);
    if (due.length === 0) return;
    this.lastIncidentMail = now;
    const body = [
      "The room met these since you were last told. Read the district before you change anything: seatwork_room.",
      ...due.map(incidentLine),
    ].join("\n");
    await this.send(
      operators,
      `INCIDENT: ${due.length} in ${[...new Set(due.map((one) => one.district))].join(", ")}`,
      body,
    );
    this.store.told(due.map((one) => one.key));
  }

  private async send(operators: readonly string[], subject: string, body: string): Promise<void> {
    for (const operator of operators) await this.deps.mail(operator, subject, body);
  }

  /** The day in short: incidents by district, and each district's reading. */
  private digest(now: number): string {
    const since = new Date(now - settings.digestHours * HOUR).toISOString();
    const incidents = this.store.incidents(since, SHOWN.incidents);
    const readings = Object.entries(this.deps.readings).map(([name, read]) => {
      try {
        return `${name}: ${JSON.stringify(read())}`;
      } catch (error) {
        return `${name}: could not be read (${(error as Error).message})`;
      }
    });
    return [
      `Incidents: ${incidents.length ? "" : "none"}`,
      ...incidents.map(incidentLine),
      "Readings:",
      ...readings,
      "Tune only what a reading or the log shows; say what you measured.",
    ].join("\n");
  }

  /** One call of the operator's tool: a reading, the log, the incidents, the policy, or a change to it. */
  act(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const action = String(args.do ?? "");
    const readings = Object.keys(this.deps.readings);
    if (action === "tune") return this.tune(agent, args);
    if (action === "revert") return this.revert(agent, args);
    if (action === "health") return this.health();
    if (action === "policy") return this.policy();
    if (action === "incidents") {
      const days = Math.min(Math.max(Number(args.days) || 1, 1), settings.logKeepDays);
      const since = new Date(this.now().getTime() - days * 24 * HOUR).toISOString();
      return { days, incidents: this.store.incidents(since, SHOWN.incidents).map(incidentLine) };
    }
    if (action === "log") {
      const district = typeof args.district === "string" ? args.district : "";
      if (district) this.noteRead(agent, district);
      const limit = Math.min(Math.max(Number(args.limit) || SHOWN.lines, 1), SHOWN.linesMost);
      return {
        lines: this.store.lines(
          {
            district,
            since: typeof args.since === "string" ? args.since : "",
            words: typeof args.q === "string" ? args.q : "",
          },
          limit,
        ),
      };
    }
    const read = this.deps.readings[action];
    if (!read)
      throw new OperationsRefused(
        `\`do\` is health, log, incidents, policy, tune, revert, or a reading: ${readings.join(", ")}`,
      );
    this.noteRead(agent, action);
    return { [action]: read() };
  }

  private noteRead(agent: string, district: string): void {
    const read = this.readThisTurn.get(agent) ?? new Set<string>();
    read.add(district);
    this.readThisTurn.set(agent, read);
  }

  private health(): Record<string, unknown> {
    const since = new Date(this.now().getTime() - 24 * HOUR).toISOString();
    const incidents = this.store.incidents(since, SHOWN.incidents);
    const byDistrict: Record<string, number> = {};
    for (const one of incidents) byDistrict[one.district] = (byDistrict[one.district] ?? 0) + one.count;
    return {
      incidentsToday: byDistrict,
      newest: incidents.slice(0, 5).map(incidentLine),
      readings: Object.keys(this.deps.readings),
    };
  }

  private policy(): Record<string, unknown> {
    const policy = this.deps.policy();
    return {
      tunable: Object.fromEntries(
        Object.entries(TUNABLES).map(([path, tunable]) => [path, { value: valueAt(policy, path) ?? null, ...tunable }]),
      ),
      changes: this.store.tunes(SHOWN.tunes).map(tuneLine),
    };
  }

  /** The reason and evidence of a change, checked, and the district read in this turn that it rests on. */
  private grounds(
    agent: string,
    district: string,
    args: Record<string, unknown>,
  ): { reason: string; evidence: string } {
    if (!this.readThisTurn.get(agent)?.has(district))
      throw new OperationsRefused(
        `read ${district} in this turn first (seatwork_room do=${district}, or do=log with district ${district}): a change rests on what you measured`,
      );
    const reason = String(args.reason ?? "").trim();
    const evidence = String(args.evidence ?? "").trim();
    const fault =
      wordsFault("reason", reason, settings.evidenceChars) ?? wordsFault("evidence", evidence, settings.evidenceChars);
    if (fault) throw new OperationsRefused(fault);
    return { reason, evidence };
  }

  private apply(path: string, value: unknown): void {
    setAt(this.deps.policy(), path, value);
    this.deps.persist(path, value);
  }

  /** Changes one tunable key, in memory and in the room's policy file, and keeps the change with what it rests on. */
  private tune(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const path = String(args.path ?? "");
    const tunable = TUNABLES[path];
    if (!tunable)
      throw new OperationsRefused(
        `${path || "that key"} is not one the room tunes on its own; tunable: ${Object.keys(TUNABLES).join(", ")}`,
      );
    const value = checked(path, tunable, args.value);
    const { reason, evidence } = this.grounds(agent, tunable.district, args);
    const before = valueAt(this.deps.policy(), path);
    if (JSON.stringify(before) === JSON.stringify(value))
      throw new OperationsRefused(`${path} is ${JSON.stringify(value)} already`);
    this.apply(path, value);
    const kept = this.store.addTune({
      seat: agent,
      path,
      before: before === undefined ? null : JSON.stringify(before),
      after: JSON.stringify(value),
      reason,
      evidence,
      reverts: null,
    });
    return { id: kept.id, line: `Changed: ${tuneLine(kept)}`, undo: `seatwork_room do=revert id=${kept.id}` };
  }

  /** Puts a key back as it was before a change, when nothing changed it since. */
  private revert(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const change = this.store.tune(Number(args.id));
    if (!change) throw new OperationsRefused(`no change #${String(args.id)}`);
    const tunable = TUNABLES[change.path];
    if (!tunable) throw new OperationsRefused(`${change.path} is no longer tunable`);
    const { reason, evidence } = this.grounds(agent, tunable.district, args);
    const now = valueAt(this.deps.policy(), change.path);
    if (JSON.stringify(now ?? null) !== (change.after ?? "null"))
      throw new OperationsRefused(`${change.path} changed again after #${change.id}: revert the later change first`);
    const back = change.before === null ? undefined : (JSON.parse(change.before) as unknown);
    this.apply(change.path, back);
    const kept = this.store.addTune({
      seat: agent,
      path: change.path,
      before: change.after,
      after: change.before,
      reason,
      evidence,
      reverts: change.id,
    });
    return { id: kept.id, line: `Reverted: ${tuneLine(kept)}` };
  }

  /** Drops log lines and incidents past their keep; the GC calls it. */
  expire(): number {
    return this.store.expire(new Date(this.now().getTime() - settings.logKeepDays * 24 * HOUR), settings.logMost);
  }

  /** An operator that is gone reads nothing more. */
  forget(agent: string): void {
    this.readThisTurn.delete(agent);
  }

  close(): void {
    this.store.close();
  }
}
