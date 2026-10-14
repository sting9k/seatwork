import { PROJECT, ROOM_HOME } from "./support/room";
import { BRIEF, edit, prompt, say } from "./support/watch";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseBrief } from "../server/watch/brief";
import { Budget } from "../server/watch/budget";
import { auroc, calibrate, labelOf, operatingPoint, renderCalibration, type MailLine } from "../server/watch/calibrate";
import { toEvents, turnStartOf } from "../server/watch/events";
import { turnFacts } from "../server/watch/facts";
import { JevEngine, type DecisionRequest } from "../server/watch/jev";
import { inquiryFor, REVISION } from "../server/watch/questions";
import { redact } from "../server/watch/redact";
import type { ScanRecord } from "../server/watch/scanlog";
import { buildRequest, excerpt, fitting } from "../server/watch/state";
import { usageReport } from "../server/paseo/usage";

const REQUEST: DecisionRequest = {
  state: { final_message: "CANDIDATE" },
  questions: {
    q: { type: "choice", instructions: "?", criteria: { a: "a", b: "b" } },
    n: { type: "noul", instructions: "?" },
  },
};
const REPLY = {
  model: "jev-x",
  answers: {
    q: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.8 },
    n: { type: "noul", noul: 0.7 },
  },
  usage: { input_tokens: 411, output_tokens: 60 },
};
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const engineWith = (fetch: typeof globalThis.fetch, now = () => Date.now()) =>
  new JevEngine({
    apiKey: "k",
    url: "https://example.test/decide",
    model: "jev",
    deadlineMs: 200,
    restAfterFailures: 2,
    restMinutes: 10,
    fetch,
    now,
  });

test("the engine returns typed answers and the billed tokens, and sends the key and the body the API takes", async () => {
  let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const engine = engineWith(async (url, init) => {
    sent = { url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) };
    return respond(200, REPLY);
  });
  const reply = await engine.ask(REQUEST);
  assert.deepEqual(sent, {
    url: "https://example.test/decide",
    headers: { authorization: "Bearer k", "content-type": "application/json", accept: "application/json" },
    body: { model: "jev", ...REQUEST },
  });
  assert.ok(reply.ok);
  assert.deepEqual(reply.answers, {
    q: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 } },
    n: { type: "noul", noul: 0.7 },
  });
  assert.equal(reply.inputTokens, 411);
});

test("the engine fails open: every failure is a reason, none is an exception, and repeated failures make it rest", async () => {
  assert.deepEqual(
    await new JevEngine({
      apiKey: undefined,
      url: "u",
      model: "m",
      deadlineMs: 50,
      restAfterFailures: 2,
      restMinutes: 1,
    }).ask(REQUEST),
    { ok: false, reason: "no-key", detail: "no API key is set" },
  );
  const reasonOf = async (fetch: typeof globalThis.fetch) =>
    ((await engineWith(fetch).ask(REQUEST)) as { reason: string }).reason;
  assert.equal(
    await reasonOf(async () => respond(422, { detail: [{ loc: ["body", "questions"], msg: "Field required" }] })),
    "refused",
  );
  assert.equal(
    await reasonOf(async () => respond(200, { answers: { q: { type: "noul", noul: 1 } }, usage: { input_tokens: 1 } })),
    "malformed",
  );
  assert.equal(
    await reasonOf(async () => {
      throw new Error("ECONNREFUSED");
    }),
    "unreachable",
  );
  assert.equal(
    await reasonOf(
      (_url, init) =>
        new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
    ),
    "timeout",
  );

  // an overloaded server is tried once more inside the same deadline
  let calls = 0;
  const retried = await engineWith(async () =>
    ++calls === 1 ? respond(529, "overloaded", { "retry-after-ms": "5" }) : respond(200, REPLY),
  ).ask(REQUEST);
  assert.deepEqual([calls, retried.ok], [2, true]);

  // a bad key will not get better by asking again: the engine rests at once
  let clock = 0;
  let asked = 0;
  const resting = engineWith(
    async () => ((asked += 1), respond(401, "bad key")),
    () => clock,
  );
  await resting.ask(REQUEST);
  assert.equal(resting.ready(), false);
  assert.equal(((await resting.ask(REQUEST)) as { reason: string }).reason, "resting");
  assert.equal(asked, 1);
  clock += 11 * 60_000;
  assert.equal(resting.ready(), true);
});

