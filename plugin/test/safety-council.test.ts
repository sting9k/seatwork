import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { traits } from "../shared/workflow";
import { quotedCommands } from "../server/orchestration/brief";
import type { TurnEvent } from "../server/host";
import { Council, type CouncilPolicy, type Decider, type TurnInput } from "../server/safety/council/council";
import { counted, hiFor, levelFor, trustedSources, type Label } from "../server/safety/council/calibration";
import { lowerBound, upperBound } from "../server/bounds";
import { claimsIn, isCheck, loopIn, outsideScope, turnFacts } from "../server/safety/council/facts";
import { snapshot } from "../server/safety/council/git";
import { SafetyStore } from "../server/safety/store";

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
  assert.ok(
    isCheck("cd app && npx vitest run", []) && isCheck("./scripts/acceptance.sh --fast", ["./scripts/acceptance.sh"]),
  );
  assert.ok(!isCheck("git status", []));
  assert.deepEqual(
    quotedCommands(
      '`npm test` passes; `parseDuration("2h") === 7200000`; edit `src/a.js`; run `./scripts/check.sh --fast`, `make`',
    ),
    ["npm test", "./scripts/check.sh --fast", "make"],
  );

  const facts = turnFacts([shell("npm test"), change("src/a.js"), shell("npm test", 1), shell("git diff")], []);
  assert.deepEqual(
    [facts.lastChange, facts.changed, facts.checksAfterChange],
    [1, ["src/a.js"], [{ command: "npm test", exitCode: 1 }]],
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

let homes = 0;
/** A council over its own store; `answer` stands in for the decision district. */
function councilWith(levels: CouncilPolicy["levels"] = {}, answer?: (state: Record<string, unknown>) => number) {
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
    { member: "scope", readings: 1, found: 1, grey: 0, shown: 0 },
    { member: "stuck", readings: 1, found: 0, grey: 0, shown: 0 },
  ]);
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
});

test("a juror is asked only where the facts cannot tell, and its grey band keeps it quiet", async () => {
  const probability = { value: 0.95 };
  const { council, asked, readings } = councilWith({ claims: 1 }, () => probability.value);
  const report = "CANDIDATE: hours added; the parser handles 2h and 90m as asked.";
  const found = await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], report, null));
  assert.deepEqual([asked.length, found.length], [1, 1]);
  assert.match(found[0].line, /^claims #\d+: the report reads as tested \(0\.95\)/);
  assert.equal((asked[0] as { report: string }).report, report);

  probability.value = 0.5;
  assert.deepEqual(await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], report, null)), []);
  await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], "STATUS: still parsing", null));
  assert.equal(asked.length, 2, "a report that closes no work is not asked about");
  assert.deepEqual(readings()[0], { member: "claims", readings: 3, found: 1, grey: 1, shown: 1 });
});

test("a Lead's verdicts are read against the work: an acceptance without its check, a task sent back again and again", async () => {
  const { council } = councilWith({ verdict: 1, repair: 1 });
  const lead = (events: TurnEvent[], verdicts: TurnInput["verdicts"]): TurnInput => ({
    seat: { id: "lead-1", role: "lead", traits: traits("lead"), root: ROOT, task: "lead-1" },
    turn: `t${events.length}`,
    events,
    text: "ACCEPT",
    brief: null,
    verdicts,
  });
  const work = { to: "peer-1", brief: BRIEF, task: "peer-1", rejected: 0, contextTokens: 400_000, costUsd: 9.5 };
  const unchecked = await council.endOfTurn(lead([shell("git diff")], [{ ...work, accepted: true }]));
  assert.match(
    unchecked[0].line,
    /^verdict #\d+: accepted peer-1's work without running its acceptance check "npm test"$/,
  );
  assert.deepEqual(await council.endOfTurn(lead([shell("npm test -- --run")], [{ ...work, accepted: true }])), []);

  assert.deepEqual(await council.endOfTurn(lead([], [{ ...work, accepted: false, rejected: 2 }])), []);
  const third = await council.endOfTurn(lead([shell("ls")], [{ ...work, accepted: false, rejected: 3 }]));
  assert.match(
    third[0].line,
    /^repair #\d+: peer-1's work was sent back 3 times; its context holds 400K tokens, it cost 9\.50 USD/,
  );
});

