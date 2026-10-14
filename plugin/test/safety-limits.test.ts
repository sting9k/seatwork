import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { request } from "node:http";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { McpHttpServer } from "../server/mcp-http";
import { Guard } from "../server/safety/guard";
import { answerHook } from "../server/safety/hooks";
import { SafetyStore } from "../server/safety/store";

shipSql();

const redactModule = require("../server/redact") as typeof import("../server/redact");

const PROJECT = "/Users/u/proj";
const place = { home: "/Users/u", project: PROJECT, tmp: null, start: PROJECT, guard: null, roomFolder: ".seatwork" };
const tools = {
  ignored: async () => new Set<string>(),
  exempt: () => false,
  alias: async () => null,
  external: async () => false,
  rebasing: async () => false,
  stat: () => ({ exists: false, link: false, dir: false }),
  changed: async () => null,
};
const store = new SafetyStore(join(ROOM_HOME, "limits"), 1000);
const guard = new Guard({
  store: () => store,
  policy: () => ({}),
  tools: () => tools,
  place: () => place,
  repeated: () => {},
});
const seat = { id: "peer", role: "peer", project: PROJECT, tmp: null, start: PROJECT };

const patchOf = (files: number): string =>
  [
    "*** Begin Patch",
    ...Array.from({ length: files }, (_, i) => `*** Add File: src/gen/file${i}.ts\n+x`),
    "*** End Patch",
  ].join("\n");
const applyPatch = (command: string) => ({ tool_name: "apply_patch", tool_input: { command }, cwd: PROJECT });

/** Fastest of several runs of a call, in nanoseconds. */
async function fastest(call: () => Promise<unknown>, runs = 7): Promise<number> {
  await call();
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    await call();
    times.push(Number(process.hrtime.bigint() - started));
  }
  return Math.min(...times);
}

test("a patch is checked for at most a fixed number of files, however many it names; a larger one does not run", async () => {
  const small = await answerHook(guard, "codex", applyPatch(patchOf(150)), seat);
  assert.equal(small.text, "", "a patch of ordinary size is let through");
  const big = await answerHook(guard, "codex", applyPatch(patchOf(100_000)), seat);
  assert.match(big.text, /"permissionDecision":"deny"/);
  assert.match(big.text, /at most \d+ files/);
  const pi = await answerHook(guard, "pi", { tool: "patch", input: { patchText: patchOf(5000) }, cwd: PROJECT }, seat);
  assert.match(pi.text, /"block":true/);
  assert.match(pi.text, /at most \d+ files/);
});

test("what the guard costs for a patch does not grow with the number of files it names", async () => {
  const few = applyPatch(patchOf(1000));
  const many = applyPatch(patchOf(50_000));
  assert.ok(many.tool_input.command.length > 40 * few.tool_input.command.length);
  const [small, large] = [
    await fastest(() => answerHook(guard, "codex", few, seat)),
    await fastest(() => answerHook(guard, "codex", many, seat)),
  ];
  // fifty times the files cost the patch read up to the cap, not a check per file
  assert.ok(large / small < 8, `50000 files cost ${(large / small).toFixed(1)} times 1000 files`);
});

test("a patch longer than the guard reads whole, or a path longer than a path can be, does not run", async () => {
  const long = await answerHook(
    guard,
    "codex",
    applyPatch(`*** Begin Patch\n*** Add File: a.ts\n${"+x\n".repeat(900_000)}*** End Patch`),
    seat,
  );
  assert.match(long.text, /"permissionDecision":"deny"/);
  assert.match(long.text, /MB in one patch/);
  const path = await answerHook(
    guard,
    "claude",
    {
      tool_name: "Write",
      tool_input: { file_path: `/Users/u/proj/${"a".repeat(10_000)}`, content: "x" },
      cwd: PROJECT,
    },
    seat,
  );
  assert.match(path.text, /"permissionDecision":"deny"/);
  assert.match(path.text, /path/i);
  const ok = await answerHook(
    guard,
    "claude",
    { tool_name: "Write", tool_input: { file_path: `${PROJECT}/a.ts`, content: "x".repeat(3_000_000) }, cwd: PROJECT },
    seat,
  );
  assert.equal(ok.text, "", "the content of a file written is not read, however long");
});

test("a command too long to read is judged and recorded from its start, whatever its length", async () => {
  const lengths: number[] = [];
  const real = redactModule.redact;
  redactModule.redact = (text: string) => (lengths.push(text.length), real(text));
  try {
    const secret = ["sk", "proj", "Abcdefghijklmnopqrstuvwx12"].join("-");
    const long = `echo ${"x ".repeat(1990)}${secret} ${"y".repeat(4_000_000)}`;
    const ruling = await guard.check(seat, "claude", long, PROJECT);
    assert.equal(ruling.allow, false);
    assert.ok(Math.max(...lengths) <= 4000, `redaction read ${Math.max(...lengths)} characters`);
    assert.ok(!(ruling.message ?? "").includes(secret));
    assert.ok((ruling.message ?? "").length < 2000);
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
