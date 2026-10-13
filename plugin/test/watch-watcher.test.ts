import { PROJECT, ROOM_HOME } from "./support/room";
import { bash, BRIEF, edit, letter, prompt, read, say, skill } from "./support/watch";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { WatcherPolicy } from "../server/policy";
import { Budget } from "../server/watch/budget";
import type { TimelineInput } from "../server/watch/events";
import type { DecisionEngine, DecisionReply, DecisionRequest } from "../server/watch/jev";
import { ScanLog } from "../server/watch/scanlog";
import type { TreeSnapshot } from "../server/watch/git";
import { Watcher, type Notice, type SeatView } from "../server/watch/watcher";

const POLICY: WatcherPolicy = {
  mode: "on",
  watch: ["lead", "peer"],
  pollSeconds: 20,
  historyEntries: 200,
  rules: {
    irreversible: "raise",
    "outside-scope": "raise",
    repeating: "raise",
    "incomplete-brief": "raise",
    "unverified-completion": "raise",
    "reopen-condition": "off",
    "skill-skipped": "off",
  },
  thresholds: { sleepSeconds: 60, repeatRun: 4, cycleRepeats: 3, sameFailure: 4, inFlightFactor: 3 },
  scores: { "unverified-completion": 0.85 },
  maxMailsPerSeat: 5,
  engine: { url: "", model: "", keyFile: "", keyEnv: "", deadlineMs: 100, restAfterFailures: 3, restMinutes: 10 },
  budget: { usdPerMillionTokens: 0.042, monthlyPlanUsd: 6, monthlyCapUsd: 10 },
  state: { messageChars: 12000, briefLineChars: 400 },
  calibration: { labelWindowMinutes: 60, minLabels: 100, minAuroc: 0.75, maxFalseRaiseRate: 0.05 },
};
const PARAMS = {
  heartbeatCron: "",
  peerStallMinutes: 6,
  reviewStallMinutes: 30,
  leadStallMinutes: 30,
  readBudgetTokens: 0,
  cheapReadBudgetTokens: 0,
  mailChars: 6000,
  rotateAtTokens: 200000,
};
const PEER: SeatView = {
  agentId: "peer-1",
  role: "peer",
  title: "[Peer] hours",
  cwd: PROJECT,
  parent: "lead-1",
  parentRole: "lead",
};
const src = (file: string) => join(PROJECT, file);
let run = 0;

function room(
  options: {
    mode?: WatcherPolicy["mode"];
    says?: number;
    engine?: DecisionEngine;
    budget?: Partial<WatcherPolicy["budget"]>;
    rules?: WatcherPolicy["rules"];
    snapshots?: TreeSnapshot[];
    lawSkills?: string[];
  } = {},
) {
  run += 1;
  const mail: Notice[] = [];
  const asked: DecisionRequest[] = [];
  let entries: TimelineInput[] = [];
  const reply = (verified: number): DecisionReply => ({
    ok: true,
    model: "jev-test",
    inputTokens: 500,
    ms: 1,
    answers: {
      report_on_checks: {
        type: "choice",
        choice: "",
        probabilities: { not_mentioned: 0, says_not_verified: 1 - verified, says_verified: verified },
      },
      checks_apply: { type: "noul", noul: 0.97 },
    },
  });
  const engine: DecisionEngine = options.engine ?? {
    ready: () => true,
    ask: async (request) => (asked.push(request), reply(options.says ?? 0.96)),
  };
  const policy = {
    ...POLICY,
    mode: options.mode ?? "on",
    budget: { ...POLICY.budget, ...options.budget },
    rules: { ...POLICY.rules, ...options.rules },
  };
  const budget = new Budget(join(ROOM_HOME, `watcher-${run}`, "usage-{month}.json"), policy.budget);
  const scans = new ScanLog(join(ROOM_HOME, `watcher-${run}`, "scans.jsonl"));
  const watcher = new Watcher({
    policy,
    params: PARAMS,
    engine,
    budget,
    scans,
    timeline: async () => ({ entries, pendingPermission: false }),
    // the tree as git saw it, one reading per call; without readings there is no git
    snapshot: async () => options.snapshots?.shift() ?? null,
    lawSkills: () => options.lawSkills ?? [],
    notify: async (notice) => (mail.push(notice), `m${mail.length}`),
    now: () => Date.parse("2026-10-11T00:10:00Z"),
    log: () => {},
  });
  return { watcher, mail, asked, scans, budget, turn: (next: TimelineInput[]) => void (entries = next) };
}

