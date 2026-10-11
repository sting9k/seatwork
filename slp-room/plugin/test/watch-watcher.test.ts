import { PROJECT, ROOM_HOME } from "./support/room";
import { bash, BRIEF, edit, prompt, say } from "./support/watch";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { WatcherPolicy } from "../server/policy";
import { Budget } from "../server/watch/budget";
import type { TimelineInput } from "../server/watch/events";
import type { DecisionEngine, DecisionReply, DecisionRequest } from "../server/watch/jev";
import { ScanLog } from "../server/watch/scanlog";
import { Watcher, type Notice, type SeatView } from "../server/watch/watcher";

const POLICY: WatcherPolicy = {
  mode: "on",
  watch: ["lead", "peer"],
  pollSeconds: 20,
  historyEntries: 200,
  rules: { irreversible: "raise", "outside-scope": "raise", repeating: "raise", "incomplete-brief": "raise", "unverified-completion": "raise", "reopen-condition": "off", "decided-beyond-brief": "off" },
  thresholds: { sleepSeconds: 60, repeatRun: 4, cycleRepeats: 3, sameFailure: 4, inFlightFactor: 3 },
  scores: { "unverified-completion": 0.85 },
  maxMailsPerSeat: 5,
  engine: { url: "", model: "", keyFile: "", keyEnv: "", deadlineMs: 100, restAfterFailures: 3, restMinutes: 10 },
  budget: { usdPerMillionTokens: 0.042, monthlyPlanUsd: 6, monthlyCapUsd: 10 },
  state: { messageChars: 2400, briefLineChars: 400 },
  calibration: { labelWindowMinutes: 60, minLabels: 100, minAuroc: 0.75, maxFalseRaiseRate: 0.05 },
};
const PARAMS = { heartbeatCron: "", peerStallMinutes: 6, reviewStallMinutes: 30, leadStallMinutes: 30, readBudgetTokens: 0, cheapReadBudgetTokens: 0 };
const PEER: SeatView = { agentId: "peer-1", role: "peer", title: "[Peer] hours", cwd: PROJECT, parent: "lead-1", parentRole: "lead" };
const src = (file: string) => join(PROJECT, file);
let run = 0;

function room(options: { mode?: WatcherPolicy["mode"]; says?: number; engine?: DecisionEngine; budget?: Partial<WatcherPolicy["budget"]> } = {}) {
  run += 1;
  const mail: Notice[] = [];
  const asked: DecisionRequest[] = [];
  let entries: TimelineInput[] = [];
  const reply = (verified: number): DecisionReply => ({ ok: true, model: "jev-test", inputTokens: 500, ms: 1, answers: { report_on_checks: { type: "choice", choice: "", probabilities: { not_mentioned: 0, says_not_verified: 1 - verified, says_verified: verified } }, checks_apply: { type: "noul", noul: 0.97 } } });
  const engine: DecisionEngine = options.engine ?? { ready: () => true, ask: async (request) => (asked.push(request), reply(options.says ?? 0.96)) };
  const policy = { ...POLICY, mode: options.mode ?? "on", budget: { ...POLICY.budget, ...options.budget } };
  const budget = new Budget(join(ROOM_HOME, `watcher-${run}`, "usage-{month}.json"), policy.budget);
  const scans = new ScanLog(join(ROOM_HOME, `watcher-${run}`, "scans.jsonl"));
  const watcher = new Watcher({ policy, params: PARAMS, engine, budget, scans, timeline: async () => ({ entries, pendingPermission: false }), snapshot: async () => null, notify: async (notice) => (mail.push(notice), `m${mail.length}`), now: () => Date.parse("2026-10-11T00:10:00Z"), log: () => {} });
  return { watcher, mail, asked, scans, budget, turn: (next: TimelineInput[]) => void (entries = next) };
}

const CLAIMS = [prompt(BRIEF), edit(src("src/duration.js")), say("CANDIDATE: hours added. Verification: npm test → 14 passing.")];