test("secrets are blanked before text leaves the machine", () => {
  const dirty =
    'export API_KEY=sk-ant-abcdefghijklmnop1234 && curl -H "Authorization: Bearer abcdefghijklmnop123456" https://u:hunter22@host/x --token ghp_abcdefghijklmnopqrstuvwx';
  const clean = redact(dirty);
  for (const secret of [
    "sk-ant-abcdefghijklmnop1234",
    "abcdefghijklmnop123456",
    "hunter22",
    "ghp_abcdefghijklmnopqrstuvwx",
  ])
    assert.ok(!clean.includes(secret), secret);
  assert.equal(redact("npm test: 14 passing, token count 3"), "npm test: 14 passing, token count 3");
});

test("a long message is cut to the lines that bear on the question; one too long to cut honestly is said to be so", () => {
  const filler = Array.from({ length: 60 }, (_, i) => `- detail ${i}: ${"x".repeat(40)}`);
  const message = [
    "CANDIDATE: hours added",
    ...filler.slice(0, 30),
    "Verification: npm test → 14 passing",
    ...filler.slice(30),
    "RECAP: added hours → sha 1a2b3c4",
  ].join("\n");
  const cut = excerpt(message, /\btest|passing\b/i, 400);
  assert.equal(cut.whole, true);
  assert.ok(cut.text.length <= 420);
  assert.match(cut.text, /^CANDIDATE: hours added\n/);
  assert.match(cut.text, /npm test → 14 passing/);
  assert.match(cut.text, /RECAP: added hours → sha 1a2b3c4$/);
  assert.match(cut.text, /\[…\]/);
  assert.equal(excerpt("short", /x/, 400).text, "short");
  const dense = Array.from({ length: 40 }, (_, i) => `test ${i} passing ${"y".repeat(40)}`).join("\n");
  assert.equal(excerpt(dense, /\btest\b/, 400).whole, false);
});

test("a question whose lines of a long message do not fit is left out, and the others are still asked", () => {
  const limits = { messageChars: 600, briefLineChars: 400 };
  const completion = inquiryFor("unverified-completion")!;
  const reopen = inquiryFor("reopen-condition")!; // reads every line
  const table = Array.from({ length: 40 }, (_, i) => `| R${i} | invoice.js | holds rule ${i} |`);
  const long = [
    "CANDIDATE: v2 on branch v2",
    "Verification: npm test → 60 passing",
    ...table,
    "RECAP: built v2 → 8842031",
  ].join("\n");

  assert.deepEqual(
    fitting([reopen, completion], long, limits).map((inquiry) => inquiry.rule),
    ["unverified-completion"],
  );
  assert.deepEqual(
    fitting([reopen, completion], "CANDIDATE: v2. npm test → 60 passing.", limits).map((inquiry) => inquiry.rule),
    ["reopen-condition", "unverified-completion"],
  );
  // a rule that reads no message always fits; one whose own lines are too many does not
  assert.deepEqual(
    fitting([inquiryFor("external-action")!, reopen], long, limits).map((inquiry) => inquiry.rule),
    ["external-action"],
  );
  assert.deepEqual(fitting([completion], table.map((row) => `${row} test passed`).join("\n"), limits), []);
});

