import { PROJECT } from "./support/room";
import { background, bash, BRIEF, claudeFailure, edit, ended, mail, prompt, read, say, skill } from "./support/watch";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { missingLines, namedChecks, parseBrief } from "../server/watch/brief";
import { readSummary } from "../server/watch/checks";
import { toEvents, turnStartOf, type TimelineInput } from "../server/watch/events";
import { turnFacts } from "../server/watch/facts";
import { gate, type RuleId } from "../server/watch/rules";
import { matchesPattern, parseWriteScope } from "../server/watch/scope";

const brief = parseBrief(BRIEF, PROJECT);
const THRESHOLDS = {
  sleepSeconds: 60,
  repeatRun: 4,
  cycleRepeats: 3,
  sameFailure: 4,
  silentMinutes: 6,
  inFlightMinutes: 18,
};

function read_(
  entries: TimelineInput[],
  options: {
    ended?: boolean;
    changed?: string[];
    brief?: typeof brief | null;
    later?: string[];
    startedAt?: number;
  } = {},
) {
  const events = toEvents(entries, PROJECT);
  return turnFacts({
    events,
    turnStart: turnStartOf(entries, events, "turn-1"),
    cwd: PROJECT,
    root: PROJECT,
    brief: options.brief === undefined ? brief : options.brief,
    ended: options.ended ?? true,
    changed: options.changed ?? null,
    later: options.later,
    startedAt: options.startedAt,
  });
}

function rulesOf(
  entries: TimelineInput[],
  options: Parameters<typeof read_>[1] & { now?: number; pendingPermission?: boolean } = {},
): { told: RuleId[]; asked: RuleId[] } {
  const facts = read_(entries, options);
  const result = gate({
    facts,
    brief: options.brief === undefined ? brief : options.brief,
    moment: options.ended === false ? "live" : "end",
    briefGap: null,
    now: options.now ?? facts.lastActivity ?? 0,
    pendingPermission: options.pendingPermission ?? false,
    thresholds: THRESHOLDS,
  });
  return { told: result.findings.map((f) => f.rule), asked: result.questions.map((q) => q.rule) };
}

const src = (file: string) => join(PROJECT, file);

test("a scope line is read leniently: directories, bare names and globs all admit what a Lead plainly meant", () => {
  const scope = parseWriteScope("`src/web/state.ts`, src/web/realtime/**, docs/ and README.md", PROJECT)!;
  assert.deepEqual(scope.patterns, ["src/web/state.ts", "src/web/realtime/**", "docs", "README.md"]);
  for (const path of ["src/web/state.ts", "src/web/realtime/a/b.ts", "docs/guide/x.md", "README.md"])
    assert.ok(
      scope.patterns.some((p) => matchesPattern(p, path)),
      path,
    );
  for (const path of ["src/web/other.ts", "src/server/realtime/x.ts", "package.json"])
    assert.ok(!scope.patterns.some((p) => matchesPattern(p, path)), path);
  assert.ok(matchesPattern("src/{web,server}/**/*.test.ts", "src/server/a/b.test.ts"));
  assert.ok(matchesPattern("*.md", "docs/deep/notes.md"));
  assert.equal(parseWriteScope("the whole repository, as agreed", PROJECT), null);
  assert.equal(parseWriteScope("read-only — do not modify files", PROJECT)?.readOnly, true);
});

test("the room's own brief template parses", () => {
  const template = readFileSync(
    join(__dirname, "..", "room", "skills", "lead", "write-brief", "references", "brief-template.md"),
    "utf8",
  );
  const example = template.slice(
    template.indexOf("Project: /work/echo"),
    template.indexOf("```", template.indexOf("Project: /work/echo")),
  );
  const parsed = parseBrief(example, "/work/echo");
  assert.deepEqual(parsed.scope?.patterns, ["src/web/state.ts", "src/web/realtime/**", "src/server/realtime/**"]);
  assert.match(parsed.fields.reopenWhen ?? "", /cannot meet 300 ms/);
  assert.ok(parsed.namedChecks.includes("reconnect.test.ts"));
});