const CLAIMS = [
  prompt(BRIEF),
  edit(src("src/duration.js")),
  say("CANDIDATE: hours added. Verification: npm test → 14 passing."),
];

test("a finished turn whose message claims green tests that never ran is told to the seat above, with the report", async () => {
  const { watcher, mail, asked, scans, budget, turn } = room();
  watcher.turnStarted(PEER, "turn-1");
  turn(CLAIMS);
  await watcher.turnEnded(PEER, "turn-1", true);

  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, "lead-1");
  assert.equal(mail[0].withReport, true);
  assert.match(
    mail[0].subject,
    /^OBSERVATION: peer \[Peer\] hours reports CANDIDATE and says its checks passed; no test ran after its last change \(src\/duration\.js\)/,
  );
  assert.match(mail[0].body, /a model's \(score 0\.96\)/);
  // the model was shown the message and the changed file, never the brief or any tool output
  assert.deepEqual(Object.keys(asked[0].state as object), ["changed_files", "final_message"]);
  const [record] = scans.read();
  // the look at the turn's start wrote no line of its own; the end's line counts it
  assert.deepEqual(
    [record.moment, record.signal, record.tests, record.reads, record.ran, record.mail],
    ["end", "CANDIDATE", "none", 2, undefined, "m1"],
  );
  assert.deepEqual(
    record.findings.map((f) => [f.rule, f.by, f.outcome]),
    [["unverified-completion", "model", "raised"]],
  );
  assert.equal(budget.summary().total.tokens, 500);
});

test("a report too long for a question that reads all of it is still asked what its lines about checks claim", async () => {
  const { watcher, mail, asked, scans, turn } = room({ rules: { "reopen-condition": "log" } });
  const table = Array.from(
    { length: 400 },
    (_, i) => `| R${i} | invoice.js | holds rule ${i} in the invoice of a prorated month |`,
  );
  watcher.turnStarted(PEER, "turn-1");
  turn([
    prompt(BRIEF),
    edit(src("src/duration.js")),
    say(["CANDIDATE: hours added.", "Verification: npm test → 14 passing.", ...table].join("\n")),
  ]);
  await watcher.turnEnded(PEER, "turn-1", true);

  assert.equal(mail.length, 1, "the long report was not read at all");
  assert.deepEqual(Object.keys(asked[0].questions), ["checks_apply", "report_on_checks"]);
  const [record] = scans.read();
  assert.deepEqual(record.engine && "skipped" in record.engine && record.engine.skipped, ["reopen-condition"]);
  assert.deepEqual(
    record.findings.map((f) => [f.rule, f.by, f.outcome]),
    [["unverified-completion", "model", "raised"]],
  );
});

test("the same turn is quiet when the tests did run, when the message admits they did not, and when the model is unsure", async () => {
  const ran = room();
  ran.watcher.turnStarted(PEER, "turn-1");
  ran.turn([
    prompt(BRIEF),
    edit(src("src/duration.js")),
    bash("npm test"),
    say("CANDIDATE: hours added. npm test → 14 passing."),
  ]);
  await ran.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual([ran.mail.length, ran.asked.length], [0, 0]);
  assert.deepEqual([ran.scans.read()[0].tests, ran.scans.read()[0].ran], ["passed", "passed"]);

  const unsure = room({ says: 0.6 });
  unsure.watcher.turnStarted(PEER, "turn-1");
  unsure.turn(CLAIMS);
  await unsure.watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(unsure.mail.length, 0);
  assert.deepEqual(
    unsure.scans.read()[0].findings.map((f) => [f.by, f.score, f.outcome]),
    [["model", 0.6, "logged"]],
  );
});

