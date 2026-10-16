import { PROJECT } from "./support/room";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AskRefused, askJev } from "../server/jev/ask";
import type { Questions, State } from "../server/jev/contract";

const QUESTIONS: Questions = { calls: { type: "noul", instructions: "Does the code still call the old API?" } };

/** A decision model that answers yes and keeps the state it was sent. */
function model() {
  const states: Record<string, unknown>[] = [];
  const jev = {
    decide: async (_caller: string, state: State) => {
      states.push(state as Record<string, unknown>);
      return {
        callId: 1,
        model: "m",
        answers: { calls: { type: "noul" as const, noul: 0.9 } },
        asks: {},
        usd: 0.0001,
        latencyMs: 1,
        attempts: 1,
        suspect: null,
        cached: false,
      };
    },
  };
  return { jev, states };
}

/** A project with a few files of each kind, and a folder outside it. */
function project() {
  const root = mkdtempSync(join(PROJECT, "ask-"));
  const outside = mkdtempSync(join(PROJECT, "ask-out-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".seatwork"), { recursive: true });
  writeFileSync(join(root, "src", "api.ts"), "export const call = () => oldApi();\n");
  writeFileSync(join(root, "src", "long.ts"), "const line = 1;\n".repeat(800));
  writeFileSync(join(root, "src", "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  writeFileSync(join(root, "src", "huge.txt"), "x".repeat(300 * 1024));
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  writeFileSync(join(root, ".seatwork", "room.json"), "{}");
  writeFileSync(join(outside, "secret.txt"), "not the project's\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.txt"));
  return { root, outside };
}

test("the room reads the files a seat names inside its project, in parts the model takes whole, and says why it skipped the rest", async () => {
  const { root, outside } = project();
  const { jev, states } = model();
  const asked = await askJev(
    jev,
    "seats.peer",
    {
      questions: QUESTIONS,
      state: "the client was moved to the new API",
      paths: [
        "src/api.ts",
        "src/long.ts",
        "src/image.png",
        "src/huge.txt",
        ".git/config",
        ".seatwork/room.json",
        "src/link.txt",
        join(outside, "secret.txt"),
        "src/none.ts",
      ],
    },
    { root, cwd: root },
  );
  assert.deepEqual(asked.read, ["src/api.ts", "src/long.ts"]);
  assert.deepEqual(
    asked.skipped.map((one) => [one.path, one.why.split(";")[0].split(",")[0]]),
    [
      ["src/image.png", "not text"],
      ["src/huge.txt", "307200 bytes"],
      [".git/config", "outside the project"],
      [".seatwork/room.json", "outside the project"],
      ["src/link.txt", "outside the project"],
      [join(outside, "secret.txt"), "outside the project"],
      ["src/none.ts", "no such file"],
    ],
  );
  const files = states[0].files as Record<string, string>;
  assert.deepEqual(Object.keys(files), ["src/api.ts", "src/long.ts#1", "src/long.ts#2", "src/long.ts#3"]);
  assert.ok(Object.values(files).every((part) => part.length <= 6000));
  assert.equal(
    Object.values(files).slice(1).join(""),
    "const line = 1;\n".repeat(800),
    "the parts are the file whole, cut at line ends",
  );
  assert.equal(states[0].note, "the client was moved to the new API");
  assert.deepEqual([asked.answers.calls, asked.usd], [{ type: "noul", noul: 0.9 }, 0.0001]);
});

test("a question with nothing to be about, too long a note, too many files, or files too large together is refused before the model is asked", async () => {
  const { root } = project();
  const { jev, states } = model();
  const ask = (args: Record<string, unknown>) =>
    askJev(jev, "seats.peer", { questions: QUESTIONS, ...args }, { root, cwd: root });
  await assert.rejects(ask({}), AskRefused);
  await assert.rejects(ask({ state: "x".repeat(8001) }), /8000 at most/);
  await assert.rejects(ask({ paths: Array.from({ length: 21 }, (_, i) => `src/${i}.ts`) }), /20 at most/);
  for (let i = 0; i < 6; i += 1) writeFileSync(join(root, `big-${i}.txt`), "y\n".repeat(12_000));
  await assert.rejects(
    ask({ paths: Array.from({ length: 6 }, (_, i) => `big-${i}.txt`) }),
    /ask about fewer at a time/,
  );
  await assert.rejects(ask({ questions: "is it done?", state: "s" }), /typed questions by id/);
  assert.equal(states.length, 0);
});
