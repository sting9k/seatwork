import core from "../../../shared/safety/packs/core.json";
import database from "../../../shared/safety/packs/database.json";
import optional from "../../../shared/safety/packs/optional.json";
import room from "../../../shared/safety/packs/room.json";
import system from "../../../shared/safety/packs/system.json";
import { literal } from "./shell";
import type { Scene, Severity } from "./types";

/** The packs of rules read from shared/safety/packs, and the matcher for their rules. */

interface Match {
  commands: string[];
  first?: string[];
  seq?: string[][];
  flags?: string[];
  noFlags?: string[];
  arg?: string | string[];
  noArg?: string;
  last?: string;
  minArgs?: number;
  dynamicArg?: boolean;
}

export type Mode = "deny" | "ask" | "warn" | "log";

interface Rule {
  severity: Severity;
  reason: string;
  explanation?: string;
  safer?: string[];
  mode?: Mode;
  grant?: "human";
  match?: Match[];
  sql?: string;
  statement?: boolean;
  noWhere?: boolean;
}

interface Pack {
  id: string;
  tier: number;
  always?: boolean;
  default?: boolean;
  safe?: Match[];
  rules: Record<string, Rule>;
}

const PACKS: Pack[] = [core, system, room, optional, database]
  .flatMap((file) => file.packs as unknown as Pack[])
  .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));

const BY_ID = new Map(PACKS.map((p) => [p.id, p]));

export const DB_CLIENTS = database.clients as Record<string, string[]>;

export function packOf(id: string): Pack | undefined {
  return BY_ID.get(id);
}

export function ruleOf(pack: string, rule: string): Rule | undefined {
  return BY_ID.get(pack)?.rules[rule];
}

const inForceCache = new Map<string, ReadonlySet<string>>();

/** The packs in force: always-on, default-on, then the policy's additions and removals. */
export function packsInForce(add: readonly string[] = [], remove: readonly string[] = []): ReadonlySet<string> {
  const key = `${add.join(",")}|${remove.join(",")}`;
  const cached = inForceCache.get(key);
  if (cached) return cached;
  const out = new Set<string>();
  const expand = (id: string) => PACKS.filter((p) => p.id === id || p.id.startsWith(`${id}.`)).map((p) => p.id);
  for (const p of PACKS) if (p.always || p.default) out.add(p.id);
  for (const id of add) for (const found of expand(id)) out.add(found);
  for (const id of remove) for (const found of expand(id)) if (!BY_ID.get(found)?.always) out.delete(found);
  // policies change rarely, so dropping the whole cache past the limit costs nothing
  if (inForceCache.size > 64) inForceCache.clear();
  inForceCache.set(key, out);
  return out;
}

type FlagTest = (texts: readonly (string | null)[]) => boolean;

/** A declared match block made ready once: word sets, compiled patterns, flag tests. */
interface Compiled {
  first?: ReadonlySet<string>;
  seq?: ReadonlySet<string>[];
  flags?: FlagTest[];
  noFlags?: FlagTest[];
  arg?: RegExp[];
  noArg?: RegExp;
  last?: RegExp;
  minArgs?: number;
  dynamicArg?: boolean;
}

function flagTest(flag: string): FlagTest {
  if (flag.startsWith("short:")) {
    const c = flag.slice(6);
    return (texts) => texts.some((t) => t !== null && t.length > 1 && t[0] === "-" && t[1] !== "-" && t.includes(c));
  }
  if (flag.startsWith("long:")) {
    const [, name, min] = flag.split(":");
    const least = Number(min);
    return (texts) =>
      texts.some(
        (t) => t !== null && t.startsWith("--") && t.length - 2 >= least && name.startsWith(t.slice(2).split("=")[0]),
      );
  }
  if (flag.startsWith("--"))
    return (texts) => texts.some((t) => t === flag || (t !== null && t.startsWith(`${flag}=`)));
  return (texts) => texts.includes(flag);
}

function compile(match: Match): Compiled {
  const lower = (list: string[]) => new Set(list.map((s) => s.toLowerCase()));
  return {
    first: match.first && lower(match.first),
    seq: match.seq?.map(lower),
    flags: match.flags?.map(flagTest),
    noFlags: match.noFlags?.map(flagTest),
    arg:
      match.arg === undefined
        ? undefined
        : (Array.isArray(match.arg) ? match.arg : [match.arg]).map((p) => new RegExp(p, "i")),
    noArg: match.noArg === undefined ? undefined : new RegExp(match.noArg, "i"),
    last: match.last === undefined ? undefined : new RegExp(match.last, "i"),
    minArgs: match.minArgs,
    dynamicArg: match.dynamicArg,
  };
}

