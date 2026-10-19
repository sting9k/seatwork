import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceCommands, briefFields, quotedCommands, scopeGlobs } from "../server/orchestration/brief";

test("the commands a brief quotes are the ones it asks to run, not the code or the files it quotes", () => {
  assert.deepEqual(
    quotedCommands(
      '`npm test` passes; `parseDuration("2h") === 7200000`; edit `src/a.js`; run `./scripts/check.sh --fast`, `make`',
    ),
    ["npm test", "./scripts/check.sh --fast", "make"],
  );
});

test("a write scope is read as the paths and globs it names, whatever prose is around them", () => {
  for (const [scope, globs] of [
    [
      "src/, test/ (including new fixtures under test/fixtures/), README.md. Nothing else. Do NOT edit fixtures/",
      ["src/", "test/", "test/fixtures/", "README.md"],
    ],
    ["`src/parse.js`, `test/parse.test.js`", ["src/parse.js", "test/parse.test.js"]],
    ["src/a.ts src/b.ts", ["src/a.ts", "src/b.ts"]],
    ["src, docs/*.md", ["src", "docs/*.md"]],
    ["NONE. Read-only. Do not edit any file", []],
    [
      "src/cli.js; src/glob.js (new); in src/check.js ONLY scanFolder — do not touch parseMarkdown; new fixture folders under test/fixtures/; README.md: the usage block — NOT the Limits section",
      ["src/cli.js", "src/glob.js", "src/check.js", "test/fixtures/", "README.md"],
    ],
  ] as const)
    assert.deepEqual(scopeGlobs(scope), globs, scope);
});

test("a brief label may carry a note in brackets, and a write scope ends at its first blank line", () => {
  const fields = briefFields(
    [
      "Write scope: src/, README.md. Nothing else.",
      "",
      "Contract the candidate must meet (locked by the Lead):",
      "- `mdlinks a/**/b.md` skips drafts/** and is case-sensitive",
      "Contract (locked): one line per link",
      "Non-goals: tables",
      "Acceptance evidence (run after your last change):",
      "- `npm test`",
    ].join("\n"),
  );
  assert.deepEqual(scopeGlobs(fields.writeScope!), ["src/", "README.md"]);
  assert.equal(fields.contract, "one line per link");
  assert.equal(fields.nonGoals, "tables");
  assert.equal(fields.acceptance, "- `npm test`");
});

test("a brief whose labels stand alone on their lines, as headings with no colon, is read like one with colons", () => {
  const fields = briefFields(
    [
      "Issue: sw-1ni.1 (claim it with seatwork_work).",
      "",
      "Outcome",
      "src/ exports createQueue as SPEC.md states.",
      "",
      "Write scope",
      "src/, test/lib/",
      "",
      "## Non-goals",
      "The CLI; README edits.",
      "",
      "**Acceptance evidence**",
      "- `npm test` exits 0 on your commit.",
      "- A table mapping every rule to its test.",
      "",
      "Output",
      "CANDIDATE with the commit",
    ].join("\n"),
  );
  assert.equal(fields.outcome, "src/ exports createQueue as SPEC.md states.");
  assert.equal(fields.writeScope, "src/, test/lib/");
  assert.equal(fields.nonGoals, "The CLI; README edits.");
  assert.equal(fields.acceptance, "- `npm test` exits 0 on your commit.\n- A table mapping every rule to its test.");
  assert.equal(fields.output, "CANDIDATE with the commit");
  assert.deepEqual(quotedCommands(fields.acceptance ?? ""), ["npm test"]);
});

test("a line that only names a label inside prose stays prose", () => {
  const fields = briefFields(
    ["Outcome: the parser accepts 1h30m", "The outcome of this is clear.", "Context matters here"].join("\n"),
  );
  assert.equal(fields.outcome, "the parser accepts 1h30m\nThe outcome of this is clear.\nContext matters here");
});

test("the commands an acceptance evidence asks for head an item of it; a quote inside a sentence is not one", () => {
  const evidence = [
    "- `npm test` exits 0.",
    "- `cmp SPEC.md <(git show 2fafd73:SPEC.md)` exit 0.",
    "- Run `node --test test/x.test.js`; it fails without the change.",
    "- **`npm run lint`** and `npm run types` pass",
    "- Mutation check: break one rule at a time under $TMPDIR, e.g. make `to` inclusive",
    "- the call throws an Error, `err.code === undefined`; run `seatwork_safety` `control` per guard",
    "- Bench on both files: generate with `node scripts/gen.js --out $TMPDIR/u.csv`",
    "- `node scripts/gen.js --skew <your s> --out x.csv` gives the same sha256 twice",
    "- `sort < in.txt | diff - want.txt` is empty",
    "`make check` passes",
  ].join("\n");
  assert.deepEqual(acceptanceCommands(evidence), [
    "npm test",
    "cmp SPEC.md <(git show 2fafd73:SPEC.md)",
    "node --test test/x.test.js",
    "npm run lint",
    "npm run types",
    "sort < in.txt | diff - want.txt",
    "make check",
  ]);
});

test("a label may carry a note in brackets as a heading of its own, or before a dash and its value", () => {
  const headed = briefFields(
    [
      "Outcome",
      "report is fast",
      "",
      "Contract (must not change)",
      "the output stays byte for byte",
      "",
      "Candidate (a starting hypothesis from reading, not measured — profile with `node --cpu-prof` first)",
      "stream the file",
      "",
      "Acceptance evidence (the Lead reruns these on your exact commit, in a copy)",
      "- `npm test` exit 0 in W.",
      "",
      "Reopen when",
      "the target cannot be met",
    ].join("\n"),
  );
  assert.equal(headed.contract, "the output stays byte for byte");
  assert.equal(headed.candidate, "stream the file");
  assert.deepEqual(acceptanceCommands(headed.acceptance ?? ""), ["npm test"]);
  assert.equal(headed.reopenWhen, "the target cannot be met");
  const dashed = briefFields(
    "Acceptance evidence (run by you after your last change, and again by me on your commit) — `npm test` exits 0 with spawned-process tests\nReopen when: never",
  );
  assert.deepEqual(acceptanceCommands(dashed.acceptance ?? ""), ["npm test"]);
  assert.equal(dashed.reopenWhen, "never");
});