test("a brief is held to five lines, however its labels are dressed; one in free prose lacks them all", () => {
  const without = (label: string) =>
    BRIEF.split("\n")
      .filter((line) => !line.startsWith(label))
      .join("\n");
  assert.deepEqual(missingLines(brief), []);
  assert.deepEqual(missingLines(parseBrief(without("Reopen when"), PROJECT)), ["Reopen when"]);
  assert.deepEqual(missingLines(parseBrief(without("Write scope"), PROJECT)), ["Write scope"]);
  assert.deepEqual(missingLines(parseBrief(BRIEF.replace(/Acceptance evidence:.*/, "Acceptance evidence:"), PROJECT)), [
    "Acceptance evidence",
  ]);
  // the last line reworded is the last line gone: measured, a Peer then stops asking and guesses
  assert.deepEqual(missingLines(parseBrief(without("Reply with"), PROJECT)), ["Reply with seatwork_mail to: owner"]);
  assert.deepEqual(
    missingLines(parseBrief(BRIEF.replace("seatwork_mail to: owner", "seatwork_mail to: whoever asked"), PROJECT)),
    ["Reply with seatwork_mail to: owner"],
  );
  const dressed = BRIEF.split("\n")
    .map((line) => `- **${line.replace(": ", ":** ")}`)
    .join("\n");
  assert.deepEqual(missingLines(parseBrief(dressed, PROJECT)), []);
  assert.deepEqual(
    missingLines(
      parseBrief(BRIEF.replace("Reply with seatwork_mail to: owner", "`Reply with seatwork_mail to: owner`"), PROJECT),
    ),
    [],
  );
  assert.deepEqual(missingLines(parseBrief("Make the duration parser better.", PROJECT)), [
    "Outcome",
    "Write scope",
    "Acceptance evidence",
    "Reopen when",
    "Reply with seatwork_mail to: owner",
  ]);
  // the eval's own vague brief: a project, a sentence and the last line
  assert.deepEqual(
    missingLines(
      parseBrief("Project: /work/echo\nMake the duration parser better.\nReply with seatwork_mail to: owner", PROJECT),
    ),
    ["Outcome", "Write scope", "Acceptance evidence", "Reopen when"],
  );
  // the gate tells it from the turn's start on
  const facts = read_([prompt(without("Reopen when"))], { ended: false });
  assert.deepEqual(
    gate({
      facts,
      brief,
      moment: "start",
      briefGap: { lines: ["Reopen when"] },
      now: 0,
      pendingPermission: false,
      thresholds: THRESHOLDS,
    }).findings.map((f) => [f.rule, f.evidence]),
    [["incomplete-brief", "was briefed without these template lines: Reopen when"]],
  );
});

test("the tests stand behind the work only when they passed after the last change to source", () => {
  const passing = { output: "ℹ pass 14\nℹ fail 0" };
  const cases: [string, TimelineInput[], string][] = [
    ["edit then green run", [edit(src("src/duration.js")), bash("npm test", passing)], "passed"],
    ["green run then edit", [bash("npm test", passing), edit(src("src/duration.js"))], "none"],
    [
      "edit then red run",
      [edit(src("src/duration.js")), bash("npm test", { fails: true, output: "1 failing" })],
      "failed",
    ],
    [
      "status hidden by a pipe, summary read",
      [edit(src("src/duration.js")), bash("npm test 2>&1 | tail -3", passing)],
      "passed",
    ],
    [
      "status hidden, nothing to read",
      [edit(src("src/duration.js")), bash("npm test; git status", { output: "M src/duration.js" })],
      "unknown",
    ],
    [
      "a doc edited after the run does not unmake it",
      [edit(src("src/duration.js")), bash("npm test", passing), edit(src("README.md"))],
      "passed",
    ],
    [
      "a shell write counts as a change",
      [bash("npm test", passing), bash("sed -i '' 's/a/b/' src/duration.js")],
      "none",
    ],
    ["edit and check in one line", [bash("sed -i '' 's/a/b/' src/duration.js && npm test", passing)], "passed"],
    [
      "a log the run wrote is not a change to source",
      [edit(src("src/duration.js")), bash("npm test > out.log 2>&1; tail -3 out.log", passing)],
      "passed",
    ],
    ["only a typecheck ran", [edit(src("src/duration.js")), bash("npx tsc --noEmit")], "none"],
    [
      "the brief's own check counts as a test",
      [edit(src("src/duration.js")), bash("node -e 'require(\"./src/duration\")'"), bash("npm test")],
      "passed",
    ],
  ];
  for (const [name, entries, expected] of cases)
    assert.equal(read_([prompt(BRIEF), ...entries, say("CANDIDATE: done")]).tests, expected, name);
  assert.equal(
    read_([prompt(BRIEF), edit(src("src/duration.js")), bash("npx tsc --noEmit"), say("CANDIDATE")]).statics,
    "passed",
  );
});

