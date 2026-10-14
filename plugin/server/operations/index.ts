import forkCatalog from "../../shared/forks.json";
import settings from "../../shared/operations.json";
import { notEnglish } from "../english";
import { readJson, writeJson } from "../persisted";
import { hasSecret } from "../redact";
import { districtOf, incidentOf } from "./lines";
import type { Vitals } from "./vitals";
import { OperationsStore, type Incident, type IncidentState, type Trace, type TraceNoteKind, type Tune } from "./store";

/** The Operations district: the room's log and incidents, told to its operator seat, the traces of their causes, and the policy that seat tunes from measurement. */

/** What the district takes from the room: its folder, the live policy and its file, the operators, mail, each district's reading, and the process's vital signs. */
export interface OperationsDeps {
  dir: string;
  busyTimeoutMs: number;
  policy(): Record<string, unknown>;
  persist(path: string, value: unknown): void;
  operators(): string[];
  mail(to: string, subject: string, body: string): Promise<unknown>;
  readings: Record<string, () => unknown>;
  vitals?: Vitals;
  echo(line: string): void;
  now?: () => Date;
}

/** A refusal of an operator's call that it can fix. */
export class OperationsRefused extends Error {
  readonly code = "BAD_REQUEST";
  readonly retryable = false;
}

/** A policy key the operator may tune: its district, its type, and its range. */
interface Tunable {
  district: string;
  type: "integer" | "number" | "boolean" | "forks";
  min?: number;
  max?: number;
}