test("a running turn is mailed about only for a loop or a silence, and only by a member at the mailing level", () => {
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
});

test("the council's log keeps what a label holds and lets the rest go; every statement uses an index", () => {
  const { council, store } = councilWith();
  const id = store.read({
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
  });
  store.read({
    ...{ member: "scope", version: 1, seat: "s", role: null, task: null, turn: null },
    tier: "fact",
    zone: "clear",
    score: null,
    askId: null,
    level: 0,
    shown: false,
    fingerprint: null,
    evidence: null,
  });
  assert.ok(store.labelReading(id, "owner", "right"));
  store.shownBefore("s", "claims", "f");
  store.readBefore("s", "claims", "f");
  store.readingSeat(id);
  store.openFinding("claims", "s", "implied:acceptance-run");
  store.openFinding("repair", "s", "implied:next-verdict", "task:", "t1");
  store.labelsOf("claims", 1, 10);
  store.labelCount("claims", 1);
  store.setMemberState({ member: "claims", version: 1, level: 0, hi: 0.9, labels: 1 });
  store.memberState("claims");
  council.counts(30);
  assert.equal(store.expireCouncil(new Date(Date.now() + 86_400_000)), 1);
  assert.deepEqual(
    store.councilCounts("2000-01-01").map(({ member, right }) => [member, right]),
    [["claims", 1]],
  );
  const scans = store
    .plans()
    .filter(({ sql }) => /council_/.test(sql))
    .filter(({ plan }) => /\bSCAN (council_readings|council_labels|r|l)\b(?! USING)/.test(plan));
  assert.deepEqual(scans, []);
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
  const agreeing = [...right(10), ...Array.from({ length: 10 }, (_, i) => implied(i, "right"))];
  assert.ok(trustedSources(agreeing).has("implied:acceptance-run"));
  const disagreeing = [...right(10), ...Array.from({ length: 10 }, (_, i) => implied(i, i < 6 ? "right" : "wrong"))];
  assert.equal(trustedSources(disagreeing).size, 0);
  assert.equal(
    counted([...right(3), implied(50, "right")]).length,
    3,
    "an implied source no seat has checked does not count",
  );

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
  await council.endOfTurn(peerTurn([change(`${ROOT}/src/duration.js`)], "CANDIDATE: hours added\nAll tests pass."));
  await council.endOfTurn({
    seat: { id: "lead-1", role: "lead", traits: traits("lead"), root: ROOT, task: "lead-1" },
    turn: "lt1",
    events: [shell("npm test", 1, "1 failing")],
    text: "REJECT",
    brief: null,
    verdicts: [
      { to: "peer-1", accepted: false, brief: BRIEF, task: "peer-1", rejected: 1, contextTokens: null, costUsd: null },
    ],
  });
  assert.deepEqual(
    store.labelsOf("claims", 1, 10).map(({ source, value }) => [source, value]),
    [["implied:acceptance-run", "right"]],
  );
  assert.equal(council.level("claims"), 0, "an implied source no seat has checked moves nothing");
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
  // as `sed -i` and `echo >` would: no edit tool call for either file
  writeFileSync(join(repo, "README.md"), "changed by a shell\n");
  writeFileSync(join(repo, "src", "duration.js"), "2\n");
  const tree = await council.changedIn(seat.id);
  assert.deepEqual([tree?.root, tree?.files.sort()], [realpathSync(repo), ["README.md", "src/duration.js"]]);
  const found = await council.endOfTurn({
    ...peerTurn([shell("sed -i '' s/x/y/ README.md")], "STATUS: working"),
    seat: { ...seat, root: tree!.root },
    changed: tree!.files,
  });
  assert.match(found[0].line, /^scope #\d+: changed README\.md, outside the write scope/);
});