test("the state holds only what the asked questions read, in a fixed order, and equal situations hash equally", () => {
  const entries = [
    prompt(BRIEF),
    edit(join(PROJECT, "src/duration.js")),
    say("CANDIDATE: hours added. npm test: 14 passing. API_KEY=sk-ant-abcdefghijklmnop1234"),
  ];
  const events = toEvents(entries, PROJECT);
  const brief = parseBrief(BRIEF, PROJECT);
  const facts = turnFacts({
    events,
    turnStart: turnStartOf(entries, events, "turn-1"),
    cwd: PROJECT,
    root: PROJECT,
    brief,
    ended: true,
    changed: null,
  });
  const limits = { messageChars: 2400, briefLineChars: 400 };
  const completion = buildRequest([inquiryFor("unverified-completion")!], facts, brief, limits);
  assert.deepEqual(Object.keys(completion.request.state as object), ["changed_files", "final_message"]);
  assert.deepEqual((completion.request.state as { changed_files: string[] }).changed_files, ["src/duration.js"]);
  assert.ok(!JSON.stringify(completion.request).includes("sk-ant-abcdefghijklmnop1234"));
  assert.deepEqual(Object.keys(completion.request.questions), ["checks_apply", "report_on_checks"]);

  const both = buildRequest(
    [inquiryFor("unverified-completion")!, inquiryFor("reopen-condition")!],
    facts,
    brief,
    limits,
  );
  assert.deepEqual(both.request.state, {
    brief: { reopen_when: "hours need more than the regular expression" },
    changed_files: ["src/duration.js"],
    final_message: (completion.request.state as { final_message: string }).final_message,
  });
  assert.equal(buildRequest([inquiryFor("unverified-completion")!], facts, brief, limits).hash, completion.hash);
  assert.notEqual(both.hash, completion.hash);
  // what the brief does not state is said, not left out
  assert.deepEqual(
    (buildRequest([inquiryFor("reopen-condition")!], facts, null, limits).request.state as { brief: object }).brief,
    { reopen_when: "not stated in the brief" },
  );
});

test("an inquiry's score is the weakest of what must hold", () => {
  const inquiry = inquiryFor("unverified-completion")!;
  const answers = (verified: number, apply: number) => ({
    report_on_checks: {
      type: "choice" as const,
      choice: "x",
      probabilities: { not_mentioned: 0, says_not_verified: 1 - verified, says_verified: verified },
    },
    checks_apply: { type: "noul" as const, noul: apply },
  });
  assert.equal(inquiry.score(answers(0.95, 0.9)), 0.9);
  assert.equal(inquiry.score(answers(0.95, 0.2)), 0.2);
  assert.equal(inquiry.score({ report_on_checks: answers(1, 1).report_on_checks }), null);
});

test("the month's spending is reported to Paseo's Usage screen against the cap", () => {
  const now = new Date("2026-10-11T08:00:00Z");
  const budget = new Budget(
    join(ROOM_HOME, "watch-usage", "usage-{month}.json"),
    { usdPerMillionTokens: 1, monthlyPlanUsd: 21, monthlyCapUsd: 30 },
    () => now,
  );
  budget.record("end", 900_000);
  budget.record("live", 600_000); // $1.50 today, past today's $1.00 share of the plan

  assert.deepEqual(usageReport(budget.summary()), {
    status: "available",
    planLabel: "plan $21 a month",
    windows: [{ id: "month", label: "Cap for 2026-10", shortLabel: "mo", summary: true, usedPct: 5 }],
    balances: [{ id: "month", label: "Spent this month", used: 1.5, limit: 30, unit: "usd" }],
    details: [
      { id: "calls", label: "Questions asked", value: "2" },
      { id: "tokens", label: "Tokens read", value: "1500000" },
      { id: "today", label: "Spent today", value: "$1.5000" },
      { id: "pace", label: "Asking", value: "saving", tone: "warning" },
    ],
  });
});

