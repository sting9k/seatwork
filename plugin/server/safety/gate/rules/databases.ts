import { invocationOf } from "../normalize";
import { DB_CLIENTS, packOf } from "../packs";
import { literal, type Pipeline } from "../shell";
import type { Scene } from "../types";

/** The statements a database client is given, against the database packs in force. */

export interface DatabaseHit {
  pack: string;
  rule: string;
}

const INLINE_FLAGS = new Set(["-c", "--command", "-e", "--execute", "--eval"]);

/** The rules of a database pack that a client's statements trip; `stdin` reads what the client is fed, lazily. */
export function databaseHits(
  scene: Scene,
  packs: ReadonlySet<string>,
  stdin: () => string | null | undefined,
): DatabaseHit[] {
  const name = scene.call.name ?? "";
  const pack = Object.entries(DB_CLIENTS).find(([id, clients]) => clients.includes(name) && packs.has(id))?.[0];
  if (!pack) return [];
  const texts = scene.call.args.map(literal);
  const inline: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const t = texts[i];
    if (t === null) continue;
    if (INLINE_FLAGS.has(t) && texts[i + 1] !== undefined) inline.push(texts[++i] ?? "");
    else if (/^--(command|execute|eval)=/.test(t)) inline.push(t.slice(t.indexOf("=") + 1));
    else if (!t.startsWith("-") && (name.startsWith("redis") || name === "sqlite3")) inline.push(t);
  }
  const fed = stdin();
  if (fed === null || texts.some((t) => t === "-f" || t === "--file")) return [{ pack, rule: "stdin-unverified" }];
  const sql = [...inline, fed ?? ""].join("\n");
  if (!sql.trim()) return [];
  const hits: DatabaseHit[] = [];
  for (const [rule, declared] of Object.entries(packOf(pack)?.rules ?? {})) {
    if (declared.noWhere) {
      if (sql.split(";").some((st) => /^\s*UPDATE\b[\s\S]*\bSET\b/i.test(st) && !/\bWHERE\b/i.test(st)))
        hits.push({ pack, rule });
    } else if (declared.sql) {
      const test = new RegExp(declared.statement ? `(^|;)\\s*${declared.sql}` : declared.sql, "i");
      if (test.test(sql)) hits.push({ pack, rule });
    }
  }
  return hits;
}

/** True when a pipeline feeds the keys of a redis scan to a delete. */
export function scanDeletesKeys(pipeline: Pipeline): boolean {
  const calls = pipeline.commands.map((c) => (c.kind === "simple" ? invocationOf(c) : null));
  const scans = calls.some(
    (c) =>
      c &&
      /^(redis|valkey|keydb)-cli$/.test(c.name ?? "") &&
      c.args.some((w) => /^(--scan|keys)$/i.test(literal(w) ?? "")),
  );
  const deletes = calls.some(
    (c) => c?.name === "xargs" && c.args.some((w) => /^(del|unlink)$/i.test(literal(w) ?? "")),
  );
  return scans && deletes;
}
