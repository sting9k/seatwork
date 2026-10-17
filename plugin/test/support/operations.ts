import { rmSync } from "node:fs";
import { join } from "node:path";
import { Operations } from "../../server/operations/index";
import { ROOM_HOME } from "./room";

/** The operations district for the tests: a folder of its own, a clock they move, and what it persists, mails and echoes, kept to be read. */

type Deps = ConstructorParameters<typeof Operations>[0];

/** A log line the knowledge district writes when its store is locked, for the turn `n`. */
export const LOCKED = (n: number) =>
  `knowledge: the turn ${n}f2504e0-4f89-11d3-9a0c-0305e82c3301:t${n} was not kept: database is locked`;

export const DOWN = "mail: delivery to some-seat failed: socket hang up";

/** A mail the district sent. */
export interface Mailed {
  to: string;
  subject: string;
  body: string;
  quiet?: boolean;
  key?: string;
}

/** An operations district on `policy` over a fresh folder of the room home, or over `dir` as it stands, its clock starting at `start`; `deps` sets any other part. */
export function operationsAt(
  name: string,
  options: { start: string; policy: Record<string, unknown>; dir?: string; operators?: string[]; deps?: Partial<Deps> },
) {
  const dir = options.dir ?? join(ROOM_HOME, name);
  if (!options.dir) rmSync(dir, { recursive: true, force: true });
  const clock = { now: new Date(options.start) };
  const persisted: [string, unknown][] = [];
  const mailed: Mailed[] = [];
  const echoed: string[] = [];
  const ops = new Operations({
    dir,
    busyTimeoutMs: 1000,
    policy: () => options.policy,
    persist: (path, value) => persisted.push([path, value]),
    operators: () => options.operators ?? ["hq-1"],
    mail: async (to, subject, body, more) => void mailed.push({ to, subject, body, ...more }),
    readings: {},
    echo: (line) => echoed.push(line),
    now: () => clock.now,
    ...options.deps,
  });
  const at = (iso: string) => (clock.now = new Date(iso));
  return { ops, dir, policy: options.policy, persisted, mailed, echoed, at };
}
