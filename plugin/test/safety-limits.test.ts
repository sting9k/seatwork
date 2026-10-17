import { ROOM_HOME, shipSql } from "./support/room";
import { fastestInTurns } from "./support/timing";
import assert from "node:assert/strict";
import { request } from "node:http";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { McpHttpServer } from "../server/mcp-http";
import { answerHook } from "../server/safety/hooks";
import { SafetyStore } from "../server/safety/store";
import { guardAt, machine, PROJECT, SEAT } from "./support/gate";

shipSql();

const redactModule = require("../server/redact") as typeof import("../server/redact");

const { guard, store } = guardAt("limits", machine({ ignored: async () => new Set<string>() }));

const patchOf = (files: number): string =>
  [
    "*** Begin Patch",
    ...Array.from({ length: files }, (_, i) => `*** Add File: src/gen/file${i}.ts\n+x`),
    "*** End Patch",
  ].join("\n");
const applyPatch = (command: string) => ({ tool_name: "apply_patch", tool_input: { command }, cwd: PROJECT });

test("a patch of any number of files runs, the guard reading a fixed number of them", async () => {
  assert.equal((await answerHook(guard, "codex", applyPatch(patchOf(150)), SEAT)).text, "");
  assert.equal((await answerHook(guard, "codex", applyPatch(patchOf(100_000)), SEAT)).text, "");
  const pi = await answerHook(guard, "pi", { tool: "patch", input: { patchText: patchOf(5000) }, cwd: PROJECT }, SEAT);
  assert.equal(pi.text, "");
});

test("what the guard costs for a patch does not grow with the number of files it names", async () => {
  const few = applyPatch(patchOf(1000));
  const many = applyPatch(patchOf(50_000));
  assert.ok(many.tool_input.command.length > 40 * few.tool_input.command.length);
  const [small, large] = await fastestInTurns(
    () => answerHook(guard, "codex", few, SEAT),
    () => answerHook(guard, "codex", many, SEAT),
  );
  // fifty times the files cost the patch read up to the cap, not a check per file
  assert.ok(large / small < 8, `50000 files cost ${(large / small).toFixed(1)} times 1000 files`);
});

test("a patch longer than the guard reads whole, a path longer than a path can be, or a long file runs", async () => {
  const long = applyPatch(`*** Begin Patch\n*** Add File: a.ts\n${"+x\n".repeat(900_000)}*** End Patch`);
  assert.equal((await answerHook(guard, "codex", long, SEAT)).text, "");
  const path = { file_path: `/Users/u/proj/${"a".repeat(10_000)}`, content: "x" };
  assert.equal(
    (await answerHook(guard, "claude", { tool_name: "Write", tool_input: path, cwd: PROJECT }, SEAT)).text,
    "",
  );
  const file = { file_path: `${PROJECT}/a.ts`, content: "x".repeat(3_000_000) };
  assert.equal(
    (await answerHook(guard, "claude", { tool_name: "Write", tool_input: file, cwd: PROJECT }, SEAT)).text,
    "",
  );
});

test("a command too long to read is kept as unread from its start, whatever its length", async () => {
  const lengths: number[] = [];
  const real = redactModule.redact;
  redactModule.redact = (text: string) => (lengths.push(text.length), real(text));
  try {
    const secret = ["sk", "proj", "Abcdefghijklmnopqrstuvwx12"].join("-");
    const long = `echo ${"x ".repeat(1990)}${secret} ${"y".repeat(4_000_000)}`;
    await guard.check(SEAT, "claude", long, PROJECT);
    assert.ok(Math.max(...lengths) <= 4000, `redaction read ${Math.max(...lengths)} characters`);
    const kept = store.kept("", 1)[0];
    assert.equal(`${kept.pack}:${kept.rule}`, "unread:command");
    assert.ok(!kept.command.includes(secret));
    assert.ok(kept.command.length <= 2000);
  } finally {
    redactModule.redact = real;
  }
});

test("the room's server turns away a body past what a real call needs, and reads one just under it", async () => {
  const server = new McpHttpServer("tok", "test", "0");
  const seen: number[] = [];
  server.route("gate", async (body) => (seen.push(body.length), { type: "text/plain", text: "ok" }));
  const port = await server.listen(0);
  const post = (size: number) =>
    new Promise<number>((resolve) => {
      const sent = request({ host: "127.0.0.1", port, path: `/gate/tok`, method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      sent.on("error", () => resolve(0));
      sent.end("x".repeat(size));
    });
  try {
    assert.equal(await post(3_000_000), 200);
    assert.deepEqual(seen, [3_000_000]);
    assert.ok([413, 0].includes(await post(5_000_000)), "a body of 5 MB is refused");
    assert.deepEqual(seen, [3_000_000], "the handler never saw it");
  } finally {
    await server.close();
  }
});

test("a seat nobody has seen for the keep is dropped with the rest of the guard's records; a seat that is active stays", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const kept = new SafetyStore(join(ROOM_HOME, "seats-keep"), 1000, () => new Date(now));
  kept.noteStart("quiet", "/work/a", "aaa");
  kept.noteStart("busy", "/work/b", "bbb");
  kept.noteStart("successor", "/work/c", "ccc");
  now += 2 * 86_400_000;
  assert.equal(kept.seen("busy"), true, "a seat seen a day after it was last seen is noted");
  assert.equal(kept.seen("busy"), false, "and not again the same day");
  assert.equal(kept.seen("nobody"), false);
  kept.inherit("successor", "heir");
  now += 2 * 86_400_000;
  assert.equal(kept.expire(new Date(now - 3 * 86_400_000)), 2, "the two seats not seen for three days go");
  assert.deepEqual(
    ["quiet", "busy", "successor", "heir"].map((id) => kept.startOf(id)?.cwd ?? null),
    [null, "/work/b", null, "/work/c"],
  );
  assert.equal(kept.startOf("busy")?.started_at, "2026-01-01T00:00:00.000Z", "a seat keeps the time it began");
});

test("a store made before seats were seen is brought to the new layout with its seats as they were", () => {
  const dir = join(ROOM_HOME, "seats-migrate");
  const scripts = join(ROOM_HOME, "seats-migrate-scripts");
  rmSync(dir, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
  mkdirSync(scripts, { recursive: true });
  for (const name of ["V1__layout.sql", "V2__council.sql", "V3__drop_findings_by_seen.sql"])
    copyFileSync(join(ROOM_HOME, "room", "sql", "safety", name), join(scripts, name));
  const before = new SafetyStore(dir, 1000, () => new Date("2026-02-01T00:00:00Z"), scripts);
  (before as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare("INSERT INTO seats (agent_id, cwd, start_head, started_at) VALUES ('old', '/work/old', 'abc', ?)")
    .run("2026-02-01T00:00:00.000Z");
  before.close();
  const after = new SafetyStore(dir, 1000, () => new Date("2026-03-01T00:00:00Z"));
  assert.deepEqual(
    { ...after.startOf("old") },
    { cwd: "/work/old", start_head: "abc", started_at: "2026-02-01T00:00:00.000Z" },
  );
  assert.equal(after.expire(new Date("2026-01-15T00:00:00Z")), 0, "a seat is seen from the time it began");
  assert.ok(after.startOf("old"));
  assert.equal(after.expire(new Date("2026-02-15T00:00:00Z")), 1);
});