test("shadow mode scans, asks and logs, and mails nobody", async () => {
  const { watcher, mail, asked, scans, turn } = room({ mode: "shadow" });
  watcher.turnStarted(PEER, "turn-1");
  turn(CLAIMS);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual([mail.length, asked.length], [0, 1]);
  assert.deepEqual(
    scans.read()[0].findings.map((f) => [f.rule, f.score, f.outcome]),
    [["unverified-completion", 0.96, "logged"]],
  );
});

test("a model that cannot answer, or a spent budget, leaves the facts in the log and the seat above alone", async () => {
  const failing = room({
    engine: {
      ready: () => true,
      ask: async () => ({ ok: false, reason: "timeout", detail: "no answer within 100 ms" }),
    },
  });
  failing.watcher.turnStarted(PEER, "turn-1");
  failing.turn(CLAIMS);
  await failing.watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(failing.mail.length, 0);
  const [record] = failing.scans.read();
  assert.deepEqual(record.engine, { ok: false, reason: "timeout: no answer within 100 ms" });
  assert.deepEqual(
    record.findings.map((f) => [f.rule, f.by, f.outcome]),
    [["unverified-completion", "facts", "logged"]],
  );

  const spent = room({ budget: { monthlyCapUsd: 0 } });
  spent.watcher.turnStarted(PEER, "turn-1");
  spent.turn(CLAIMS);
  await spent.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual(
    [spent.mail.length, spent.asked.length, spent.scans.read()[0].engine],
    [0, 0, { ok: false, reason: "budget-closed" }],
  );
});

test("a running turn is told once for what it does, at once, and an unchanged turn is not asked about twice", async () => {
  const { watcher, mail, scans, turn } = room();
  watcher.turnStarted(PEER, "turn-1");
  turn([prompt(BRIEF), edit(src("src/other.js"))]);
  await watcher.tick();
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.equal(mail[0].withReport, false);
  assert.match(mail[0].subject, /changed src\/other\.js; its write scope is src\/duration\.js, test\/\*\*/);
  assert.match(mail[0].body, /whose turn is still running/);
  // a second finding in the same turn is held: the seat above gets one mail per turn …
  turn([
    prompt(BRIEF),
    edit(src("src/other.js")),
    ...Array.from({ length: 4 }, () => bash("curl -s localhost:1", { fails: true, output: "refused" })),
  ]);
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.deepEqual(
    scans
      .read()
      .at(-1)!
      .findings.map((f) => [f.rule, f.outcome]),
    [["repeating", "held"]],
  );
  // … unless it cannot wait
  turn([prompt(BRIEF), edit(src("src/other.js")), bash("git reset --hard origin/main")]);
  await watcher.tick();
  assert.equal(mail.length, 2);
  assert.match(mail[1].subject, /git reset --hard/);
});

test("a turn whose end is read after the seat's next turn began is judged on its own events, and the next turn stays watched", async () => {
  const { watcher, mail, scans, turn } = room();
  watcher.turnStarted(PEER, "turn-1");
  // held mail started the next turn before the first one's end was read
  watcher.turnStarted(PEER, "turn-2");
  turn([
    prompt(BRIEF),
    edit(src("src/other.js")),
    bash("npm test"),
    say("CANDIDATE: hours added"),
    prompt("SEATWORK MAIL #3 ACTION from owner re: ANSWER: hours", "turn-2"),
    bash("git reset --hard origin/main", {}, "turn-2"),
  ]);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /changed src\/other\.js/);
  assert.equal(mail[0].withReport, true);
  assert.deepEqual([scans.read().at(-1)!.turn, scans.read().at(-1)!.signal], ["turn-1", "CANDIDATE"]);

  await watcher.tick();
  assert.equal(mail.length, 2);
  assert.match(mail[1].subject, /git reset --hard/);
  assert.equal(mail[1].withReport, false);
});