test("only a quoted check command is a check the brief names: not a branch, a path, a status command or a line of output", () => {
  const proof =
    '1. `npm test` passes. 2. `./tools/gate.sh --fast` is green; reconnect.test.ts covers it. 3. `git status --short` shows only `.seatwork/` untracked on `v2`; the line is `{"type":"unbilled","amount":0}`, marked `TEMPORARY: G1`.';
  assert.deepEqual(namedChecks(proof), ["npm test", "./tools/gate.sh --fast", "reconnect.test.ts"]);
});

test("several test runs in one command: the last one's summary decides, whatever a run before it printed", () => {
  // a Peer killing a mutant in one call: green, a run meant to fail, the restore, green again
  const mutant =
    "sed -i '' 's/a/b/' test/duration.test.js\nnpm test 2>&1 | grep -E '✖|ℹ (pass|fail)'\npython3 mutate.py\nnpm test 2>&1 | grep -E '✖|ℹ (pass|fail)'\ngit checkout src/duration.js\nnpm test 2>&1 | grep -E '✖|ℹ (pass|fail)'";
  const green = "ℹ pass 63\nℹ fail 0";
  const red = "✖ rounds half up\nℹ pass 62\nℹ fail 1\n✖ failing tests:";
  const turn = (output: string) =>
    read_([prompt(BRIEF), bash(mutant, { output }), say("CANDIDATE: the mutant is caught; npm test: 63 pass")]);
  assert.equal(turn(`${green}\n${red}\nUpdated 1 path from the index\n${green}`).tests, "passed");
  assert.equal(turn(`${green}\n${green}\nUpdated 1 path from the index\n${red}`).tests, "failed");
  assert.equal(turn("Updated 1 path from the index").tests, "unknown");
});

test("a runner's summary outranks an error word in the output", () => {
  assert.equal(readSummary("✔ refuses units that are not a number: TypeError\nℹ pass 12\nℹ fail 0"), "passed");
  assert.equal(readSummary("ℹ pass 11\nℹ fail 1"), "failed");
  // three runs in a loop, their summaries joined on one line by `tr`
  assert.equal(readSummary("ℹ tests 87 ℹ pass 87 ℹ fail 0 \nℹ tests 87 ℹ pass 87 ℹ fail 0 "), "passed");
  assert.equal(readSummary("ℹ pass 5 ℹ fail 0 ℹ pass 5 ℹ fail 0 ℹ pass 4 ℹ fail 1 "), "failed");
  assert.equal(readSummary("src/a.ts(3,1): error TS2304: Cannot find name 'x'."), "failed");
  assert.equal(readSummary("done"), "unknown");
});

test("a change only git saw is placed at the last command the watcher could not read", () => {
  const script = "python3 - <<'E'\nopen('src/duration.js','w').write('x')\nE";
  const changed = ["src/duration.js"];
  assert.equal(read_([prompt(BRIEF), bash(`${script}\nnpm test`), say("CANDIDATE")], { changed }).tests, "passed");
  assert.equal(read_([prompt(BRIEF), bash("npm test"), bash(script), say("CANDIDATE")], { changed }).tests, "none");
  assert.equal(
    read_([prompt(BRIEF), bash("npm test"), bash(script), say("CANDIDATE")]).lastEdit,
    undefined,
    "without git the write is unseen",
  );
});

test("evidence from an earlier turn still counts, and a later turn's edit unmakes it", () => {
  const first = [
    prompt(BRIEF, "turn-0"),
    edit(src("src/duration.js"), "turn-0"),
    bash("npm test", {}, "turn-0"),
    say("QUESTION: which unit?", "turn-0"),
  ];
  assert.equal(read_([...first, prompt("ANSWER: hours"), say("CANDIDATE: done")]).tests, "passed");
  assert.equal(
    read_([...first, prompt("ANSWER: hours"), edit(src("src/duration.js")), say("CANDIDATE: done")]).tests,
    "none",
  );
});

