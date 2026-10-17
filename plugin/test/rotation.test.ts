import { ROOM_HOME } from "./support/room";
import { BRIEF } from "./support/timeline";
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import {
  briefInForce,
  handoffRequest,
  nextTitle,
  parseHandoff,
  Rotations,
  successorPrompt,
} from "../server/orchestration/rotation";

test("a handoff is read by its headings, whatever marks the seat put on them; without task and progress it is none", () => {
  const handoff = parseHandoff(
    "HANDOFF\n\n## CURRENT TASK\nround four of the store\n\n- PROGRESS: done 2ea3368\n  to do: mixed reads\n**Blockers** — none\nKEY DECISIONS: a log",
  );
  assert.deepEqual(handoff?.sections, {
    "CURRENT TASK": "round four of the store",
    PROGRESS: "done 2ea3368\n  to do: mixed reads",
    "KEY DECISIONS": "a log",
    "ACTIVE FILES": "",
    BLOCKERS: "none",
  });
  // the text kept starts at the first heading: a preamble is not part of the handoff
  assert.match(handoff!.text, /^## CURRENT TASK\n/);
  assert.equal(parseHandoff("STATUS\nstill reviewing; my current task is the store"), null);
  assert.equal(parseHandoff("CURRENT TASK: the store\nPROGRESS:\nBLOCKERS: none"), null);
});

test("the brief in force is the latest prompt written from the template; a seat that got none keeps its first prompt", () => {
  const revised = `<mail id="2" from="owner" subject="REVISED BRIEF" needs="nothing" thread="m1">\n${BRIEF.replace("Outcome:", "Outcome: (revised)")}\n</mail>`;
  assert.equal(
    briefInForce([
      BRIEF,
      '<mail id="1" from="owner" subject="NOTED" needs="nothing" thread="m1">\nfine\n</mail>',
      revised,
      "a later note",
    ]),
    revised,
  );
  assert.equal(briefInForce(["Take over this workstream.", "more"]), "Take over this workstream.");
  assert.equal(briefInForce([]), null);
});

test("a successor is told its brief, its handoff and to trust the tree; its title counts up", () => {
  const prompt = successorPrompt({
    brief: "Outcome: x",
    handoff: "CURRENT TASK: y",
    file: "/p/.seatwork/handoffs/h.md",
  });
  assert.match(
    prompt,
    /## The brief in force\nOutcome: x\n\n## The handoff \(kept at \/p\/\.seatwork\/handoffs\/h\.md\)\nCURRENT TASK: y\n\n.*trust the tree/,
  );
  assert.match(
    successorPrompt({ brief: null, handoff: "h", file: "f" }),
    /ask your Owner for the brief before you edit/,
  );
  assert.deepEqual(
    [nextTitle("[Lead] store"), nextTitle("[Lead] store (2)"), nextTitle(null)],
    ["[Lead] store (2)", "[Lead] store (3)", "seat (2)"],
  );
});

test("a handoff past its length ends at a sentence and says it was cut", () => {
  const handoff = parseHandoff(`HANDOFF\nCURRENT TASK: the store\nPROGRESS: ${"done a step. ".repeat(800)}`)!;
  assert.ok(handoff.text.length < 6100);
  assert.match(handoff.text, /step\.\n\[cut by the room at 6000 characters\]$/);
});

test("a rotation asked for outlives a restart; one the room was starting is said once; one never answered runs out", () => {
  const file = join(ROOM_HOME, "rotations-test.json");
  const asked = new Rotations(file);
  asked.ask("lead-a", "sup", 7, 1000);
  asked.ask("lead-b", "sup", 8, 1000);
  asked.starting("lead-b");

  const after = new Rotations(file);
  assert.equal(after.get("lead-a")?.mailId, 7);
  assert.deepEqual(
    after.interrupted.map(([seat]) => seat),
    ["lead-b"],
  );
  assert.equal(after.get("lead-b"), undefined);
  assert.deepEqual(new Rotations(file).interrupted, [], "an interrupted rotation was said twice");
  assert.deepEqual(after.expired(1000 + 119 * 60_000, 120), []);
  assert.deepEqual(
    after.expired(1000 + 121 * 60_000, 120).map(([seat]) => seat),
    ["lead-a"],
  );
  assert.equal(new Rotations(file).get("lead-a"), undefined);
});

const EXACT = [
  "$ npm test -- --grep 'a  b'",
  "Error: ENOENT: no such file or directory, open '/tmp/x y/z.json'",
  '  indented: "quoted" `tick` ```fence',
  "const LIMIT = 0x7fff_ffff; // 2147483647",
].join("\n");

test("a handoff may carry exact strings under VERBATIM: they are kept as written, apart from the summary", () => {
  const handoff = parseHandoff(
    `HANDOFF\nCURRENT TASK: the store\nPROGRESS: done\nVERBATIM:\n${EXACT}\nBLOCKERS: none`,
  )!;
  assert.equal(handoff.verbatim.text, EXACT);
  assert.equal(handoff.verbatim.left, 0);
  assert.doesNotMatch(handoff.text, /ENOENT|VERBATIM/);
  assert.equal(handoff.sections.BLOCKERS, "none", "the heading after it still ends it");

  const last = parseHandoff("HANDOFF\nCURRENT TASK: a\nPROGRESS: b\n**VERBATIM** — npm run build:all  \n")!;
  assert.equal(last.verbatim.text, "npm run build:all");
  assert.deepEqual(parseHandoff("CURRENT TASK: a\nPROGRESS: b")!.verbatim, { text: "", left: 0 });
});

test("the exact strings of a handoff are held to a size at whole lines, and the room says how many it left out", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `id-${String(i).padStart(3, "0")} ${"x".repeat(30)}`);
  const handoff = parseHandoff(`CURRENT TASK: a\nPROGRESS: b\nVERBATIM:\n${lines.join("\n")}`)!;
  const kept = handoff.verbatim.text.split("\n");
  assert.ok(handoff.verbatim.text.length <= 4000, `${handoff.verbatim.text.length} characters were kept`);
  assert.deepEqual(kept, lines.slice(0, kept.length), "a kept line is whole and in its place");
  assert.equal(handoff.verbatim.left, lines.length - kept.length);
  assert.ok(kept.length > 50 && handoff.verbatim.left > 0);

  const long = parseHandoff(`CURRENT TASK: a\nPROGRESS: b\nVERBATIM: ${"y".repeat(9000)}`)!;
  assert.equal(long.verbatim.text.length, 4000, "one line past the size is cut in the line");
  assert.equal(long.verbatim.left, 1);
});

