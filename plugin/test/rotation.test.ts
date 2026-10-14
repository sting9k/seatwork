import { PROJECT } from "./support/room";
import { BRIEF } from "./support/watch";
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefInForce, nextTitle, parseHandoff, successorPrompt } from "../server/orchestration/rotation";

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
    briefInForce(
      [
        BRIEF,
        '<mail id="1" from="owner" subject="NOTED" needs="nothing" thread="m1">\nfine\n</mail>',
        revised,
        "a later note",
      ],
      PROJECT,
    ),
    revised,
  );
  assert.equal(briefInForce(["Take over this workstream.", "more"], PROJECT), "Take over this workstream.");
  assert.equal(briefInForce([], PROJECT), null);
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