test("writing outside the write scope is told from the paths, whichever tool wrote", () => {
  assert.deepEqual(
    rulesOf([
      prompt(BRIEF),
      edit(src("src/duration.js")),
      edit(src("test/duration.test.js")),
      bash("npm test"),
      say("CANDIDATE"),
    ]).told,
    [],
  );
  assert.deepEqual(rulesOf([prompt(BRIEF), edit(src("src/other.js")), bash("npm test"), say("CANDIDATE")]).told, [
    "outside-scope",
  ]);
  assert.deepEqual(
    rulesOf([prompt(BRIEF), bash("printf 'x' > package.json"), bash("npm test"), say("CANDIDATE")]).told,
    ["outside-scope"],
  );
  // git is the ground truth at the end of a turn: a script wrote a file no tool call names
  assert.deepEqual(
    read_([prompt(BRIEF), bash("node tools/gen.js"), say("CANDIDATE")], {
      changed: ["src/generated.js", "node_modules/x/y.js"],
    }).outsideScope,
    ["src/generated.js"],
  );
  // the room's own notes and temporary files are nobody's scope
  assert.deepEqual(
    rulesOf([prompt(BRIEF), edit(src(".seatwork/status.md")), edit("/tmp/scratch.txt"), say("STATUS")]).told,
    [],
  );
  const review = parseBrief(BRIEF.replace(/Write scope:.*/, "Write scope: read-only — do not modify files"), PROJECT);
  assert.deepEqual(
    rulesOf([prompt(BRIEF), edit(src("src/duration.js")), say("REVIEW\nNOT YET")], { brief: review }).told,
    ["outside-scope"],
  );
});

test("a scope line can take a path back out, and a file the seat above names later is one it asked about", () => {
  const scope = parseWriteScope(
    "bin/**, src/** except src/legacy/**, test/**, data/**, README.md (only lines that v2 makes false). Nothing else.",
    PROJECT,
  )!;
  assert.deepEqual(
    [scope.patterns, scope.except],
    [["bin/**", "src/**", "test/**", "data/**", "README.md"], ["src/legacy/**"]],
  );
  const scoped = parseBrief(
    BRIEF.replace(
      /Write scope:.*/,
      "Write scope: src/** except for the src/legacy/** files, test/** (not yet there) and README.md",
    ),
    PROJECT,
  );
  assert.deepEqual(
    [scoped.scope!.patterns, scoped.scope!.except],
    [["src/**", "test/**", "README.md"], ["src/legacy/**"]],
  );
  assert.deepEqual(rulesOf([prompt(BRIEF), edit(src("src/legacy/month.js")), say("STATUS")], { brief: scoped }).told, [
    "outside-scope",
  ]);
  assert.deepEqual(
    rulesOf([prompt(BRIEF), edit(src("src/duration.js")), edit(src("README.md")), say("STATUS")], { brief: scoped })
      .told,
    [],
  );

  // a repair the Lead asked for by mail, in a file its brief did not list
  const ignored = [prompt(BRIEF), edit(src(".gitignore")), say("STATUS")];
  assert.deepEqual(rulesOf(ignored).told, ["outside-scope"]);
  assert.deepEqual(
    rulesOf(ignored, {
      later: ["REJECT d78: `.gitignore` lists only node_modules/. The lock files must be ignored by git."],
    }).told,
    [],
  );
  assert.deepEqual(rulesOf(ignored, { later: ["ANSWER: keep going. Do not touch .gitignore."] }).told, [
    "outside-scope",
  ]);
});