test("the request for a handoff names the exact-strings heading and says the room carries it as written", () => {
  const request = handoffRequest("");
  assert.match(
    request,
    /\nVERBATIM \(optional\): [^\n]*commands, error messages, ids, constants, paths[^\n]*as written/,
  );
  assert.match(
    request,
    /\nKEY DECISIONS: [^\n]*recorded[^\n]*successor/,
    "the decisions people made are carried by the room",
  );
});

test("a successor is given the exact strings in a fence that cannot be closed from inside, then what the room kept for its task", () => {
  const prompt = successorPrompt({
    brief: "Outcome: x",
    handoff: "CURRENT TASK: y",
    file: "/p/h.md",
    verbatim: { text: EXACT, left: 3 },
    kept: ["## Decisions in force for your task", "- [task T-1] store: Keep SQLite."],
  });
  assert.ok(prompt.includes(`\n\`\`\`\`\n${EXACT}\n\`\`\`\`\n`), "four backticks fence a text that holds three");
  assert.match(prompt, /3 more lines were left out/);
  assert.ok(prompt.indexOf("## The handoff") < prompt.indexOf("Exact strings"));
  assert.ok(prompt.indexOf("Exact strings") < prompt.indexOf("## Decisions in force for your task"));
  assert.ok(prompt.indexOf("- [task T-1] store") < prompt.indexOf("trust the tree"));
  assert.doesNotMatch(successorPrompt({ brief: null, handoff: "h", file: "f" }), /Exact strings|Decisions in force/);
});