test("a finished turn whose message claims green tests that never ran is told to the seat above, with the report", async () => {
  const { watcher, mail, asked, scans, budget, turn } = room();
  watcher.turnStarted(PEER, "turn-1");
  turn(CLAIMS);
  await watcher.turnEnded(PEER, "turn-1", true);

  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, "lead-1");
  assert.equal(mail[0].withReport, true);
  assert.match(mail[0].subject, /^OBSERVATION: peer \[Peer\] hours reports CANDIDATE and says its checks passed; no test ran after its last change \(src\/duration\.js\)/);
  assert.match(mail[0].body, /a model's \(score 0\.96\)/);
  // the model was shown the message and the changed file, never the brief or any tool output
  assert.deepEqual(Object.keys(asked[0].state as object), ["changed_files", "final_message"]);
  const [record] = scans.read();
  assert.deepEqual([record.moment, record.signal, record.tests, record.mail], ["end", "CANDIDATE", "none", "m1"]);
  assert.deepEqual(record.findings.map((f) => [f.rule, f.by, f.outcome]), [["unverified-completion", "model", "raised"]]);
  assert.equal(budget.summary().total.tokens, 500);
});

test("the same turn is quiet when the tests did run, when the message admits they did not, and when the model is unsure", async () => {
  const ran = room();
  ran.watcher.turnStarted(PEER, "turn-1");
  ran.turn([prompt(BRIEF), edit(src("src/duration.js")), bash("npm test"), say("CANDIDATE: hours added. npm test → 14 passing.")]);
  await ran.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual([ran.mail.length, ran.asked.length], [0, 0]);
  assert.equal(ran.scans.read()[0].tests, "passed");

  const unsure = room({ says: 0.6 });
  unsure.watcher.turnStarted(PEER, "turn-1");
  unsure.turn(CLAIMS);
  await unsure.watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(unsure.mail.length, 0);
  assert.deepEqual(unsure.scans.read()[0].findings.map((f) => [f.by, f.score, f.outcome]), [["model", 0.6, "logged"]]);
});

test("shadow mode scans, asks and logs, and mails nobody", async () => {
  const { watcher, mail, asked, scans, turn } = room({ mode: "shadow" });
  watcher.turnStarted(PEER, "turn-1");
  turn(CLAIMS);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual([mail.length, asked.length], [0, 1]);
  assert.deepEqual(scans.read()[0].findings.map((f) => [f.rule, f.score, f.outcome]), [["unverified-completion", 0.96, "logged"]]);
});