test("a check whose output went into a file says nothing on the line, unless the line prints the file back", () => {
  const work = [prompt(BRIEF), edit(src("src/duration.js"))];
  const table = "88\n0\nR14 | one error: an unknown customer ends with status 2";
  assert.equal(
    read_([
      ...work,
      bash(
        "node --test --test-reporter=tap 2>/dev/null | grep -E '^(not )?ok ' > /tmp/tap.txt; grep -c '^ok' /tmp/tap.txt; grep -c '^not ok' /tmp/tap.txt; cat names.txt",
        { output: table },
      ),
      say("DONE"),
    ]).tests,
    "unknown",
  );
  assert.equal(
    read_([
      ...work,
      bash("npm test > /tmp/out.txt 2>&1; tail -5 /tmp/out.txt", { output: "ℹ pass 5\nℹ fail 0" }),
      say("DONE"),
    ]).tests,
    "passed",
  );
  assert.equal(
    read_([...work, bash("npm test 2>/dev/null | tail -3", { output: "ℹ pass 5\nℹ fail 0" }), say("DONE")]).tests,
    "passed",
  );
  assert.equal(
    read_([...work, bash("npm test 2>errors.log | tail -3", { output: "ℹ pass 4\nℹ fail 1" }), say("DONE")]).tests,
    "failed",
  );
});

test("a seat may delete what its brief gave it; history rewrites and sweeping deletes are told", () => {
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("rm -rf test/fixtures/old"), say("STATUS")]).told, []);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("rm -rf node_modules && npm ci"), say("STATUS")]).told, []);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("rm -rf src"), say("STATUS")]).told, ["irreversible", "outside-scope"]);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("cd test && rm -rf ."), say("STATUS")]).told, ["irreversible"]);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("git reset --hard origin/main"), say("STATUS")]).told, [
    "irreversible",
  ]);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash('git commit -m "remove the rm -rf step"'), say("STATUS")]).told, []);
  // a find that picks files by a test is the seat's own inside its project; one that takes all is not
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("find . -name '*.snap' -delete"), say("STATUS")]).told, []);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("find . -mindepth 1 -delete"), say("STATUS")]).told, ["irreversible"]);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("find /srv/data -name '*.db' -delete"), say("STATUS")]).told, [
    "irreversible",
  ]);
});

test("going on after asking to reopen the brief is told", () => {
  assert.deepEqual(
    rulesOf([
      prompt(BRIEF),
      mail("REOPEN_REQUEST: hours need a parser"),
      edit(src("src/duration.js")),
      say("REOPEN_REQUEST"),
    ]).told,
    ["edit-after-reopen"],
  );
  assert.deepEqual(
    rulesOf([
      prompt(BRIEF),
      edit(src("src/duration.js")),
      mail("REOPEN_REQUEST: hours need a parser"),
      say("REOPEN_REQUEST"),
    ]).told,
    [],
  );
});

test("circles are told: the same action again, a pattern again, the same failure again", () => {
  const failing = { fails: true, output: "AssertionError: expected 7200000\n1 failing" };
  const same = [
    prompt(BRIEF),
    ...Array.from({ length: 4 }, () =>
      bash("curl -s localhost:3000/health", { fails: true, output: "connection refused" }),
    ),
  ];
  assert.deepEqual(rulesOf(same, { ended: false }).told, ["repeating"]);
  const pattern = [
    prompt(BRIEF),
    ...Array.from({ length: 3 }, () => [bash("git stash"), bash("git stash pop")]).flat(),
  ];
  assert.deepEqual(rulesOf(pattern, { ended: false }).told, ["repeating"]);
  const stuck = [
    prompt(BRIEF),
    ...Array.from({ length: 4 }, () => [edit(src("src/duration.js")), bash("npm test", failing)]).flat(),
  ];
  assert.deepEqual(rulesOf(stuck, { ended: false }).told, ["same-failure"]);
  // ordinary work: edits with a test that fails differently each time, reads in between
  const working = [
    prompt(BRIEF),
    edit(src("src/duration.js")),
    bash("npm test", { fails: true, output: "expected 1 got 2" }),
    read(src("src/duration.js")),
    edit(src("src/duration.js")),
    bash("npm test", { fails: true, output: "expected hours" }),
    edit(src("src/duration.js")),
    bash("npm test"),
  ];
  assert.deepEqual(rulesOf(working, { ended: false }).told, []);
});