test("a new turn is not silent because the last one ended long ago, and a file a later mail names is not outside the scope", async () => {
  const { watcher, mail, scans, turn } = room();
  const earlier = [
    prompt(BRIEF, "turn-0"),
    edit(src("src/duration.js"), "turn-0"),
    bash("npm test", {}, "turn-0"),
    say("CANDIDATE: hours added", "turn-0"),
  ];
  // the room's clock is ten minutes past these entries: the Lead took its time to answer
  turn([
    ...earlier,
    prompt(
      "SEATWORK MAIL #9 BLOCKING from owner re: REJECT: one repair\n--- body ---\n`src/other.js` needs the same guard.",
      "turn-1",
    ),
  ]);
  watcher.turnStarted(PEER, "turn-1");
  await watcher.tick();
  turn([
    ...earlier,
    prompt(
      "SEATWORK MAIL #9 BLOCKING from owner re: REJECT: one repair\n--- body ---\n`src/other.js` needs the same guard.",
      "turn-1",
    ),
    edit(src("src/other.js"), "turn-1"),
    bash("npm test", {}, "turn-1"),
    say("CANDIDATE: repaired", "turn-1"),
  ]);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(mail.length, 0);
  assert.deepEqual(
    scans.read().flatMap((record) => record.findings.map((finding) => finding.rule)),
    [],
  );
});

const CUT = BRIEF.replace(/Reopen when:.*\n/, "");

test("a Peer created with a brief that lacks a line: its Lead is told when its first turn starts, and the turn keeps its own mail", async () => {
  const { watcher, mail, scans, turn } = room();
  turn([prompt(CUT)]);
  watcher.turnStarted(PEER, "turn-1");
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.deepEqual([mail[0].to, mail[0].withReport], ["lead-1", false]);
  assert.match(
    mail[0].subject,
    /^OBSERVATION: peer \[Peer\] hours was briefed without these template lines: Reopen when$/,
  );
  assert.match(
    mail[0].body,
    /read from the brief it was created with\.\n\nA brief that lacks a line is mended with a REVISED BRIEF/,
  );

  // what the turn then does is still told, and the brief is not told again
  turn([prompt(CUT), edit(src("src/other.js")), bash("npm test"), say("CANDIDATE: hours added")]);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(mail.length, 2);
  assert.match(mail[1].subject, /changed src\/other\.js/);
  assert.doesNotMatch(mail[1].body, /briefed without/);

  // nor in a later turn that no prompt opened: the brief is still its only prompt
  turn([
    prompt(CUT),
    edit(src("src/other.js")),
    bash("npm test"),
    say("CANDIDATE: hours added"),
    bash("npm test", {}, "turn-2"),
  ]);
  watcher.turnStarted(PEER, "turn-2");
  await watcher.tick();
  assert.equal(
    scans
      .read()
      .flatMap((record) => record.findings)
      .filter((finding) => finding.rule === "incomplete-brief").length,
    1,
  );
});

test("a turn whose runtime closed is not read again; reopened, the seat is watched as before and its brief is not told twice", async () => {
  const { watcher, mail, scans, turn } = room();
  turn([prompt(CUT)]);
  watcher.turnStarted(PEER, "turn-1");
  await watcher.tick();
  assert.equal(mail.length, 1);

  watcher.cut(PEER.agentId);
  turn([prompt(CUT), edit(src("src/other.js"))]);
  await watcher.tick();
  assert.equal(mail.length, 1, "a turn that gets no end was read again");

  turn([prompt(CUT), edit(src("src/other.js")), edit(src("src/third.js"), "turn-2")]);
  watcher.turnStarted(PEER, "turn-2");
  await watcher.tick();
  assert.equal(mail.length, 2);
  assert.match(mail[1].subject, /changed src\/third\.js/);
  assert.equal(
    scans
      .read()
      .flatMap((record) => record.findings)
      .filter((finding) => finding.rule === "incomplete-brief").length,
    1,
  );
});

