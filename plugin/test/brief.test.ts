import assert from "node:assert/strict";
import { test } from "node:test";
import { briefFields, quotedCommands, scopeGlobs } from "../server/orchestration/brief";

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
