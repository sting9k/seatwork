import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { traits } from "../shared/workflow";
import { briefFields, quotedCommands, scopeGlobs } from "../server/orchestration/brief";
import type { TurnEvent } from "../server/host";
import {
  Council,
  type CouncilPolicy,
  type Decider,
  type HandInDiff,
  type TurnInput,
} from "../server/safety/council/council";
import { counted, hiFor, levelFor, type Label } from "../server/safety/council/calibration";
import { lowerBound, upperBound } from "../server/bounds";
import {
  claimsIn,
  loopIn,
  maskOf,
  outsideScope,
  testsNotRun,
  turnFacts,
  unborneIn,
} from "../server/safety/council/facts";
import { snapshot } from "../server/safety/council/git";
import { SafetyStore, type ReadingRow } from "../server/safety/store";

shipSql();

const ROOT = "/work/echo";
const say = (text: string): TurnEvent => ({ kind: "say", text });
const change = (path: string): TurnEvent => ({ kind: "change", path, status: "completed" });
const shell = (command: string, exitCode: number | null = 0, output = "ok"): TurnEvent => ({
  kind: "shell",
  command,
  exitCode,
  output,
  status: "completed",
});
const BRIEF = [
  "Outcome: parseDuration accepts hours.",
  "Write scope: src/duration.js, test/**",
  "Non-goals: no change to the CLI",
  "Acceptance evidence: `npm test` passes",
].join("\n");

test("what a turn shows without a model: claims, checks, changes outside the scope, loops", () => {
  assert.deepEqual(claimsIn("Done.\nAll 42 tests pass.\nThe build is not green yet.\nTests failed twice, now pass"), [
    "All 42 tests pass.",
  ]);
  const ran = [shell("cd app && npx vitest run"), shell("./scripts/acceptance.sh --fast"), shell("git status")];
  assert.deepEqual(
    turnFacts(ran, ["./scripts/acceptance.sh"]).checks.map(({ command }) => command),
    ["cd app && npx vitest run", "./scripts/acceptance.sh --fast"],
  );
  assert.deepEqual(
    quotedCommands(
      '`npm test` passes; `parseDuration("2h") === 7200000`; edit `src/a.js`; run `./scripts/check.sh --fast`, `make`',
    ),
    ["npm test", "./scripts/check.sh --fast", "make"],
  );

  const facts = turnFacts([shell("npm test"), change("src/a.js"), shell("npm test", 1), shell("git diff")], []);
  assert.deepEqual(
    [facts.lastChange, facts.changed, facts.checksAfterChange],
    [1, ["src/a.js"], [{ command: "npm test", exitCode: 1, masked: null }]],
  );

  assert.deepEqual(
    outsideScope(
      [`${ROOT}/src/duration.js`, "test/unit/a.test.js", "src/other.js", "/etc/hosts"],
      ["src/duration.js", "test/**"],
      ROOT,
    ),
    ["src/other.js", "/etc/hosts"],
  );

  const limits = { window: 20, sameResult: 4, sameError: 4, alternation: 6 };
  const cases: [TurnEvent[], string | null][] = [
    [Array.from({ length: 4 }, () => shell("npm test", 1, "same")), "same-result"],
    [[1, 2, 3, 4].map((n) => shell("npm test", 1, `run ${n}`)), "same-error"],
    [[0, 1, 2, 3, 4, 5].map((n) => shell(n % 2 ? "git stash pop" : "git stash")), "alternation"],
    [[shell("npm test", 1, "a"), shell("npm test", 1, "b"), shell("npm test", 0), shell("npm test", 1, "c")], null],
    [[shell("ls"), shell("cat a"), shell("npm test"), shell("git status")], null],
  ];
  for (const [events, pattern] of cases) assert.equal(loopIn(events, limits)?.pattern ?? null, pattern);
});