test("a model that cannot answer, or a spent budget, leaves the facts in the log and the seat above alone", async () => {
  const failing = room({ engine: { ready: () => true, ask: async () => ({ ok: false, reason: "timeout", detail: "no answer within 100 ms" }) } });
  failing.watcher.turnStarted(PEER, "turn-1");
  failing.turn(CLAIMS);
  await failing.watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(failing.mail.length, 0);
  const [record] = failing.scans.read();
  assert.deepEqual(record.engine, { ok: false, reason: "timeout: no answer within 100 ms" });
  assert.deepEqual(record.findings.map((f) => [f.rule, f.by, f.outcome]), [["unverified-completion", "facts", "logged"]]);

  const spent = room({ budget: { monthlyCapUsd: 0 } });
  spent.watcher.turnStarted(PEER, "turn-1");
  spent.turn(CLAIMS);
  await spent.watcher.turnEnded(PEER, "turn-1", true);
  assert.deepEqual([spent.mail.length, spent.asked.length, spent.scans.read()[0].engine], [0, 0, { ok: false, reason: "budget-closed" }]);
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
  turn([prompt(BRIEF), edit(src("src/other.js")), ...Array.from({ length: 4 }, () => bash("curl -s localhost:1", { fails: true, output: "refused" }))]);
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.deepEqual(scans.read().at(-1)!.findings.map((f) => [f.rule, f.outcome]), [["repeating", "held"]]);
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
  turn([prompt(BRIEF), edit(src("src/other.js")), bash("npm test"), say("CANDIDATE: hours added"), prompt("SLP MAIL #3 ACTION from owner re: ANSWER: hours", "turn-2"), bash("git reset --hard origin/main", {}, "turn-2")]);
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

const CUT = BRIEF.replace(/Reopen when:.*\n/, "");

test("a Peer created with a brief that lacks a line: its Lead is told when its first turn starts, and the turn keeps its own mail", async () => {
  const { watcher, mail, scans, turn } = room();
  turn([prompt(CUT)]);
  watcher.turnStarted(PEER, "turn-1");
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.deepEqual([mail[0].to, mail[0].withReport], ["lead-1", false]);
  assert.match(mail[0].subject, /^OBSERVATION: peer \[Peer\] hours was briefed without these template lines: Reopen when$/);
  assert.match(mail[0].body, /read from the brief it was created with\.\n\nA brief that lacks a line is mended with a REVISED BRIEF/);

  // what the turn then does is still told, and the brief is not told again
  turn([prompt(CUT), edit(src("src/other.js")), bash("npm test"), say("CANDIDATE: hours added")]);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(mail.length, 2);
  assert.match(mail[1].subject, /changed src\/other\.js/);
  assert.doesNotMatch(mail[1].body, /briefed without/);
  assert.equal(scans.read().flatMap((record) => record.findings).filter((finding) => finding.rule === "incomplete-brief").length, 1);
});

test("a brief's gap and the turn's own finding, seen in one look, go up in one mail", async () => {
  const { watcher, mail, turn } = room();
  watcher.turnStarted(PEER, "turn-1"); // the prompt is not in the timeline yet
  await watcher.tick();
  turn([prompt(CUT), edit(src("src/other.js")), bash("npm test"), say("CANDIDATE: hours added")]);
  await watcher.turnEnded(PEER, "turn-1", true);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /changed src\/other\.js/);
  assert.match(mail[0].body, /- It changed src\/other\.js;.*\n- It was briefed without these template lines: Reopen when\./);
});

test("a brief in free prose is a brief all the same: the Lead is told every line it lacks", async () => {
  const { watcher, mail, turn } = room();
  turn([prompt("Make the duration parser better. Tell me when it is done.")]);
  watcher.turnStarted(PEER, "turn-1");
  await watcher.tick();
  assert.equal(mail.length, 1);
  assert.match(mail[0].body, /- It was briefed without these template lines: Outcome; Write scope; Acceptance evidence; Reopen when; Reply with slp_mail to: owner\./);
  assert.match(mail[0].body, /The last line is needed word for word/);
});

test("only the brief a Lead created a Peer with is held to the five lines", async () => {
  /** Whether the watcher found a gap in the brief when this seat started on this history. */
  const judged = async (seat: SeatView, history: TimelineInput[]) => {
    const { watcher, scans, turn } = room();
    turn(history);
    watcher.turnStarted(seat, "turn-1");
    await watcher.turnEnded(seat, "turn-1", true);
    return scans.read().some((record) => record.findings.some((finding) => finding.rule === "incomplete-brief"));
  };
  assert.equal(await judged(PEER, [prompt(CUT)]), true);
  // a later turn, as after a plugin reload: nothing remembered, the first prompt still in the history
  assert.equal(await judged(PEER, [prompt(CUT, "turn-0"), say("QUESTION: which unit?", "turn-0"), prompt("ANSWER: hours")]), false);
  // a brief that came as mail (a REVISED BRIEF marks its changed lines in ways the template does not fix)
  assert.equal(await judged(PEER, [prompt(`SLP MAIL #7 ACTION from owner re: REVISED BRIEF\n--- body ---\n${CUT}`)]), false);
  // a Peer the user opened, a research Peer under a Supervisor, a Lead under its Supervisor: none is a Lead's brief to a Peer
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
  assert.deepEqual([supervisor.mail.length, supervisor.scans.read().length, off.mail.length, off.scans.read().length], [0, 0, 0, 0]);
});