test("waiting in the shell is told by the clock; a short pause, a refused sleep and a background one are not", () => {
  const loop = "until gh run view 7 | grep -q completed; do sleep 20; done";
  assert.deepEqual(
    rulesOf([prompt(BRIEF), bash("npm start & sleep 3 && curl -s localhost:3000")], { ended: false }).told,
    [],
  );
  assert.deepEqual(
    rulesOf([prompt(BRIEF), bash("sleep 45", { took: 45 }), bash("sleep 45", { took: 45 })], { ended: false }).told,
    ["shell-wait"],
  );
  assert.deepEqual(rulesOf([prompt(BRIEF), bash(loop, { took: 90 })], { ended: false }).told, ["shell-wait"]);
  assert.deepEqual(
    rulesOf([prompt(BRIEF), bash(loop, { took: 8 })], { ended: false }).told,
    [],
    "a loop that was over in seconds",
  );
  // in flight: a plain sleep will take what it says; a loop has taken what the clock shows
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("sleep 300", { running: true })], { ended: false }).told, [
    "shell-wait",
  ]);
  const running = [prompt(BRIEF), bash(loop, { running: true })];
  const started = toEvents(running, PROJECT).at(-1)!.at!;
  const live = (seconds: number) =>
    gate({
      facts: turnFacts({
        events: toEvents(running, PROJECT),
        turnStart: 1,
        cwd: PROJECT,
        root: PROJECT,
        brief,
        ended: false,
        changed: null,
        now: started + seconds * 1000,
      }),
      brief,
      moment: "live",
      briefGap: null,
      now: started + seconds * 1000,
      pendingPermission: false,
      thresholds: THRESHOLDS,
    }).findings.map((f) => f.rule);
  assert.deepEqual(live(20), []);
  assert.deepEqual(live(70), ["shell-wait"]);
  // Claude turns a standalone sleep down and the seat backgrounds it: neither holds the turn
  const refused = claudeFailure(
    "sleep 75",
    "<tool_use_error>Blocked: standalone sleep 75. To wait for a condition, use Monitor.</tool_use_error>",
  );
  assert.deepEqual(rulesOf([prompt(BRIEF), refused, background("sleep 75", "b1")], { ended: false }).told, []);
});

test("a failed call is read as Claude reports it, and a background check counts once the harness says how it ended", () => {
  const failed = toEvents([claudeFailure("npm test", "Exit code 1\n✖ parses hours\nℹ fail 1")], PROJECT)[0];
  assert.deepEqual(
    [failed.kind === "shell" && failed.exitCode, failed.kind === "shell" && failed.output],
    [1, "✖ parses hours\nℹ fail 1"],
  );
  const work = [prompt(BRIEF), edit(src("src/duration.js"))];
  assert.equal(read_([...work, background("npm test", "b1"), say("CANDIDATE")]).tests, "unknown");
  assert.equal(read_([...work, background("npm test", "b1"), ended("b1", 0), say("CANDIDATE")]).tests, "passed");
  assert.equal(read_([...work, background("npm test", "b1"), ended("b1", 1), say("CANDIDATE")]).tests, "failed");
  // a call the harness refused ran nothing
  assert.equal(
    read_([...work, claudeFailure("npm test", "<tool_use_error>Blocked</tool_use_error>"), say("CANDIDATE")]).tests,
    "none",
  );
});

test("silence is counted from the start of the turn, not from what an earlier turn did last", () => {
  const history = [
    prompt(BRIEF, "turn-0"),
    bash("ls", {}, "turn-0"),
    say("QUESTION: which unit?", "turn-0"),
    prompt("ANSWER: hours"),
  ];
  const before = toEvents(history, PROJECT).at(-1)!.at!;
  const startedAt = before + 9 * 60_000;
  assert.deepEqual(rulesOf(history, { ended: false, startedAt, now: startedAt + 10_000 }).told, []);
  assert.deepEqual(rulesOf(history, { ended: false, startedAt, now: startedAt + 7 * 60_000 }).told, ["silent"]);
});