const COMPILED = new Map<Match, Compiled>();
const compiled = (match: Match): Compiled => {
  let ready = COMPILED.get(match);
  if (!ready) COMPILED.set(match, (ready = compile(match)));
  return ready;
};

const nameMatches = (name: string, wanted: string[]): boolean =>
  wanted.some((w) => (w.endsWith("*") ? name.startsWith(w.slice(0, -1)) : name === w));

/** True when one declared match block holds for the command. */
function matches(match: Match, scene: Pick<Scene, "call">): boolean {
  const name = scene.call.name;
  if (!name || !nameMatches(name, match.commands)) return false;
  const m = compiled(match);
  const words = scene.call.args;
  if (m.minArgs !== undefined && words.length < m.minArgs) return false;
  const texts = words.map(literal);
  if (m.first || m.seq) {
    const lower = texts.map((t) => t?.toLowerCase() ?? null);
    if (m.first) {
      const first = lower.find((t) => t !== null && !t.startsWith("-"));
      if (!first || !m.first.has(first)) return false;
    }
    if (m.seq) {
      let at = 0;
      for (const set of m.seq) {
        while (at < lower.length && !(lower[at] !== null && set.has(lower[at]!))) at += 1;
        if (at >= lower.length) return false;
        at += 1;
      }
    }
  }
  if (m.flags && !m.flags.some((test) => test(texts))) return false;
  if (m.noFlags?.some((test) => test(texts))) return false;
  if (m.arg) for (const test of m.arg) if (!texts.some((t) => t !== null && test.test(t))) return false;
  if (m.noArg && texts.some((t) => t !== null && m.noArg!.test(t))) return false;
  if (m.last) {
    let last: string | null | undefined;
    for (let i = texts.length - 1; i >= 0 && last === undefined; i -= 1)
      if (texts[i] === null || !texts[i]!.startsWith("-")) last = texts[i];
    if (last === undefined || last === null || !m.last.test(last)) return false;
  }
  if (m.dynamicArg && !texts.some((t) => t === null)) return false;
  return true;
}

interface Entry {
  pack: Pack;
  rule: string;
  match: Match;
}

const BY_COMMAND = new Map<string, Entry[]>();
const BY_PREFIX: { prefix: string; entry: Entry }[] = [];
const SAFE_BY_PACK = new Map<string, Match[]>();
for (const pack of PACKS) {
  if (pack.safe) SAFE_BY_PACK.set(pack.id, pack.safe);
  for (const [rule, declared] of Object.entries(pack.rules))
    for (const match of declared.match ?? [])
      for (const command of match.commands) {
        const entry = { pack, rule, match };
        if (command.endsWith("*")) BY_PREFIX.push({ prefix: command.slice(0, -1), entry });
        else BY_COMMAND.set(command, [...(BY_COMMAND.get(command) ?? []), entry]);
      }
}

/** Declared rules of the packs in force that hold for a command, by name or `name*`; a safe block lifts its pack. */
export function declaredHits(
  scene: Pick<Scene, "call">,
  inForce: ReadonlySet<string>,
): { pack: string; rule: string }[] {
  const name = scene.call.name;
  if (!name) return [];
  const entries = [
    ...(BY_COMMAND.get(name) ?? []),
    ...BY_PREFIX.filter((p) => name.startsWith(p.prefix)).map((p) => p.entry),
  ];
  if (!entries.length) return [];
  const out: { pack: string; rule: string }[] = [];
  const lifted = new Map<string, boolean>();
  for (const { pack, rule, match } of entries) {
    if (!inForce.has(pack.id) || out.some((o) => o.pack === pack.id && o.rule === rule)) continue;
    let safe = lifted.get(pack.id);
    if (safe === undefined) lifted.set(pack.id, (safe = !!SAFE_BY_PACK.get(pack.id)?.some((m) => matches(m, scene))));
    if (!safe && matches(match, scene)) out.push({ pack: pack.id, rule });
  }
  return out.sort((a, b) => BY_ID.get(a.pack)!.tier - BY_ID.get(b.pack)!.tier || a.pack.localeCompare(b.pack));
}

export const DECLARED_COMMANDS: ReadonlySet<string> = new Set(BY_COMMAND.keys());