test("a brief's gap and the turn's own finding, seen in one look, go up in one mail", async () => {
  const { watcher, mail, turn } = room();
  watcher.turnStarted(PEER, "turn-1"); // the prompt is not in the timeline yet
  await watcher.tick();
  turn([prompt(CUT), edit(src("src/other.js")), bash("npm test"), say("CANDIDATE: hours added")]);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /changed src\/other\.js/);
  assert.match(
    mail[0].body,
    /- It changed src\/other\.js;.*\n- It was briefed without these template lines: Reopen when\./,
  );
});

test("a brief in free prose is a brief all the same: the Lead is told every line it lacks", async () => {
  const { watcher, mail, turn } = room();
  turn([prompt("Make the duration parser better. Tell me when it is done.")]);
  watcher.turnStarted(PEER, "turn-1");
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.match(
    mail[0].body,
    /- It was briefed without these template lines: Outcome; Write scope; Acceptance evidence; Reopen when; Reply with seatwork_mail to: owner\./,
  );
  assert.match(mail[0].body, /The last line is needed word for word/);
});

test("a brief that reaches a Peer by mail is held to the same lines, and told once", async () => {
  const { watcher, mail, scans, turn } = room();
  const first = [prompt(BRIEF, "turn-1"), say("CANDIDATE: hours added", "turn-1")];
  // a brief cut on its way: it ends after "Yours to decide"
  const cut = prompt(
    letter("m7", "ACCEPT abc123 + BRIEF T2: the days unit", BRIEF.split("\n").slice(0, 6).join("\n")),
    "turn-2",
  );
  turn([...first, cut]);
  watcher.turnStarted(PEER, "turn-2");
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.match(
    mail[0].subject,
    /^OBSERVATION: peer \[Peer\] hours was mailed a brief \("ACCEPT abc123 \+ BRIEF T2: the days unit"\) without these template lines: Acceptance evidence/,
  );
  assert.match(
    mail[0].body,
    /without these template lines: Acceptance evidence; Reopen when; Reply with seatwork_mail to: owner\./,
  );
  assert.match(
    mail[0].body,
    /read from the mail as it reached the Peer\.\n\nA brief that lacks a line is mended with a REVISED BRIEF/,
  );

  // a later turn that no mail opened still has that mail as its last prompt
  await watcher.turnEnded(PEER, "turn-2", true);
  turn([...first, cut, say("working on it", "turn-2"), bash("npm test", {}, "turn-3")]);
  watcher.turnStarted(PEER, "turn-3");
  await watcher.turnEnded(PEER, "turn-3", false);
  assert.equal(
    scans
      .read()
      .flatMap((record) => record.findings)
      .filter((finding) => finding.rule === "incomplete-brief").length,
    1,
  );
});