test("silence is told only while nothing explains it", () => {
  const quiet = [prompt(BRIEF), bash("ls")];
  const last = toEvents(quiet, PROJECT).at(-1)!.at!;
  assert.deepEqual(rulesOf(quiet, { ended: false, now: last + 5 * 60_000 }).told, []);
  assert.deepEqual(rulesOf(quiet, { ended: false, now: last + 7 * 60_000 }).told, ["silent"]);
  assert.deepEqual(rulesOf(quiet, { ended: false, now: last + 7 * 60_000, pendingPermission: true }).told, []);
  const running = [prompt(BRIEF), bash("npm run e2e", { running: true })];
  const started = toEvents(running, PROJECT).at(-1)!.at!;
  assert.deepEqual(rulesOf(running, { ended: false, now: started + 10 * 60_000 }).told, []);
  assert.deepEqual(rulesOf(running, { ended: false, now: started + 19 * 60_000 }).told, ["silent"]);
});

test("a question is opened only where its answer could matter", () => {
  const work = [prompt(BRIEF), edit(src("src/duration.js"))];
  // finished work, tests not behind it: what the message claims decides
  assert.deepEqual(rulesOf([...work, say("CANDIDATE: hours added. npm test: 14 passing.")]).asked, [
    "unverified-completion",
    "reopen-condition",
  ]);
  // the tests passed after the last change: nothing to ask about them
  assert.deepEqual(rulesOf([...work, bash("npm test"), say("CANDIDATE: hours added. npm test: 14 passing.")]).asked, [
    "reopen-condition",
  ]);
  // the message says nothing of checks: no reader is needed to know that
  assert.deepEqual(rulesOf([...work, say("CANDIDATE: hours added in src/duration.js.")]).asked, ["reopen-condition"]);
  // not handing work over: nothing is claimed yet
  assert.deepEqual(rulesOf([...work, say("QUESTION: should minutes round up?")]).asked, []);
  assert.deepEqual(rulesOf([...work, bash("npm test"), bash("git push origin feat"), say("STATUS: pushed")]).asked, [
    "external-action",
  ]);
  // a push that failed left nothing outside this machine
  assert.deepEqual(
    rulesOf([
      ...work,
      bash("npm test"),
      claudeFailure("git push origin feat", "Exit code 128\nfatal: 'origin' does not appear to be a git repository"),
      say("STATUS: push failed"),
    ]).asked,
    [],
  );
  assert.deepEqual(
    rulesOf([...work, bash("npm test"), say("CANDIDATE: I decided to return null instead of throwing.")]).asked,
    ["reopen-condition"],
  );
});

test("a review that accepts without running anything is told", () => {
  const review = parseBrief(BRIEF.replace(/Write scope:.*/, "Write scope: read-only — do not modify files"), PROJECT);
  assert.deepEqual(
    rulesOf([prompt(BRIEF), read(src("src/duration.js")), say("REVIEW\nVerdict: ACCEPTABLE")], { brief: review }).told,
    ["review-without-check"],
  );
  assert.deepEqual(
    rulesOf([prompt(BRIEF), bash("npm test"), say("REVIEW\nVerdict: ACCEPTABLE")], { brief: review }).told,
    [],
  );
  assert.deepEqual(
    rulesOf([prompt(BRIEF), read(src("src/duration.js")), say("REVIEW\nNOT YET — not verified: npm test")], {
      brief: review,
    }).told,
    [],
  );
});

test("a nested shell's cd ends with it: what the line writes afterwards is placed where the line stands", () => {
  const line = `cd ${PROJECT}; mkdir -p test/probe\nenv -i /bin/bash -c 'cd /; ./check' > /tmp/null 2>&1 || true\n(cd / && ls)\nrm -rf test/probe\nmv test/a.js test/b.js`;
  const facts = read_([prompt(BRIEF), bash(line), say("STATUS")]);
  assert.deepEqual(facts.outsideProject, []);
  assert.deepEqual(facts.destroyed, []);
});

test("a seat removes what it made in the same turn; a pattern in a shared temporary directory is told", () => {
  // outside its scope it should not have written, but the delete took nothing that was there before
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("mkdir -p docs/probe && rm -rf docs/probe"), say("STATUS")]).told, [
    "outside-scope",
  ]);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("rm -rf docs/probe"), say("STATUS")]).told, [
    "irreversible",
    "outside-scope",
  ]);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("rm -rf /tmp/duration-run-1"), say("STATUS")]).told, []);
  assert.deepEqual(rulesOf([prompt(BRIEF), bash("rm -rf /tmp/duration-*"), say("STATUS")]).told, ["irreversible"]);
});