test("a file whose name starts with two dots is inside the work tree; only a step to the parent is outside it", () => {
  assert.deepEqual(outsideScope(["..data/app.yaml", "..", "../x.js", "a/../../y.js"], ["**"], ROOT), [
    "..",
    "../x.js",
    "a/../../y.js",
  ]);
  assert.deepEqual(outsideScope(["..data/app.yaml"], ["..data/**"], ROOT), []);
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
  assert.deepEqual(
    outsideScope([".env", ".github/ci.yml", "src/.hidden.ts", "other/a.ts"], ["src/**", ".github/**"], ROOT),
    [".env", "other/a.ts"],
    "a glob covers a name that starts with a dot as it covers any other",
  );
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

test("a check whose exit code proves nothing is named: a later command sets it, or a filter the brief did not ask for", () => {
  const later = "a later command decides its exit code";
  const narrow = (flag: string) => `\`${flag}\` runs only the tests it selects, maybe none`;
  const cases: [string, string[], string | null][] = [
    ["npm test", [], null],
    ["cd app && npm test && echo ok", [], null],
    ["npm test > out.log 2>&1", [], null],
    ["npm test &&\n  echo ok", [], null],
    ["set -o pipefail; npm test | tail -20", [], null],
    ['npm test -- --grep "a|b"', [], null],
    ["npx tsc -t es2020 --noEmit", [], null],
    ["pytest -k cache", ["pytest -k cache"], null],
    ["npm test || true", [], "`||` decides its exit code"],
    ["npm test 2>&1 | tail -20", [], "it is piped, so the pipe's last command decides its exit code"],
    ["npm test; echo done", [], later],
    ["npm test\necho $?", [], later],
    ["npm test > out.log 2>&1 &", [], "it runs in the background"],
    ["npx jest --passWithNoTests", [], narrow("--passWithNoTests")],
    ["pytest -k cache", [], narrow("-k")],
    ["go test -run TestParse ./...", [], narrow("-run")],
    ["mvn test -Dtest=ParserTest", [], narrow("-Dtest")],
    ["./gradlew test --tests '*Parser*'", [], narrow("--tests")],
    ["bundle exec rspec -e parses", [], narrow("-e")],
    ["mvn -q verify", [], null],
  ];
  for (const [command, named, why] of cases) assert.equal(maskOf(command, named), why, command);
});

test("the tests a turn ran after its last change: a check that names no path runs them all, one that names paths runs those", () => {
  const related = ["test/a.test.ts", "test/unit/b.test.ts", "pkg/c_test.go"];
  const cases: [TurnEvent[], string[]][] = [
    [[change("src/a.ts"), shell("npm test")], []],
    [[shell("npm test"), change("src/a.ts")], related],
    [[change("src/a.ts"), shell("npm test", 1)], related],
    [[change("src/a.ts"), shell("npm test | tail -3")], related],
    [
      [change("src/a.ts"), shell("npx vitest run test/a.test.ts")],
      ["test/unit/b.test.ts", "pkg/c_test.go"],
    ],
    [[change("src/a.ts"), shell("npx vitest run test/")], ["pkg/c_test.go"]],
    [[change("src/a.ts"), shell(`npx vitest run ${ROOT}/test/a.test.ts ./test/unit/b.test.ts`)], ["pkg/c_test.go"]],
    [
      [change("src/a.ts"), shell("pytest 'test/a.test.ts::case'")],
      ["test/unit/b.test.ts", "pkg/c_test.go"],
    ],
    [[change("src/a.ts"), shell("go test ./...")], []],
    [
      [change("src/a.ts"), shell("go test ./pkg/...")],
      ["test/a.test.ts", "test/unit/b.test.ts"],
    ],
  ];
  for (const [events, missed] of cases) assert.deepEqual(testsNotRun(events, [], related, ROOT), missed);
  const hidden = ["test/.unit/d.test.ts"];
  assert.deepEqual(
    testsNotRun([change("src/a.ts"), shell("npx vitest run 'test/**/*.test.ts'")], [], hidden, ROOT),
    [],
    "a glob covers a folder whose name starts with a dot",
  );
});

test("what a report says that its turn does not bear out: a path cited or changed that is not there, a run, a test count", () => {
  const root = join(ROOM_HOME, "report-root");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const worked = [change(`${root}/src/a.ts`), shell("npm test", 0, "Tests: 41 passed, 41 total")];
  const cases: [string, TurnEvent[], unknown[]][] = [
    ["Changed `src/a.ts` and src/b.ts.", worked, [{ kind: "path", said: "src/b.ts" }]],
    ["The bug is at src/a.ts:42.", worked, [{ kind: "line", said: "src/a.ts:42", found: "10 lines" }]],
    ["The bug was at src/a.ts:10 and src/gone.ts:3.", [...worked, change(`${root}/src/gone.ts`)], []],
    ["I suggest adding src/cache.ts next.", worked, []],
    ["Updated the guide, see https://example.com/docs/a.md", worked, []],
    ["Ran `npm run e2e` and `npm test`.", worked, [{ kind: "run", said: "npm run e2e" }]],
    ["Ran `npm run e2e` earlier.", [shell("git status")], []],
    ["All 42 tests pass.", worked, [{ kind: "count", said: "42 tests", found: "41" }]],
    ["All 41 tests pass.", worked, []],
    [
      "All 42 tests pass.",
      [change(`${root}/src/a.ts`), shell("npm test", 0, "30 passed"), shell("npm run test:e2e", 0, "12 passing")],
      [],
    ],
  ];
  for (const [text, events, expected] of cases) assert.deepEqual(unborneIn(text, events, [], root), expected, text);
});

let homes = 0;
/** A council over its own store; `answer` stands in for the decision district. */
function councilWith(
  levels: CouncilPolicy["levels"] = {},
  answer?: (state: Record<string, unknown>) => number,
  diffOf?: (seat: string) => HandInDiff | null,
) {
  const dir = join(ROOM_HOME, `council-${(homes += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  const store = new SafetyStore(dir, 2000);
  const asked: Record<string, unknown>[] = [];
  const decider: Decider | null = answer
    ? {
        why: () => null,
        decide: async (_caller, state, questions) => {
          asked.push(state);
          const id = Object.keys(questions)[0];
          return { answers: { [id]: { type: "noul", noul: answer(state) } }, asks: { [id]: asked.length } };
        },
      }
    : null;
  const council = new Council({
    store: () => store,
    decider,
    policy: () => ({ mode: "on", keepDays: 90, tickSeconds: 60, levels }),
    log: () => {},
    snapshot,
    diffOf,
  });
  const readings = () =>
    store
      .councilCounts("2000-01-01")
      .map(({ member, readings, found, grey, shown }) => ({ member, readings, found, grey, shown }));
  return { council, store, asked, readings };
}

const peerTurn = (events: TurnEvent[], text: string, brief: string | null = BRIEF): TurnInput => ({
  seat: { id: "peer-1", role: "peer", traits: traits("peer"), root: ROOT, task: "peer-1" },
  turn: "t1",
  events,
  text,
  brief,
  verdicts: [],
});

test("every member that watches a seat logs its reading; one that only logs shows nothing", async () => {
  const { council, readings } = councilWith();
  const found = await council.endOfTurn(
    peerTurn([change(`${ROOT}/src/cli.js`), say("CANDIDATE: hours added")], "CANDIDATE: hours added\nAll tests pass."),
  );
  assert.deepEqual(found, []);
  assert.deepEqual(readings(), [
    { member: "claims", readings: 1, found: 1, grey: 0, shown: 0 },
    { member: "report", readings: 1, found: 0, grey: 0, shown: 0 },
    { member: "scope", readings: 1, found: 1, grey: 0, shown: 0 },
    { member: "stuck", readings: 1, found: 0, grey: 0, shown: 0 },
  ]);
});

test("a writer's turn that changed nothing is held to any check it ran; one whose changes no step explains is skipped", async () => {
  const found = async (events: TurnEvent[], changed: string[]) => {
    const { council, store } = councilWith();
    await council.endOfTurn({ ...peerTurn(events, "REVIEW: ACCEPT\nAll tests pass."), changed });
    return store.councilCounts("2000-01-01").find((row) => row.member === "claims")?.found;
  };
  assert.equal(await found([say("read it")], []), 1, "a claim with no check in a turn that changed nothing");
  assert.equal(await found([shell("npm test")], []), 0);
  assert.equal(await found([say("read it")], ["src/cli.js"]), 0, "git saw a change no step made: skipped");
});

test("a line its hook gave as written meets the same line kept with its single quotes escaped, as Codex's wrapper keeps it", async () => {
  const { council, store } = councilWith();
  const edit = "sed -i 's/a/b/' src/cli.js";
  council.turnStarted("peer-1", ROOT);
  council.wrote("peer-1", edit);
  await council.endOfTurn(
    peerTurn([shell("npm test"), shell(edit.replaceAll("'", "'\\''"))], "CANDIDATE: hours added\nAll tests pass."),
  );
  assert.equal(store.councilCounts("2000-01-01").find((row) => row.member === "claims")?.found, 1);
});

test("a member that has earned its level speaks once per finding: the same thing found again is not shown again", async () => {
  const { council } = councilWith({ claims: 1, scope: 1 });
  const turn = peerTurn([change(`${ROOT}/src/cli.js`)], "CANDIDATE: hours added\nAll tests pass.");
  const first = await council.endOfTurn(turn);
  assert.deepEqual(
    first.map((finding) => finding.member),
    ["claims", "scope"],
  );
  assert.match(
    first[0].line,
    /^claims #\d+: the report says "All tests pass\.", and no check passed after the last change$/,
  );
  assert.match(first[1].line, /^scope #\d+: changed \/work\/echo\/src\/cli\.js, outside the write scope/);
  const held = await council.endOfTurn({ ...turn, turn: "t1b" });
  assert.deepEqual(
    held.map((finding) => finding.member),
    ["claims", "scope"],
    "a finding whose line did not reach the seat above is not yet said",
  );
  council.shown(first);
  const again = await council.endOfTurn({ ...turn, turn: "t2" });
  assert.deepEqual(
    again.map((finding) => finding.member),
    ["claims"],
    "the same files outside the scope are not said twice",
  );
  const checked = await council.endOfTurn(
    peerTurn([change(`${ROOT}/src/duration.js`), shell("npm test")], "CANDIDATE: hours added\nAll tests pass."),
  );
  assert.deepEqual(checked, [], "a check that passed after the last change answers the claim");
  const piped = await council.endOfTurn({
    ...peerTurn(
      [change(`${ROOT}/src/duration.js`), shell("npm test | tail -5")],
      "CANDIDATE: hours added\nAll tests pass.",
    ),
    turn: "t3",
  });
  assert.match(
    piped[0].line,
    /and no check passed after the last change \("npm test \| tail -5": it is piped, so the pipe's last command decides its exit code\)$/,
  );
});

test("a candidate's turn is held to the unchanged tests that name what it changed", async () => {
  const related = ["test/cli.test.js", "test/unit/parse.test.js"];
  const { council } = councilWith({ radius: 1 }, undefined, () => ({ gaming: null, returned: false, related }));
  const candidate = (events: TurnEvent[], turn: string) => ({ ...peerTurn(events, "CANDIDATE: hours added"), turn });
  const missed = await council.endOfTurn(
    candidate([change(`${ROOT}/src/duration.js`), shell("npx vitest run test/cli.test.js")], "r1"),
  );
  assert.match(
    missed[0].line,
    /^radius #\d+: 1 test\(s\) that name what changed did not pass after the last change: test\/unit\/parse\.test\.js$/,
  );
  assert.deepEqual(
    await council.endOfTurn(candidate([change(`${ROOT}/src/duration.js`), shell("npm test")], "r2")),
    [],
  );
});

test("a report that names a file its turn never had is said under it", async () => {
  const { council } = councilWith({ report: 1 });
  const found = await council.endOfTurn(
    peerTurn([change(`${ROOT}/src/duration.js`)], "CANDIDATE: hours added; fixed src/duration.js and src/units.js"),
  );
  assert.match(found[0].line, /^report #\d+: names "src\/units\.js", which is not there$/);
});

test("a juror is asked only where the facts cannot tell, and its grey band keeps it quiet", async () => {
  const probability = { value: 0.95 };
  const { council, asked, readings } = councilWith({ claims: 1 }, () => probability.value);
  const report = "CANDIDATE: hours added; the parser handles 2h and 90m as asked.";
  const found = await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], report, null));
  assert.deepEqual([asked.length, found.length], [1, 1]);
  assert.match(found[0].line, /^claims #\d+: the report reads as tested \(0\.95\)/);
  assert.equal((asked[0] as { report: string }).report, report);
  council.shown(found);

  probability.value = 0.5;
  assert.deepEqual(await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], report, null)), []);
  await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], "STATUS: still parsing", null));
  assert.equal(asked.length, 2, "a report that closes no work is not asked about");
  assert.deepEqual(readings()[0], { member: "claims", readings: 3, found: 1, grey: 1, shown: 1 });
});

const lead = (
  events: TurnEvent[],
  verdicts: TurnInput["verdicts"],
  text = "ACCEPT",
  turn = `t${events.length}`,
): TurnInput => ({
  seat: { id: "lead-1", role: "lead", traits: traits("lead"), root: ROOT, task: "lead-1" },
  turn,
  events,
  text,
  brief: null,
  verdicts,
});

test("a Lead's verdicts are read against the work: an acceptance without its check, a task sent back again and again", async () => {
  const { council } = councilWith({ verdict: 1, repair: 1 });
  const work = { to: "peer-1", brief: BRIEF, task: "peer-1", rejected: 0, contextTokens: 400_000, costUsd: 9.5 };
  const unchecked = await council.endOfTurn(lead([shell("git diff")], [{ ...work, accepted: true }]));
  assert.match(
    unchecked[0].line,
    /^verdict #\d+: accepted peer-1's work without running its acceptance check "npm test"$/,
  );
  assert.deepEqual(await council.endOfTurn(lead([shell("npm test -- --run")], [{ ...work, accepted: true }])), []);
  const swallowed = await council.endOfTurn(
    lead([shell("git status"), shell("npm test || true")], [{ ...work, accepted: true }]),
  );
  const handedIn = { handed: "d1", now: "d2", previous: null };
  const changed = await council.endOfTurn(
    lead([shell("git status"), shell("ls"), shell("npm test")], [{ ...work, accepted: true, work: handedIn }]),
  );
  assert.match(changed[0].line, /^verdict #\d+: accepted peer-1's work, which changed after it was handed in$/);
  const unchanged = { handed: "d3", now: "d3", previous: { accepted: false, digest: "d3" } };
  const turned = await council.endOfTurn(
    lead(
      [shell("pwd"), shell("ls"), shell("git log"), shell("npm test")],
      [{ ...work, accepted: true, work: unchanged }],
    ),
  );
  assert.match(turned[0].line, /^verdict #\d+: accepted peer-1's work, sent back before with nothing changed since$/);
  const fixed = { handed: "d4", now: "d4", previous: { accepted: false, digest: "d3" } };
  assert.deepEqual(
    await council.endOfTurn(lead([shell("npm test")], [{ ...work, accepted: true, work: fixed }])),
    [],
    "work that changed since the verdict before is a new verdict",
  );
  assert.match(
    swallowed[0].line,
    /^verdict #\d+: accepted peer-1's work on a run of "npm test" whose exit code proves nothing: `\|\|` decides its exit code$/,
  );

  assert.deepEqual(await council.endOfTurn(lead([], [{ ...work, accepted: false, rejected: 2 }])), []);
  const third = await council.endOfTurn(lead([shell("ls")], [{ ...work, accepted: false, rejected: 3 }]));
  assert.match(
    third[0].line,
    /^repair #\d+: peer-1's work was sent back 3 times; its context holds 400K tokens, it cost 9\.50 USD/,
  );
});

test("a running turn is mailed about only for a loop or a silence, and only by a member at the mailing level", async () => {
  const seat = { id: "peer-1", role: "peer", traits: traits("peer"), root: ROOT, task: "peer-1" };
  const looping = Array.from({ length: 4 }, () => shell("npm test", 1, "same"));
  const quiet: TurnEvent[] = [{ ...shell("sleep 1"), at: new Date(Date.now() - 15 * 60_000).toISOString() }];
  const { council: logs, readings } = councilWith();
  assert.deepEqual(logs.whileRunning(seat, looping), []);
  assert.deepEqual(logs.whileRunning(seat, looping), [], "a loop that lasts is logged once, not at every look");
  assert.deepEqual(logs.whileRunning(seat, [shell("ls")]), []);
  assert.deepEqual(readings(), [{ member: "stuck", readings: 1, found: 1, grey: 0, shown: 0 }]);

  const { council: mails } = councilWith({ stuck: 2 });
  assert.match(mails.whileRunning(seat, looping)[0].line, /^stuck #\d+: same-result 4 times in a row: "npm test"$/);
  assert.deepEqual(mails.whileRunning(seat, looping), [], "the same loop is mailed once");
  assert.match(mails.whileRunning(seat, quiet)[0].line, /^stuck #\d+: no step for 15 minutes in a running turn$/);

  const { council: lines } = councilWith({ stuck: 1 });
  assert.deepEqual(lines.whileRunning(seat, looping), [], "a member below the mailing level has nothing to say yet");
  const found = await lines.endOfTurn(peerTurn(looping, "STATUS: still at it", null));
  assert.match(
    found[0].line,
    /^stuck #\d+: same-result 4 times in a row: "npm test"$/,
    "its line goes under the report",
  );
});

test("the council's log keeps what a label holds and lets the rest go; every statement uses an index", () => {
  const { council, store } = councilWith();
  const reading: ReadingRow = {
    member: "claims",
    version: 1,
    seat: "s",
    role: "peer",
    task: null,
    turn: null,
    tier: "fact",
    zone: "found",
    score: null,
    askId: null,
    level: 0,
    shown: false,
    fingerprint: "f",
    evidence: null,
  };
  const id = store.read(reading);
  store.read({ ...reading, member: "scope", zone: "clear", fingerprint: null });
  assert.ok(store.labelReading(id, "owner", "right"));
  store.markShown([id]);
  store.shownBefore("s", "claims", "f");
  store.readBefore("s", "claims", "f");
  store.readingSeat(id);
  store.openFinding("claims", "s", "implied:acceptance-run");
  store.openFinding("repair", "s", "implied:next-verdict", "task:", "t1");
  store.labelsOf("claims", 1, 10);
  store.labelCount("claims", 1);
  store.setMemberState({ member: "claims", version: 1, level: 0, hi: 0.9, labels: 1 });
  store.memberState("claims");
  const appeal = store.addAppeal({
    readingId: id,
    member: "gaming",
    seat: "s",
    finding: "f",
    chair: "hq",
    packet: "{}",
    dueInMs: 60_000,
  });
  store.appeal(appeal);
  store.openAppeals();
  store.appealed("s", "gaming", "f");
  store.rule(appeal, "upheld", "hq", "the tests are fine");
  council.counts(30);
  assert.equal(
    store.expireCouncil(new Date(Date.now() + 86_400_000)),
    2,
    "the reading no label holds and the appeal go; the labelled reading stays",
  );
  assert.deepEqual(
    store.councilCounts("2000-01-01").map(({ member, right }) => [member, right]),
    [["claims", 1]],
  );
  const scans = store
    .plans()
    .filter(({ sql }) => /council_/.test(sql))
    .filter(({ plan }) => /\bSCAN (council_readings|council_labels|r|l)\b(?! USING)/.test(plan));
  assert.deepEqual(scans, []);
  const plans = store.plans().map(({ plan }) => plan);
  const indexes = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'council_%'")
    .all() as { name: string }[];
  assert.deepEqual(
    indexes.map(({ name }) => name).filter((name) => !plans.some((plan) => plan.includes(name))),
    [],
    "an index no statement uses costs a write for nothing",
  );
});

test("labels move a member by exact binomial bounds: up when enough are right, down when the recent ones fail it", () => {
  assert.ok(Math.abs(lowerBound(15, 15) - 0.1 ** (1 / 15)) < 1e-6);
  assert.ok(Math.abs(upperBound(0, 29) - (1 - 0.1 ** (1 / 29))) < 1e-6);
  assert.deepEqual([lowerBound(0, 10), upperBound(10, 10)], [0, 1]);

  const label = (i: number, value: "right" | "wrong", extra: Partial<Label> = {}): Label => ({
    reading: i,
    source: "seat:lead",
    value,
    task: `task-${i % 5}`,
    score: null,
    tier: "fact",
    ...extra,
  });
  const right = (n: number) => Array.from({ length: n }, (_, i) => label(i, "right"));
  assert.deepEqual([levelFor(right(14), 0), levelFor(right(15), 0), levelFor(right(30), 0)], [0, 1, 2]);
  const slipping = [...Array.from({ length: 20 }, (_, i) => label(100 + i, i % 2 ? "wrong" : "right")), ...right(40)];
  assert.equal(levelFor(slipping, 2), 1, "the newest twenty labels pull a member down one level");

  const implied = (i: number, value: "right" | "wrong") => label(i, value, { source: "implied:acceptance-run" });
  const alone = implied(50, "right");
  const asSeats = (agree: number) => [
    ...right(10),
    ...Array.from({ length: 10 }, (_, i) => implied(i, i < agree ? "right" : "wrong")),
    alone,
  ];
  assert.equal(counted(asSeats(10)).length, 11, "an implied source that agrees with the seats counts on its own");
  assert.equal(counted(asSeats(6)).length, 10, "one that parts company with them does not");
  assert.equal(counted([...right(3), alone]).length, 3, "an implied source no seat has checked does not count");

  const scored = [
    ...Array.from({ length: 20 }, (_, i) => label(i, "right", { tier: "juror", score: 0.96 })),
    ...Array.from({ length: 10 }, (_, i) => label(50 + i, "wrong", { tier: "juror", score: 0.86 })),
  ];
  assert.deepEqual([hiFor(scored, 0.9), hiFor(scored, 0.75), hiFor([], 0.9)], [0.9, 0.8, 0.95]);
});

test("a member earns its level from the seat above's labels and then speaks; a level the policy pins does not move", async () => {
  const { council, store } = councilWith();
  const ids: number[] = [];
  for (let i = 0; i < 15; i += 1) {
    await council.endOfTurn({
      ...peerTurn([change(`${ROOT}/src/duration.js`)], "CANDIDATE: hours added\nAll tests pass."),
      seat: { id: `peer-${i % 3}`, role: "peer", traits: traits("peer"), root: ROOT, task: `task-${i % 3}` },
      turn: `t${i}`,
    });
    ids.push(
      (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
        .prepare("SELECT max(id) AS id FROM council_readings WHERE member = 'claims'")
        .get()!.id as number,
    );
  }
  assert.equal(council.level("claims"), 0);
  for (const id of ids) council.label(id, "seat:lead-1", "right", "it never ran the suite");
  assert.equal(council.level("claims"), 1);
  const spoken = await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], "CANDIDATE\nAll tests pass."));
  assert.deepEqual(
    spoken.map((finding) => finding.member),
    ["claims"],
  );

  const pinned = councilWith({ claims: 0 });
  for (const id of ids.slice(0, 1)) pinned.council.label(id, "seat:lead-1", "right", "x");
  assert.equal(pinned.council.level("claims"), 0);
});

test("an Owner's run of the work's own check labels the claim it answers; the label waits until the seats agree with it", async () => {
  const { council, store } = councilWith();
  const sentBack = [
    { to: "peer-1", accepted: false, brief: BRIEF, task: "peer-1", rejected: 1, contextTokens: null, costUsd: null },
  ];
  await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], "CANDIDATE: hours added\nAll tests pass."));
  await council.endOfTurn(lead([shell("npm test", 1, "1 failing")], sentBack, "REJECT", "lt1"));
  assert.deepEqual(
    store.labelsOf("claims", 1, 10).map(({ source, value }) => [source, value]),
    [["implied:acceptance-run", "right"]],
  );
  assert.equal(council.level("claims"), 0, "an implied source no seat has checked moves nothing");

  // a run whose exit code a pipe decides says nothing of the claim
  await council.endOfTurn({
    ...peerTurn([change(`${ROOT}/src/duration.js`)], "CANDIDATE: hours added\nAll tests pass."),
    turn: "t2",
  });
  await council.endOfTurn(lead([shell("npm test | tail -3", 0, "1 failing")], sentBack, "ACCEPT", "lt2"));
  assert.equal(store.labelsOf("claims", 1, 10).length, 1);
});

test("scope sees every file a turn changed, a shell's edits included, by git", async () => {
  const repo = join(ROOM_HOME, "council-repo");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  run("init", "-q");
  writeFileSync(join(repo, "src", "duration.js"), "1\n");
  writeFileSync(join(repo, "README.md"), "x\n");
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");

  const { council } = councilWith({ scope: 1 });
  const seat = { id: "peer-git", role: "peer", traits: traits("peer"), root: repo, task: "peer-git" };
  council.turnStarted(seat.id, join(repo, "src"));
  // the turn's start is read before its first edit, as a model takes seconds to make one
  await council.changedIn(seat.id);
  // as `sed -i` and `echo >` would: no edit tool call for either file
  writeFileSync(join(repo, "README.md"), "changed by a shell\n");
  writeFileSync(join(repo, "src", "duration.js"), "2\n");
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "test", "tést.js"), "3\n");
  const tree = await council.changedIn(seat.id);
  assert.deepEqual(
    [tree?.root, tree?.files.sort()],
    [realpathSync(repo), ["README.md", "src/duration.js", "test/tést.js"]],
    "a name git would quote is given as it is",
  );
  const found = await council.endOfTurn({
    ...peerTurn([shell("sed -i '' s/x/y/ README.md")], "STATUS: working"),
    seat: { ...seat, root: tree!.root },
    changed: tree!.files,
  });
  assert.match(found[0].line, /^scope #\d+: changed README\.md, outside the write scope/);
});