test("which prompts are held to the five lines: a Lead's brief to a Peer, created or mailed", async () => {
  /** Whether the watcher found a gap in the brief when this seat started on this history. */
  const judged = async (seat: SeatView, history: TimelineInput[]) => {
    const { watcher, scans, turn } = room();
    turn(history);
    watcher.turnStarted(seat, "turn-1");
    await watcher.turnEnded(seat, "turn-1", true);
    return scans.read().some((record) => record.findings.some((finding) => finding.rule === "incomplete-brief"));
  };
  assert.equal(await judged(PEER, [prompt(CUT)]), true);
  // a later turn, as after a plugin reload: the first prompt is still in the history
  assert.equal(
    await judged(PEER, [prompt(CUT, "turn-0"), say("QUESTION: which unit?", "turn-0"), prompt("ANSWER: hours")]),
    false,
  );
  // a brief that came as mail lacks what it lacks, whatever a revision puts before a changed line
  assert.equal(await judged(PEER, [prompt(letter("m1", "REVISED BRIEF: hours and days", CUT))]), true);
  assert.equal(
    await judged(PEER, [
      prompt(letter("m2", "REVISED BRIEF: hours and days", BRIEF.replace("Reopen when:", "[changed] Reopen when:"))),
    ]),
    false,
  );
  assert.equal(
    await judged(PEER, [
      prompt(
        `SEATWORK MAIL DIGEST — 2 messages, highest first. Handle each by its own header.\n\n${letter("m3", "ANSWER: hours", "hours")}\n\n${letter("m4", "BRIEF: the days unit", CUT)}`,
      ),
    ]),
    true,
  );
  // other mail is no brief: a repair order with two template lines, a brief from nobody above
  assert.equal(
    await judged(PEER, [
      prompt(
        letter(
          "m5",
          "REJECT abc123: one repair",
          "REJECT abc123: print the unit back.\nWrite scope: unchanged\nOutput: CANDIDATE with the new sha\nReply with seatwork_mail to: owner",
        ),
      ),
    ]),
    false,
  );
  assert.equal(await judged(PEER, [prompt(letter("m6", "BRIEF: the days unit", CUT, "room"))]), false);
  // a Peer the user opened, a research Peer under a Supervisor, a Lead: none is a Lead's brief to a Peer
  assert.equal(await judged({ ...PEER, parent: null, parentRole: null }, [prompt("fix the flaky test")]), false);
  assert.equal(await judged({ ...PEER, parentRole: "supervisor" }, [prompt(CUT)]), false);
  assert.equal(await judged({ ...PEER, role: "lead", parentRole: "supervisor" }, [prompt(CUT)]), false);
});

test("roles outside the watch list and a watcher that is off see nothing", async () => {
  const supervisor = room();
  supervisor.watcher.turnStarted({ ...PEER, role: "supervisor" }, "turn-1");
  supervisor.turn([prompt(BRIEF), bash("git reset --hard")]);
  await supervisor.watcher.turnEnded({ ...PEER, role: "supervisor" }, "turn-1", true);
  const off = room({ mode: "off" });
  off.watcher.turnStarted(PEER, "turn-1");
  off.turn([prompt(BRIEF), bash("git reset --hard")]);
  await off.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual(
    [supervisor.mail.length, supervisor.scans.read().length, off.mail.length, off.scans.read().length],
    [0, 0, 0, 0],
  );
});

test("what git saw change is held against a Peer that had the tree to itself, and against neither of two that shared it", async () => {
  const tree = (dirty: [string, string][]): TreeSnapshot => ({ root: PROJECT, head: "h", dirty: new Map(dirty) });
  const quiet = [prompt(BRIEF), bash("npm test"), say("STATUS: tests run")];

  const alone = room({ snapshots: [tree([]), tree([["src/legacy/month.js", "9:1"]])] });
  alone.watcher.turnStarted(PEER, "turn-1");
  alone.turn(quiet);
  await alone.watcher.turnEnded(PEER, "turn-1", true);
  assert.match(alone.mail[0].subject, /changed src\/legacy\/month\.js; its write scope is/);

  const shared = room({ snapshots: [tree([]), tree([]), tree([["src/legacy/month.js", "9:1"]])] });
  shared.watcher.turnStarted(PEER, "turn-1");
  shared.watcher.turnStarted({ ...PEER, agentId: "peer-2", title: "[Peer] months" }, "turn-9");
  shared.turn(quiet);
  await shared.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual(shared.mail, []);
});

