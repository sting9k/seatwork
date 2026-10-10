import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

const choices = join(__dirname, "..", "..", "tools", "choices.py");
const setupFile = join(ROOM_HOME, "setup.json");

// every harness has the same two models, as `paseo provider models <harness> --json` lists them
const catalog = [
  { id: "m-one", model: "One", defaultThinkingOptionId: "medium", thinkingOptionIds: ["low", "medium", "high"] },
  { id: "vendor/m-two", model: "Two", defaultThinkingOptionId: null, thinkingOptionIds: [] },
];
writeFileSync(process.env.SLP_PASEO_BIN!, `#!/bin/sh\n[ "$1 $2" = "provider models" ] || exit 1\necho '${JSON.stringify(catalog)}'\n`);

/** What the installer's question leaves as HQ's seat, given these lines typed at it. */
function answer(typed: string): unknown {
  rmSync(setupFile, { force: true });
  const env = { ...process.env, PATH: `${dirname(process.env.SLP_PASEO_BIN!)}${delimiter}${process.env.PATH}` };
  const run = spawnSync("python3", [choices, "--hq", "ask"], { input: typed, env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(setupFile, "utf8")).hq;
}

test("the installer's question: the room's HQ seat, or the user's own agent CLI and model for it", () => {
  const cases: [typed: string, hq: unknown][] = [
    ["\n", "default"],
    ["", "default"], // no terminal to answer
    ["2\n3\n1\n\n", { provider: "pi-hq/m-one", thinking: "medium" }],
    ["custom\nopencode\nvendor/m-two\n", { provider: "opencode-hq/vendor/m-two" }], // a model without thinking options
    ["2\ncodex\nnope\n1\nhigh\n", { provider: "codex-hq/m-one", thinking: "high" }], // a wrong answer is asked again
  ];
  for (const [typed, hq] of cases) assert.deepEqual(answer(typed), hq, JSON.stringify(typed));
});