test("the budget counts what replies report, saves the day's share, and closes at the cap", () => {
  let now = new Date("2026-10-11T08:00:00Z");
  const budget = new Budget(
    join(ROOM_HOME, "watch-test", "usage-{month}.json"),
    { usdPerMillionTokens: 1, monthlyPlanUsd: 21, monthlyCapUsd: 30 },
    () => now,
  );
  assert.equal(budget.pace(), "open");
  budget.record("end", 900_000); // $0.90 of today's $1.00 share (21 left over 21 days)
  assert.equal(budget.pace(), "open");
  budget.record("live", 200_000);
  assert.equal(budget.pace(), "saving");
  now = new Date("2026-10-12T08:00:00Z");
  assert.equal(budget.pace(), "open", "a new day has its own share");
  budget.record("end", 29_000_000);
  assert.equal(budget.pace(), "closed");
  // the ledger is on disk: a plugin reload does not forget the month
  const reloaded = new Budget(
    join(ROOM_HOME, "watch-test", "usage-{month}.json"),
    { usdPerMillionTokens: 1, monthlyPlanUsd: 21, monthlyCapUsd: 30 },
    () => now,
  );
  assert.equal(reloaded.summary().total.calls, 3);
  assert.equal(reloaded.pace(), "closed");
  now = new Date("2026-11-01T00:00:00Z");
  assert.equal(reloaded.pace(), "open", "a new month starts at zero");
});

test("AUROC by ranks, with ties and with its operating point", () => {
  const items = (positives: number[], negatives: number[]) => [
    ...positives.map((score) => ({ score, positive: true })),
    ...negatives.map((score) => ({ score, positive: false })),
  ];
  assert.equal(auroc(items([0.9, 0.8], [0.2, 0.1]))!.auroc, 1);
  assert.equal(auroc(items([0.1], [0.9]))!.auroc, 0);
  assert.equal(auroc(items([0.5, 0.5], [0.5, 0.5]))!.auroc, 0.5);
  assert.equal(auroc(items([0.9, 0.4], [0.6, 0.2]))!.auroc, 0.75);
  assert.equal(auroc(items([0.9], [])), null);
  assert.deepEqual(operatingPoint(items([0.9, 0.8, 0.3], [0.85, 0.2, 0.1, 0.05]), 0.25), {
    threshold: 0.3,
    recall: 1,
    falseRate: 0.25,
  });
  assert.deepEqual(operatingPoint(items([0.9, 0.8, 0.3], [0.85, 0.2, 0.1, 0.05]), 0), {
    threshold: 0.9,
    recall: 1 / 3,
    falseRate: 0,
  });
});

