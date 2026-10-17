import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isObject } from "../../../shared/json";

/** Changes made to a room home's policy, kept across setups. */

type Json = Record<string, unknown>;

/** One key changed since setup; no `value` is a key taken out. */
interface PolicyChange {
  path: string[];
  value?: unknown;
}

/** The keys `now` changed from `shipped`, `$comment` keys aside; an array is one key. */
function changesSince(shipped: Json, now: Json, path: string[] = []): PolicyChange[] {
  const changes: PolicyChange[] = [];
  for (const key of new Set([...Object.keys(shipped), ...Object.keys(now)])) {
    if (key.startsWith("$comment")) continue;
    const at = [...path, key];
    if (isObject(shipped[key]) && isObject(now[key])) changes.push(...changesSince(shipped[key], now[key], at));
    else if (JSON.stringify(shipped[key]) !== JSON.stringify(now[key]))
      changes.push(Object.hasOwn(now, key) ? { path: at, value: now[key] } : { path: at });
  }
  return changes;
}

/** Lays changes over a policy; warns of each one whose place it no longer has. */
export function layOver(policy: Json, changes: PolicyChange[]): string[] {
  const left: string[] = [];
  for (const change of changes) {
    const parent = change.path.slice(0, -1);
    const at = parent.reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), policy);
    if (!isObject(at)) {
      if ("value" in change)
        left.push(
          `policy.json: ${change.path.join(".")} was changed here, and this version has no ${parent.join(".")}; left out`,
        );
      continue;
    }
    const key = change.path.at(-1)!;
    if ("value" in change) at[key] = change.value;
    else delete at[key];
  }
  return left;
}

/** A room home's policy file, parsed; null when there is none. */
function readPolicyFile(file: string): Json | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Json;
  } catch (error) {
    throw new Error(
      `seatwork: ${file} is not JSON (${error instanceof Error ? error.message : String(error)}): fix it, then set the room up again`,
    );
  }
}

/** What was changed in a room home's policy.json since setup wrote policy.shipped.json beside it. */
export function keptChanges(roomHome: string): PolicyChange[] {
  const shipped = readPolicyFile(join(roomHome, "policy.shipped.json"));
  const now = readPolicyFile(join(roomHome, "policy.json"));
  return shipped && now ? changesSince(shipped, now) : [];
}