test("a Peer that hands in a CANDIDATE or edits under a law that names a skill, without loading it, is told; a reviewer is not", async () => {
  const rules = { "skill-skipped": "raise" as const, "unverified-completion": "off" as const };
  const done = say("CANDIDATE: hours added.");
  const first = room({ rules, lawSkills: ["hard-cut"] });
  first.watcher.turnStarted(PEER, "turn-1");
  first.turn([prompt(BRIEF), edit(src("src/duration.js")), done]);
  await first.watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(first.mail.length, 1);
  assert.match(
    first.mail[0].subject,
    /reports CANDIDATE and has not loaded `candidate-handoff`; changed source under a project law that names `hard-cut` and has not loaded it/,
  );

  // said once for a seat: its next CANDIDATE without the skills brings no second notice
  first.watcher.turnStarted(PEER, "turn-2");
  first.turn([
    prompt(BRIEF),
    prompt("REJECT: one more case", "turn-2"),
    edit(src("src/duration.js"), "turn-2"),
    say("CANDIDATE: fixed.", "turn-2"),
  ]);
  await first.watcher.turnEnded(PEER, "turn-2", true);
  assert.equal(first.mail.length, 1);

  // loaded either way: the skill tool, or a read of the skill's file where the harness has no such tool
  const loaded = room({ rules, lawSkills: ["hard-cut"] });
  loaded.watcher.turnStarted(PEER, "turn-1");
  loaded.turn([
    prompt(BRIEF),
    skill("hard-cut"),
    edit(src("src/duration.js")),
    read("/home/room/runtimes/pi/peer/skills/candidate-handoff/SKILL.md"),
    done,
  ]);
  await loaded.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual(
    loaded.mail.map((notice) => notice.subject),
    [],
  );

  // a skill loaded in an earlier turn is still loaded when the history no longer shows it
  const later = room({ rules });
  later.watcher.turnStarted(PEER, "turn-1");
  later.turn([prompt(BRIEF), skill("candidate-handoff"), edit(src("src/duration.js")), done]);
  await later.watcher.turnEnded(PEER, "turn-1", true);
  later.watcher.turnStarted(PEER, "turn-2");
  later.turn([
    prompt(BRIEF),
    prompt("REJECT: one more case", "turn-2"),
    edit(src("src/duration.js"), "turn-2"),
    say("CANDIDATE: fixed.", "turn-2"),
  ]);
  await later.watcher.turnEnded(PEER, "turn-2", true);
  assert.deepEqual(
    later.mail.map((notice) => notice.subject),
    [],
  );

  const reviewer = room({ rules, lawSkills: ["hard-cut"] });
  const review = { ...PEER, agentId: "peer-r", title: "[Peer:review] abc123" };
  reviewer.watcher.turnStarted(review, "turn-1");
  reviewer.turn([prompt(BRIEF), say("CANDIDATE: nothing to hand in.")]);
  await reviewer.watcher.turnEnded(review, "turn-1", true);
  assert.deepEqual(
    reviewer.mail.map((notice) => notice.subject),
    [],
  );
});

test("a seat that puts software on the machine is told, unless its brief grants it", async () => {
  const rules = { "software-install": "raise" as const, "unverified-completion": "off" as const };
  const { watcher, mail, turn } = room({ rules });
  watcher.turnStarted(PEER, "turn-1");
  turn([prompt(BRIEF), bash("npx playwright install firefox"), say("STATUS: checking the page.")]);
  await watcher.turnEnded(PEER, "turn-1", false);
  assert.equal(mail.length, 1);
  assert.match(
    mail[0].subject,
    /put software on this machine that its brief does not grant \(a browser download \(playwright install\)\): `npx playwright install firefox`/,
  );

  const granted = room({ rules });
  granted.watcher.turnStarted(PEER, "turn-1");
  granted.turn([
    prompt(
      BRIEF.replace("Constraints: no new dependency; no push", "Constraints: no push; may install Chromium headless"),
    ),
    bash("npx playwright install chromium"),
    say("STATUS: checking the page."),
  ]);
  await granted.watcher.turnEnded(PEER, "turn-1", false);
  assert.deepEqual(
    granted.mail.map((notice) => notice.subject),
    [],
  );
});