test("a turn is labelled by what the seat above did with it; a claim of passing checks was false only when a test failed for the seat above", () => {
  const at = (minute: number) => new Date(Date.parse("2026-10-11T10:00:00Z") + minute * 60_000).toISOString();
  const scan = (seat: string, minute: number, findings: ScanRecord["findings"], signal = "CANDIDATE"): ScanRecord => ({
    at: at(minute),
    seat,
    role: "peer",
    parent: "lead",
    turn: `t-${seat}`,
    moment: "end",
    rev: REVISION,
    signal,
    tests: "none",
    statics: "none",
    reads: 2,
    findings,
  });
  /** A turn of the Lead, and what the first test it ran in it said. */
  const above = (minute: number, ran?: ScanRecord["ran"]): ScanRecord => ({
    ...scan("lead", minute, [], "STATUS"),
    role: "lead",
    parent: "sup",
    turn: `t-lead-${minute}`,
    ...(ran ? { ran } : {}),
  });
  const mailed = (to: string, minute: number, subject: string, from = "lead"): MailLine => ({
    at: at(minute),
    from,
    to,
    subject,
  });
  const model = (score: number) => [
    {
      rule: "unverified-completion" as const,
      key: "k",
      by: "model" as const,
      score,
      evidence: "e",
      outcome: "logged" as const,
    },
  ];
  const now = Date.parse(at(300));
  const policy = { labelWindowMinutes: 60, minLabels: 2, minAuroc: 0.75, maxFalseRaiseRate: 0.05 };

  // the verdict: the first REJECT, REVISED BRIEF or ACCEPT of the seat above within the window
  const one = scan("p0", 0, []);
  assert.equal(
    labelOf(one, [mailed("p0", 5, "REJECT p0: one repair"), mailed("p0", 9, "ACCEPT p0")], now, 60),
    "returned",
  );
  assert.equal(
    labelOf(one, [mailed("p0", 5, "ACCEPT", "someone-else"), mailed("p0", 9, "REVISED BRIEF")], now, 60),
    "returned",
  );
  assert.equal(labelOf(one, [mailed("p0", 90, "REJECT p0: too late to count")], now, 60), null);
  // a DONE is taken in silence: no verdict in the window is an acceptance
  assert.equal(labelOf(scan("l1", 0, [], "DONE"), [], now, 60), "accepted");
  assert.equal(
    labelOf(scan("l1", 0, [], "DONE"), [mailed("l1", 3, "QUESTION: DONE arrived cut, send the rest")], now, 60),
    "accepted",
  );
  assert.equal(
    labelOf(scan("l1", 0, [], "DONE"), [mailed("l1", 3, "REJECT: a Peer is still running")], now, 60),
    "returned",
  );
  assert.equal(labelOf(scan("l1", 0, [], "DONE"), [], Date.parse(at(10)), 60), null);
  // HOLD means "received, under review": the verdict is what follows it
  assert.equal(
    labelOf(
      scan("p7", 0, []),
      [mailed("p7", 1, "HOLD abc: inspected, with two lenses"), mailed("p7", 9, "ACCEPT abc")],
      now,
      60,
    ),
    "accepted",
  );
  assert.equal(
    labelOf(
      scan("p7", 0, []),
      [mailed("p7", 1, "HOLD abc: inspected, with two lenses"), mailed("p7", 9, "REJECT abc: one defect")],
      now,
      60,
    ),
    "returned",
  );
  // a turn that handed nothing over has nothing to be judged
  assert.equal(labelOf(scan("p8", 0, [], "STATUS"), [mailed("p8", 2, "REJECT: wrong direction")], now, 60), null);

  const scans = [
    scan("p1", 0, model(0.95)),
    above(3, "failed"), // sent back, and the Lead's own run had failed
    scan("p2", 10, model(0.9)),
    above(12, "passed"), // sent back for something else: the Lead's run passed
    scan("p3", 20, model(0.2)),
    scan("p4", 30, model(0.1)),
    scan("p5", 40, []),
    scan("p6", 50, model(0.5)),
    scan("p7", 60, model(0.7)),
    above(66), // sent back, and the Lead ran no test: nothing shows why
    above(80, "failed"), // a later turn of the Lead, after that verdict: it says nothing of p7
  ];
  const mail = [
    mailed("p1", 5, "REJECT p1: npm test fails"),
    mailed("p2", 15, "REVISED BRIEF"),
    mailed("p3", 25, "ACCEPT p3: fine"),
    mailed("p4", 35, "ACCEPT p4"),
    mailed("p5", 45, "REJECT p5"),
    mailed("p6", 140, "REJECT p6: too late to count"),
    mailed("p7", 65, "REJECT p7: one repair"),
  ];

  const result = calibrate(scans, mail, policy, now, REVISION);
  assert.deepEqual(
    [result.turns, result.reads, result.labelled, result.returned, result.returnedWithFinding],
    [11, 22, 6, 4, 3],
  );
  const rule = result.rules.find((r) => r.rule === "unverified-completion")!;
  assert.deepEqual(
    [rule.spoke, rule.labelled, rule.returned, rule.roc?.auroc, rule.operating?.threshold],
    [6, 4, 1, 1, 0.95],
  );
  assert.match(
    renderCalibration(result, policy),
    /^watched turns 11, read 22 times; .*\nunverified-completion \(model\): asked in 6 turns, mailed 0; 1\/4 of its labelled turns were sent back after a test failed for the seat above/,
  );
  // scores given under another revision of the questions are not mixed in
  assert.equal(
    calibrate(
      scans.map((s) => ({ ...s, rev: REVISION + 1 })),
      mail,
      policy,
      now,
      REVISION,
    ).turns,
    0,
  );
});