const TUNABLES = settings.tunables as Record<string, Tunable>;
const FORK_NAMES = Object.keys(forkCatalog.forks);
const NOTE_KINDS: readonly TraceNoteKind[] = ["evidence", "eliminated", "hypothesis"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHOWN = { lines: 50, linesMost: 500, incidents: 20, tunes: 10, untold: 20, reverts: 2 } as const;

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

/** An operator's words, checked: a sentence, English, short enough, no secret. */
function words(what: string, raw: unknown, most = settings.evidenceChars): string {
  const text = String(raw ?? "").trim();
  if (text.length < 10) throw new OperationsRefused(`${what}: say it in a sentence`);
  if (text.length > most) throw new OperationsRefused(`${what}: at most ${most} characters`);
  const foreign = notEnglish(text);
  if (foreign) throw new OperationsRefused(`${what}: in English (${foreign})`);
  if (hasSecret(text)) throw new OperationsRefused(`${what}: it holds a secret`);
  return text;
}

/** A time as a seat reads it, to the minute. */
const minute = (at: string): string => `${at.slice(0, 16).replace("T", " ")} UTC`;

/** An incident as one line of a mail or an answer. */
const incidentLine = (one: Incident): string =>
  `#${one.id} [${one.district}] ${one.line} (${one.count}x, ${one.lastHour} in the last hour, last ${minute(one.lastAt)})` +
  `${one.state === "open" ? "" : `, ${one.state}${one.note ? `: ${one.note}` : ""}`}${one.back ? ", back after it was resolved" : ""}`;

/** A change as one line, with what it undid and the trace it served. */
const tuneLine = (one: Tune): string =>
  `#${one.id} ${minute(one.at)} ${one.path}: ${one.before ?? "unset"} -> ${one.after ?? "unset"}` +
  `${one.reverts ? ` (reverts #${one.reverts})` : ""}${one.trace ? ` (trace #${one.trace})` : ""}; ${one.reason}`;

/** The operations of the room: one per room, held by its timers and its operator's tool. */
export class Operations {
  private readonly store: OperationsStore;
  private readonly readThisTurn = new Map<string, Set<string>>();
  private lastIncidentMail = 0;
  private lastDigest: number;
  private sending = false;

  private readonly readings: Record<string, () => unknown>;

  constructor(private readonly deps: OperationsDeps) {
    this.store = new OperationsStore(deps.dir, deps.busyTimeoutMs, () => this.now());
    const vitals = deps.vitals;
    this.readings = vitals ? { ...deps.readings, host: () => vitals.reading() } : deps.readings;
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

  /** The minute's pass: what is watched is logged, incidents go to the operators at most every few minutes, the digest once a period. */
  async tick(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (const line of this.deps.vitals?.minute() ?? []) this.log(line);
      const operators = this.deps.operators();
      if (operators.length === 0) return;
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
      "The room met these since you were last told. Read the district and its log before you change anything: seatwork_room.",
      ...due.map(incidentLine),
    ].join("\n");
    await this.send(
      operators,
      `INCIDENT: ${due.length} in ${[...new Set(due.map((one) => one.district))].join(", ")}`,
      body,
    );
    this.store.told(due.map((one) => one.id));
  }

  private async send(operators: readonly string[], subject: string, body: string): Promise<void> {
    for (const operator of operators) await this.deps.mail(operator, subject, body);
  }

  /** A district's reading as JSON, or why it could not be read. */
  private readingOf(district: string): string {
    const read = this.readings[district];
    if (!read) return "no reading";
    try {
      return JSON.stringify(read()).slice(0, settings.baselineChars);
    } catch (error) {
      return `could not be read (${(error as Error).message})`;
    }
  }

  /** The day in short: incidents, each district's reading, the changes still standing against their baselines, the open traces. */
  private digest(now: number): string {
    const incidents = this.store.incidents(new Date(now - settings.digestHours * HOUR).toISOString(), SHOWN.incidents);
    const standing = this.store.standing(new Date(now - settings.standingDays * DAY).toISOString());
    const traces = this.store.openTraces();
    return [
      `Incidents: ${incidents.length ? "" : "none"}`,
      ...incidents.map(incidentLine),
      "Readings:",
      ...Object.keys(this.readings).map((name) => `${name}: ${this.readingOf(name)}`),
      `Changes still standing: ${standing.length ? "" : "none"}`,
      ...standing.map(
        (one) =>
          `${tuneLine(one)}\n  then: ${one.baseline}\n  now: ${this.readingOf(TUNABLES[one.path]?.district ?? "")}`,
      ),
      `Open traces: ${traces.length ? traces.map((one) => `#${one.id} ${one.hypothesis}`).join("; ") : "none"}`,
      "Weigh each change against its baseline; revert one that did not help. Tune only what a reading and the log show.",
    ].join("\n");
  }

  /** One call of the operator's tool: a reading, the log, incidents, traces, the policy, or a change to one of them. */
  act(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const action = String(args.do ?? "");
    switch (action) {
      case "tune":
        return this.tune(agent, args);
      case "revert":
        return this.revert(agent, args);
      case "ack":
        return this.settle(args, "acknowledged");
      case "snooze":
        return this.settle(args, "snoozed");
      case "resolve":
        return this.settle(args, "resolved");
      case "trace":
        return this.trace(agent, args);
      case "close":
        return this.closeTrace(args);
      case "traces":
        return { traces: this.store.openTraces().map((one) => this.traceView(one)) };
      case "health":
        return this.health();
      case "policy":
        return this.policy();
      case "incidents": {
        const days = Math.min(Math.max(Number(args.days) || 1, 1), settings.logKeepDays);
        const since = new Date(this.now().getTime() - days * DAY).toISOString();
        return { days, incidents: this.store.incidents(since, SHOWN.incidents).map(incidentLine) };
      }
      case "log": {
        const district = typeof args.district === "string" ? args.district : "";
        if (district) this.noteRead(agent, `log:${district}`);
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
    }
    const read = this.readings[action];
    if (!read)
      throw new OperationsRefused(
        `\`do\` is health, log, incidents, ack, snooze, resolve, trace, traces, close, policy, tune, revert, or a reading: ${Object.keys(this.readings).join(", ")}`,
      );
    this.noteRead(agent, `reading:${action}`);
    return { [action]: read() };
  }

  private noteRead(agent: string, what: string): void {
    const read = this.readThisTurn.get(agent) ?? new Set<string>();
    read.add(what);
    this.readThisTurn.set(agent, read);
  }

  private health(): Record<string, unknown> {
    const incidents = this.store.incidents(new Date(this.now().getTime() - DAY).toISOString(), SHOWN.incidents);
    const byDistrict: Record<string, number> = {};
    for (const one of incidents) byDistrict[one.district] = (byDistrict[one.district] ?? 0) + one.count;
    return {
      incidentsToday: byDistrict,
      newest: incidents.slice(0, 5).map(incidentLine),
      openTraces: this.store.openTraces().map((one) => `#${one.id} ${one.hypothesis}`),
      readings: Object.keys(this.readings),
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

  /** Where an incident stands, set by the operator with its note: acknowledged, snoozed for some hours, or resolved with its cause. */
  private settle(args: Record<string, unknown>, state: IncidentState): Record<string, unknown> {
    const id = Number(args.id);
    const incident = Number.isInteger(id) ? this.store.incident(id) : null;
    if (!incident)
      throw new OperationsRefused(`no incident #${String(args.id)}: seatwork_room do=incidents lists them`);
    const note = words(state === "resolved" ? "note (the cause)" : "note", args.note);
    let until: string | null = null;
    if (state === "snoozed") {
      const hours = Number(args.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > settings.snoozeMostHours)
        throw new OperationsRefused(`hours: more than 0, at most ${settings.snoozeMostHours}`);
      until = new Date(this.now().getTime() + hours * HOUR).toISOString();
    }
    this.store.setState(id, state, note, until);
    return { line: incidentLine(this.store.incident(id)!) };
  }

  /** Opens a trace on an incident with its first hypothesis, or adds what a trace learned. */
  private trace(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    if (args.id === undefined) {
      const incident = args.incident === undefined ? null : Number(args.incident);
      if (incident !== null && !this.store.incident(incident))
        throw new OperationsRefused(`no incident #${String(args.incident)}`);
      return this.traceView(this.store.openTrace(agent, incident, words("hypothesis", args.hypothesis)));
    }
    const trace = this.openTrace(args.id);
    const kind = String(args.kind ?? "") as TraceNoteKind;
    if (!NOTE_KINDS.includes(kind)) throw new OperationsRefused(`kind is ${NOTE_KINDS.join(", ")}`);
    this.store.addNote(trace.id, kind, words("text", args.text));
    return this.traceView(this.store.trace(trace.id)!);
  }

  private closeTrace(args: Record<string, unknown>): Record<string, unknown> {
    const trace = this.openTrace(args.id);
    this.store.closeTrace(trace.id, words("conclusion", args.conclusion));
    return this.traceView(this.store.trace(trace.id)!);
  }

  private openTrace(raw: unknown): Trace {
    const trace = this.store.trace(Number(raw));
    if (!trace) throw new OperationsRefused(`no trace #${String(raw)}: seatwork_room do=traces lists the open ones`);
    if (trace.closedAt) throw new OperationsRefused(`trace #${trace.id} is closed`);
    return trace;
  }

  /** A trace as the operator reads it, with the turn it must take when its changes keep being undone. */
  private traceView(trace: Trace): Record<string, unknown> {
    return {
      id: trace.id,
      incident: trace.incident,
      hypothesis: trace.hypothesis,
      notes: trace.notes.map((one) => `${one.kind}: ${one.text}`),
      undone: trace.undone,
      ...(trace.closedAt ? { closed: trace.conclusion } : {}),
      ...(trace.undone >= settings.undoneMost
        ? {
            next: `${trace.undone} changes made for this trace were undone: the cause is likely in the code or the design. Write Human the trace.`,
          }
        : {}),
    };
  }

  /** The reason and evidence of a change, checked, and what it rests on: the district's reading in this turn, and for a tune its log too. */
  private grounds(
    agent: string,
    district: string,
    args: Record<string, unknown>,
    withLog: boolean,
  ): { reason: string; evidence: string } {
    const read = this.readThisTurn.get(agent);
    if (!read?.has(`reading:${district}`))
      throw new OperationsRefused(`read ${district} in this turn first (seatwork_room do=${district})`);
    if (withLog && !read.has(`log:${district}`))
      throw new OperationsRefused(
        `read the log of ${district} in this turn too (seatwork_room do=log district=${district}): a change rests on a reading and the log`,
      );
    return { reason: words("reason", args.reason), evidence: words("evidence", args.evidence) };
  }

  private apply(path: string, value: unknown): void {
    setAt(this.deps.policy(), path, value);
    this.deps.persist(path, value);
  }

  /** Changes one tunable key, in memory and in the room's policy file, with what it rests on and the district's reading as its baseline. */
  private tune(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const path = String(args.path ?? "");
    const tunable = TUNABLES[path];
    if (!tunable)
      throw new OperationsRefused(
        `${path || "that key"} is not one the room tunes on its own; tunable: ${Object.keys(TUNABLES).join(", ")}`,
      );
    const value = checked(path, tunable, args.value);
    const { reason, evidence } = this.grounds(agent, tunable.district, args, true);
    const trace = args.trace === undefined ? null : this.openTrace(args.trace);
    if (trace && trace.undone >= settings.undoneMost)
      throw new OperationsRefused(
        `${trace.undone} changes made for trace #${trace.id} were undone: write Human the trace instead of another change`,
      );
    // a key whose changes keep being undone needs evidence that answers why they were
    const reverts = this.store.revertsOf(
      path,
      new Date(this.now().getTime() - settings.revertWindowDays * DAY).toISOString(),
    );
    if (reverts.length >= 2 && args.revisit !== true)
      throw new OperationsRefused(
        `${path} was reverted ${reverts.length} times in ${settings.revertWindowDays} days: ${reverts
          .slice(0, SHOWN.reverts)
          .map((one) => `#${one.id} "${one.reason}"`)
          .join("; ")}. Give evidence that answers these, and revisit true.`,
      );
    const before = valueAt(this.deps.policy(), path);
    if (JSON.stringify(before) === JSON.stringify(value))
      throw new OperationsRefused(`${path} is ${JSON.stringify(value)} already`);
    const baseline = this.readingOf(tunable.district);
    this.apply(path, value);
    const kept = this.store.addTune({
      seat: agent,
      path,
      before: before === undefined ? null : JSON.stringify(before),
      after: JSON.stringify(value),
      reason,
      evidence,
      baseline,
      trace: trace?.id ?? null,
      reverts: null,
    });
    return {
      id: kept.id,
      line: `Changed: ${tuneLine(kept)}`,
      baseline,
      next: `Read ${tunable.district} again on a later digest; no better, then seatwork_room do=revert id=${kept.id}.`,
    };
  }

  /** Puts a key back as it was before a change, when nothing changed it since. */
  private revert(agent: string, args: Record<string, unknown>): Record<string, unknown> {
    const change = this.store.tune(Number(args.id));
    if (!change) throw new OperationsRefused(`no change #${String(args.id)}`);
    const tunable = TUNABLES[change.path];
    if (!tunable) throw new OperationsRefused(`${change.path} is no longer tunable`);
    const { reason, evidence } = this.grounds(agent, tunable.district, args, false);
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
      baseline: this.readingOf(tunable.district),
      trace: change.trace,
      reverts: change.id,
    });
    return { id: kept.id, line: `Reverted: ${tuneLine(kept)}` };
  }

  /** Drops log lines, incidents and closed traces past their keep; the GC calls it. */
  expire(): number {
    const now = this.now().getTime();
    return this.store.expire(
      new Date(now - settings.logKeepDays * DAY),
      settings.logMost,
      new Date(now - settings.traceKeepDays * DAY),
    );
  }

  /** An operator that is gone reads nothing more. */
  forget(agent: string): void {
    this.readThisTurn.delete(agent);
  }

  close(): void {
    this.deps.vitals?.close();
    this.store.close();
  }
}