test("a candidate that changed tests that were already there says which, or its Owner is told", () => {
  const work = [prompt(BRIEF), edit(src("src/duration.js")), bash("npm test")];
  const changedTests = ["test/duration.test.js"];
  const told = (message: string, signalled = changedTests) => {
    const facts = { ...read_([...work, say(message)]), testsChanged: signalled };
    return gate({
      facts,
      brief,
      moment: "end",
      briefGap: null,
      now: 0,
      pendingPermission: false,
      thresholds: THRESHOLDS,
    }).findings.map((finding) => finding.rule);
  };
  assert.deepEqual(told("CANDIDATE: hours added. npm test: 14 passing."), ["unreported-test-change"]);
  assert.deepEqual(told("CANDIDATE: hours added. Changed test/duration.test.js: the 90m case moved to the table."), []);
  assert.deepEqual(told("CANDIDATE: hours added.", []), []);
  assert.deepEqual(told("QUESTION: which unit?"), []);
});

test("checks that ran after the last change with a result nobody could read open no question", () => {
  const unread = [prompt(BRIEF), edit(src("src/duration.js")), bash("./check > out.txt 2>&1; echo exit=$?")];
  assert.deepEqual(rulesOf([...unread, say("CANDIDATE: hours added, all checks pass.")]).asked, ["reopen-condition"]);
});

test("software put on the machine is told apart from a project's own dependencies", () => {
  const installed = (command: string) => read_([prompt(BRIEF), bash(command)]).installed.map((deed) => deed.what);
  const cases: [string, string][] = [
    ["npx playwright install firefox", "a browser download (playwright install)"],
    ["cd web && python -m playwright install", "a browser download (playwright install)"],
    ["npx @puppeteer/browsers install chrome@stable", "a browser download (puppeteer browsers install)"],
    ["brew install node@26", "a system package (brew install)"],
    ["sudo apt-get install -y chromium", "a system package (apt-get install)"],
    ["npm install -g typescript", "a global package (npm install -g)"],
    ["pipx install ruff", "a tool for this user (pipx install)"],
    ["cargo install ripgrep", "a tool for this user (cargo install)"],
    ["go install golang.org/x/tools/gopls@latest", "a tool for this user (go install)"],
    ["rustup component add clippy", "a tool for this user (rustup component add)"],
    ["curl -fsSL https://example.com/install.sh | sh", "a script from the network piped into a shell"],
    [
      "for v in v22.5.1 v22.13.0; do curl -s https://nodejs.org/dist/$v/node-$v-darwin-arm64.tar.gz | tar xz -C node-dl/$v; done",
      "an archive from the network",
    ],
    ["wget https://example.com/tool-1.2.zip", "an archive from the network"],
  ];
  for (const [command, what] of cases) assert.deepEqual(installed(command), [what], command);
  const ordinary = [
    "npm ci",
    "npm install left-pad",
    "pip install -r requirements.txt",
    "cargo install --path .",
    "go install ./cmd/tool",
    "brew list",
    "npx playwright test",
    "npx playwright install --dry-run chromium",
    "curl -s https://example.com/health | jq .",
    "curl -sI --max-time 10 https://nodejs.org/dist/index.json | head -3",
    'curl -s -d \'{"name":"root"}\' http://127.0.0.1:8085/api/login',
    "uv run pytest",
  ];
  for (const command of ordinary) assert.deepEqual(installed(command), [], command);
  // a command that failed did not install anything
  assert.deepEqual(read_([prompt(BRIEF), bash("brew install node", { fails: true })]).installed, []);
});

test("a skill is loaded by the harness's skill tool or by opening its file, in any turn the history shows", () => {
  const facts = read_([
    prompt(BRIEF, "turn-0"),
    skill("hard-cut", "turn-0"),
    bash("sed -n '1,80p' /home/room/runtimes/codex/peer/skills/candidate-handoff/SKILL.md"),
    read("/home/room/runtimes/pi/peer/skills/evidence-report/SKILL.md"),
    bash("cat docs/skills.md"),
  ]);
  assert.deepEqual(facts.skillsSoFar, ["candidate-handoff", "evidence-report", "hard-cut"]);
});
