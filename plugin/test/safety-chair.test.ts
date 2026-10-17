import { ROOM_HOME, shipSql } from "./support/room";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import councilCatalog from "../shared/safety/council.json";
import { traits } from "../shared/workflow";
import type { TurnEvent } from "../server/host";
import { Chair, type ChairDeps } from "../server/safety/council/chair";
import { Council, type CouncilPolicy, type HandInDiff, type TurnInput } from "../server/safety/council/council";
import { gamingOf, type GamingFile } from "../server/safety/council/gaming";
import { SafetyStore } from "../server/safety/store";
import { earnLevel3, found, standIn, storeIn } from "./support/council";

shipSql();

const redactModule = require("../server/redact") as typeof import("../server/redact");

const ROOT = "/work/echo";
const BRIEF = [
  "Outcome: parseDuration accepts hours.",
  "Write scope: src/duration.ts, test/**",
  "Non-goals: no change to the CLI",
  "Acceptance evidence: `npm test` passes",
].join("\n");
const shell = (command: string, exitCode: number | null = 0): TurnEvent => ({
  kind: "shell",
  command,
  exitCode,
  output: "ok",
  status: "completed",
});

const sourceFile: GamingFile = {
  path: "src/duration.ts",
  test: false,
  deleted: false,
  added: ["return hours * 3600000;"],
  removed: [],
};
const testFile = (removed: string[], added: string[]): GamingFile => ({
  path: "test/duration.test.ts",
  test: true,
  deleted: false,
  added,
  removed,
});
const ASSERT = (call: string, expected: string) => `  expect(${call}).toBe(${expected});`;

test("a diff shows tests bent to pass: assertions gone, expected values changed to fit, assertions loosened, tests deleted", () => {
  const dropped = gamingOf(
    [
      sourceFile,
      testFile(
        [ASSERT("parse('1h')", "3600000"), ASSERT("parse('2h')", "7200000"), ASSERT("parse('3h')", "10800000")],
        [ASSERT("parse('1h')", "3600000")],
      ),
    ],
    0,
  )!;
  assert.deepEqual([dropped.dropped, dropped.changed, dropped.loosened, dropped.sourceCount], [2, 0, 0, 1]);

  const fitted = gamingOf(
    [sourceFile, testFile([ASSERT("parse('2h')", "7200000")], [ASSERT("parse('2h')", "7200001")])],
    0,
  )!;
  assert.deepEqual([fitted.dropped, fitted.changed, fitted.loosened], [0, 1, 0]);
  assert.match(
    fitted.excerpt,
    /- expect\(parse\('2h'\)\)\.toBe\(7200000\);\n\+ expect\(parse\('2h'\)\)\.toBe\(7200001\);/,
  );

  const loosened = gamingOf(
    [sourceFile, testFile([ASSERT("parse('2h')", "7200000")], ["  expect(parse('2h')).toBeTruthy();"])],
    0,
  )!;
  assert.deepEqual([loosened.dropped, loosened.changed, loosened.loosened], [0, 0, 1]);

  const moved = gamingOf(
    [sourceFile, testFile([ASSERT("parse('2h')", "7200000")], [ASSERT("parse('2h')", "7200000")])],
    0,
  )!;
  assert.deepEqual(
    [moved.dropped, moved.changed, moved.loosened],
    [0, 0, 0],
    "a line removed and added as it was is no change",
  );

  const gone = gamingOf([sourceFile, { ...testFile([], []), deleted: true }], 2)!;
  assert.deepEqual([gone.deleted, gone.skipped, gone.excerpt], [1, 2, "test/duration.test.ts: deleted"]);
});

test("the lines a juror and the chair read are cut to a length and hide secrets", () => {
  const key = ["sk", "proj", "Abcdefghijklmnopqrstuvwx12"].join("-");
  const removed = Array.from({ length: 400 }, (_, i) => ASSERT(`call(${i}, "${key}")`, `${i}`));
  const big = gamingOf([sourceFile, testFile(removed, [])], 0)!;
  assert.ok(big.excerpt.length <= 3000);
  assert.ok(!big.excerpt.includes(key));
  assert.ok(big.excerpt.includes("***"));
});

let homes = 0;
const sent: { to: string; subject: string; body: string; needs: string }[] = [];

/** A council, a chair and a store sharing one clock; `answers` are the scores the decision district gives, in order. */
function harness(
  options: {
    levels?: CouncilPolicy["levels"];
    answers?: number[];
    chairSeat?: string | null;
    diff?: HandInDiff | null;
  } = {},
) {
  const clock = { at: Date.parse("2026-03-01T10:00:00Z") };
  const store = storeIn(`chair-${(homes += 1)}`, () => new Date(clock.at));
  const mails = ((sent.length = 0), sent);
  const logs: string[] = [];
  const room: ChairDeps = {
    seat: () => (options.chairSeat === undefined ? "hq" : options.chairSeat),
    isChair: (id) => id === "hq",
    ownerOf: (id) => (id === "peer-1" ? "lead-1" : null),
    titleOf: (id) => `[Peer] ${id}`,
    tell: async (to, mail) => void mails.push({ to, ...mail }),
  };
  const chair = new Chair({ room, store: () => store, minutes: () => undefined, log: (line) => logs.push(line) });
  const answers = [...(options.answers ?? [])];
  // as the decision district does, the same question about the same state is answered from memory
  const { decider, asked, phrased } = standIn(() => answers.shift() ?? 0, true);
  let diff = options.diff === undefined ? null : options.diff;
  const council = new Council({
    store: () => store,
    decider: options.answers ? decider : null,
    policy: () => ({ mode: "on", keepDays: 90, tickSeconds: 60, levels: options.levels ?? {} }),
    log: (line) => logs.push(line),
    now: () => clock.at,
    diffOf: () => {
      const given = diff;
      diff = null;
      return given;
    },
    chair,
  });
  return {
    council,
    store,
    chair,
    clock,
    mails,
    logs,
    asked,
    phrased,
    answers,
    setDiff: (next: HandInDiff | null) => (diff = next),
  };
}
type Harness = ReturnType<typeof harness>;

/** Right findings of a member over eight tasks, labelled by the seat above: sixty earn level 3. */
const earn = (h: Harness, member: keyof typeof councilCatalog.members, labels = 60) =>
  earnLevel3(
    h.store,
    member,
    (id) => h.council.label(id, "seat:lead-1", "right", "the finding was right"),
    undefined,
    labels,
  );

const BENT: HandInDiff = {
  gaming: gamingOf([sourceFile, testFile([ASSERT("parse('1h')", "3600000"), ASSERT("parse('2h')", "7200000")], [])], 0),
  returned: false,
};
const SOFT: HandInDiff = {
  gaming: gamingOf([sourceFile, testFile([ASSERT("parse('2h')", "7200000")], [ASSERT("parse('2h')", "7200001")])], 0),
  returned: false,
};

const candidate = (text = "CANDIDATE: hours added", events: TurnEvent[] = [shell("npm test", 1)]): TurnInput => ({
  seat: { id: "peer-1", role: "peer", traits: traits("peer"), root: ROOT, task: "task-1" },
  turn: "t1",
  events,
  text,
  brief: BRIEF,
  verdicts: [],
});
const gaming = (found: Awaited<ReturnType<Council["endOfTurn"]>>) => found.filter((one) => one.member === "gaming");
const rows = (h: Harness) => h.store.councilCounts("2000-01-01").find((row) => row.member === "gaming");

test("gaming reads a candidate's diff: firm signs are a found reading, logged at level 0 and shown at level 1", async () => {
  const quiet = harness({ diff: BENT });
  assert.deepEqual(await quiet.council.endOfTurn(candidate()), []);
  assert.deepEqual([rows(quiet)?.readings, rows(quiet)?.found, rows(quiet)?.shown], [1, 1, 0]);

  const loud = harness({ levels: { gaming: 1 }, diff: BENT });
  const found = gaming(await loud.council.endOfTurn(candidate()));
  assert.match(
    found[0].line,
    /^gaming #\d+: tests were bent while 1 code file\(s\) changed: 2 assertion\(s\) removed$/,
  );
  loud.setDiff(BENT);
  assert.equal(
    gaming(await loud.council.endOfTurn({ ...candidate(), turn: "t2" })).length,
    1,
    "a finding is not told until its line has reached the seat above",
  );
  loud.council.shown(found);
  loud.setDiff(BENT);
  assert.deepEqual(
    gaming(await loud.council.endOfTurn({ ...candidate(), turn: "t3" })),
    [],
    "the same finding is not said twice",
  );
});

test("gaming has no reading without a diff, outside a candidate, or with no test file in it; tests with no code beside them are read clear", async () => {
  const none = harness({ levels: { gaming: 1 }, diff: null });
  await none.council.endOfTurn(candidate());
  assert.equal(rows(none), undefined);
  const status = harness({ levels: { gaming: 1 }, diff: BENT });
  await status.council.endOfTurn(candidate("STATUS: working"));
  assert.equal(rows(status), undefined);
  const noTests = harness({ levels: { gaming: 1 }, diff: { gaming: gamingOf([sourceFile], 0), returned: false } });
  await noTests.council.endOfTurn(candidate());
  assert.equal(rows(noTests), undefined);
  const testsOnly = harness({
    levels: { gaming: 1 },
    diff: { gaming: gamingOf([testFile([ASSERT("a", "1")], [])], 0), returned: false },
  });
  assert.deepEqual(gaming(await testsOnly.council.endOfTurn(candidate())), []);
  assert.deepEqual([rows(testsOnly)?.readings, rows(testsOnly)?.found], [1, 0]);
});

test("softer signs are put to a juror; its grey band keeps it quiet and a high score is a finding", async () => {
  const h = harness({ levels: { gaming: 1 }, answers: [0.95, 0.5, 0.02], diff: SOFT });
  const first = gaming(await h.council.endOfTurn(candidate()));
  assert.match(
    first[0].line,
    /^gaming #\d+: tests were bent while 1 code file\(s\) changed: 1 expected value\(s\) changed to fit \(0\.95\)$/,
  );
  const state = h.asked[0] as { excerpt: string; sourceFiles: string[]; outcome: string };
  assert.deepEqual([state.sourceFiles, state.outcome], [["src/duration.ts"], "parseDuration accepts hours."]);
  assert.match(state.excerpt, /7200001/);
  h.setDiff({
    ...SOFT,
    gaming: gamingOf(
      [sourceFile, testFile([ASSERT("parse('3h')", "10800000")], [ASSERT("parse('3h')", "10800001")])],
      0,
    ),
  });
  assert.deepEqual(
    gaming(await h.council.endOfTurn({ ...candidate(), turn: "t2" })),
    [],
    "between lo and hi nothing is said",
  );
  h.setDiff({
    ...SOFT,
    gaming: gamingOf(
      [sourceFile, testFile([ASSERT("parse('4h')", "14400000")], [ASSERT("parse('4h')", "14400001")])],
      0,
    ),
  });
  assert.deepEqual(gaming(await h.council.endOfTurn({ ...candidate(), turn: "t3" })), []);
  assert.deepEqual([rows(h)?.found, rows(h)?.grey], [1, 1]);
  assert.equal(h.mails.length, 0, "below level 3 the chair is not asked");
});

test("the level that sends work back comes only from labels, and only to a member that may send it", async () => {
  const pinned = harness({ levels: { gaming: 3, stuck: 3, claims: 2 } });
  assert.deepEqual(
    [pinned.council.level("gaming"), pinned.council.level("stuck"), pinned.council.level("claims")],
    [2, 2, 2],
  );
  const h = harness();
  await earn(h, "gaming", 59);
  assert.equal(h.council.level("gaming"), 2, "59 labels are not 60");
  await earn(h, "claims");
  await earn(h, "scope");
  await earn(h, "stuck");
  await earn(h, "gaming");
  assert.deepEqual(
    ["claims", "scope", "gaming", "stuck"].map((member) => h.council.level(member as "claims")),
    [3, 3, 3, 2],
    "stuck cannot send a hand-in back, however well it is labelled",
  );
});

test("a member at the level that sends work back asks the chair, with the evidence, and the seat does not wait", async () => {
  const h = harness({ diff: BENT });
  await earn(h, "gaming");
  const shown = gaming(
    await h.council.endOfTurn(candidate("CANDIDATE: hours added", [shell("npm test", 1), shell("git diff")])),
  );
  assert.equal(shown[0].level, 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.mails.length, 1);
  const [mail] = h.mails;
  assert.equal(mail.to, "hq");
  assert.match(mail.subject, /^APPEAL #1: gaming on \[Peer\] peer-1's candidate$/);
  for (const part of [
    "Why you are asked: the member found it",
    "Finding: gaming #",
    "2 assertion(s) removed",
    "Readings: fact found",
    "- npm test (1)",
    "- git diff (0)",
    "The changes, filtered:",
    "- expect(parse('1h')).toBe(3600000);",
    "Outcome: parseDuration accepts hours.",
    "Write scope: src/duration.ts, test/**",
    "Non-goals: no change to the CLI",
    "Acceptance: `npm test` passes",
    "seatwork_safety action=rule id=1 send_back=true or false",
    "within 30 minutes",
  ])
    assert.ok(mail.body.includes(part), part);
  const row = h.store.appeal(1)!;
  assert.deepEqual(
    [row.status, row.chair, row.seat, row.member, row.due_at],
    ["open", "hq", "peer-1", "gaming", "2026-03-01T10:30:00.000Z"],
  );
});

test("no appeal without a candidate, a chair, a hand-in left standing, or the level; and one finding is asked once", async () => {
  const wait = () => new Promise((resolve) => setImmediate(resolve));
  const status = harness({ diff: BENT });
  await earn(status, "gaming");
  await status.council.endOfTurn(candidate("STATUS: still working"));
  await wait();
  assert.equal(status.mails.length, 0, "a turn that hands in no candidate has nothing to send back");

  const returned = harness({ diff: { ...BENT, returned: true } });
  await earn(returned, "gaming");
  await returned.council.endOfTurn(candidate());
  await wait();
  assert.equal(returned.mails.length, 0, "the room sent it back already");

  const nobody = harness({ diff: BENT, chairSeat: null });
  await earn(nobody, "gaming");
  await nobody.council.endOfTurn(candidate());
  await wait();
  assert.equal(nobody.mails.length, 0);

  const low = harness({ diff: BENT, levels: { gaming: 2 } });
  await earn(low, "gaming");
  await low.council.endOfTurn(candidate());
  await wait();
  assert.equal(low.mails.length, 0, "a level pinned under 3 does not ask");

  const once = harness({ diff: BENT });
  await earn(once, "gaming");
  await once.council.endOfTurn(candidate());
  once.setDiff(BENT);
  await once.council.endOfTurn({ ...candidate(), turn: "t2" });
  await wait();
  assert.equal(once.mails.length, 1, "the same finding waiting for a ruling is not asked again");
  assert.equal(
    await once.chair.rule("hq", 1, false, "The tests are fine as they are."),
    "Noted: appeal #1 is upheld, the candidate stays with its Owner.",
  );
  once.setDiff(BENT);
  await once.council.endOfTurn({ ...candidate(), turn: "t3" });
  await wait();
  assert.equal(once.mails.length, 1, "nor one the chair upheld");
});

test("at most a set number of appeals wait at once; the rest are left, and the room hears of it", async () => {
  const h = harness();
  await earn(h, "gaming");
  for (let i = 0; i < 8; i += 1) {
    h.setDiff({ returned: false, gaming: gamingOf([sourceFile, testFile([ASSERT(`parse('${i}h')`, `${i}`)], [])], 0) });
    await h.council.endOfTurn({ ...candidate(), seat: { ...candidate().seat, id: `peer-${i}` }, turn: `t${i}` });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.mails.length, 6);
  assert.equal(h.store.openAppeals(), 6);
  assert.ok(h.logs.some((line) => /the chair has 6 appeals to rule/.test(line)));
});

test("the chair sends a candidate back with its reason, to the seat and to its Owner; only the room's seat may rule, once", async () => {
  const h = harness({ diff: BENT });
  await earn(h, "gaming");
  await h.council.endOfTurn(candidate());
  await new Promise((resolve) => setImmediate(resolve));
  h.mails.length = 0;
  assert.equal(
    await h.chair.rule("lead-1", 1, true, "I agree with the finding."),
    "Only the room's own seat rules on appeals.",
  );
  assert.equal(
    await h.chair.rule("hq", 9, true, "I agree with the finding."),
    "No appeal #9: copy the number from the APPEAL mail.",
  );
  assert.equal(h.mails.length, 0);
  assert.equal(
    await h.chair.rule("hq", 1, true, "Two assertions went and the code changed; the outcome does not call for it."),
    "Sent back: [Peer] peer-1 is told, with your reason.",
  );
  const [seat, owner] = h.mails;
  assert.deepEqual([seat.to, seat.needs], ["peer-1", "reply"]);
  assert.match(seat.subject, /^HAND-IN RETURNED: the chair sent your candidate back \(gaming\)$/);
  assert.match(
    seat.body,
    /The chair's reason: Two assertions went and the code changed; the outcome does not call for it\./,
  );
  assert.match(seat.body, /Finding: gaming #\d+: tests were bent/);
  assert.deepEqual([owner.to, owner.needs], ["lead-1", "nothing"]);
  assert.match(owner.subject, /^COUNCIL: the chair sent \[Peer\] peer-1's hand-in back$/);
  assert.equal(h.store.appeal(1)?.status, "sent_back");
  assert.equal(
    await h.chair.rule("hq", 1, false, "Changed my mind about the finding."),
    "Appeal #1 was ruled already (sent_back).",
  );
  assert.equal(h.mails.length, 2);
});

test("a chair that does not rule in time sends nothing back, and the finding may be asked again", async () => {
  const h = harness({ diff: BENT });
  await earn(h, "gaming");
  await h.council.endOfTurn(candidate());
  await new Promise((resolve) => setImmediate(resolve));
  h.mails.length = 0;
  h.clock.at += 31 * 60_000;
  assert.equal(h.store.openAppeals(), 0);
  assert.equal(
    await h.chair.rule("hq", 1, true, "Too late, but the finding is right."),
    "Appeal #1 lapsed before you ruled: nothing is sent back, and the seat did not wait.",
  );
  assert.equal(h.mails.length, 0);
  h.setDiff(BENT);
  await h.council.endOfTurn({ ...candidate(), turn: "t2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.mails.length, 1, "a lapsed appeal does not stop the next one");
  assert.match(h.mails[0].subject, /^APPEAL #2:/);
});

test("a store made before appeals named their readings keeps those whose reading stands and drops the rest", () => {
  const dir = join(ROOM_HOME, "appeals-migrate");
  const scripts = join(ROOM_HOME, "appeals-migrate-scripts");
  rmSync(dir, { recursive: true, force: true });
  rmSync(scripts, { recursive: true, force: true });
  mkdirSync(scripts, { recursive: true });
  const shipped = join(ROOM_HOME, "room", "sql", "safety");
  for (const name of readdirSync(shipped).filter((script) => !/^V10__/.test(script)))
    copyFileSync(join(shipped, name), join(scripts, name));
  const before = new SafetyStore(dir, 1000, () => new Date("2026-02-01T00:00:00Z"), scripts);
  const appeal = (readingId: number, finding: string) =>
    before.addAppeal({ readingId, member: "gaming", seat: "s", finding, chair: "hq", packet: "{}", dueInMs: 60_000 });
  const stands = appeal(before.read(found("gaming", "s")), "kept");
  const orphan = appeal(999, "its reading is gone");
  before.close();
  const after = new SafetyStore(dir, 1000, () => new Date("2026-02-02T00:00:00Z"));
  assert.equal(after.appeal(stands)?.finding, "kept");
  assert.equal(after.appeal(orphan), null);
  after.close();
});

test("the time to answer is the policy's when it sets one", async () => {
  const h = harness({ diff: BENT });
  const slow = new Chair({
    room: { seat: () => "hq", isChair: () => true, ownerOf: () => null, titleOf: (id) => id, tell: async () => {} },
    store: () => h.store,
    minutes: () => 5,
    log: () => {},
  });
  const id = await slow.appeal({
    reading: h.store.read(found("gaming", "s")),
    member: "gaming",
    seat: "s",
    finding: "f",
    packet: { member: "gaming", why: "found", finding: "x", readings: [], commands: [], brief: {} },
  });
  assert.equal(h.store.appeal(id!)?.due_at, "2026-03-01T10:05:00.000Z");
});

test("an unsure juror, a juror that answers differently the second time, or one the facts contradict, goes to the chair", async () => {
  const wait = () => new Promise((resolve) => setImmediate(resolve));
  // firm signs and a juror that finds nothing in the excerpt: contradiction
  const contradicted = harness({ diff: BENT, answers: [0.03] });
  await earn(contradicted, "gaming");
  await contradicted.council.endOfTurn(candidate());
  await wait();
  assert.equal(contradicted.asked.length, 1);
  assert.match(
    contradicted.mails[0].body,
    /Why you are asked: the facts and the reading of the excerpt contradict each other/,
  );
  assert.match(contradicted.mails[0].body, /Readings: fact grey; juror grey 0\.03/);

  // soft signs: asked twice, the answers part company
  const split = harness({ diff: SOFT, answers: [0.95, 0.04] });
  await earn(split, "gaming");
  await split.council.endOfTurn(candidate());
  await wait();
  assert.equal(split.asked.length, 2);
  assert.deepEqual(
    split.phrased,
    [councilCatalog.members.gaming.question.instructions, councilCatalog.members.gaming.reworded.instructions],
    "the second reading asks the question said another way",
  );
  assert.match(split.mails[0].body, /Why you are asked: two readings of the same question disagreed/);
  assert.match(split.mails[0].body, /Readings: juror grey 0\.95; juror grey 0\.04/);

  // soft signs, both answers on the found side: a plain finding
  const sure = harness({ diff: SOFT, answers: [0.95, 0.97] });
  await earn(sure, "gaming");
  await sure.council.endOfTurn(candidate());
  await wait();
  assert.match(sure.mails[0].body, /Why you are asked: the member found it/);

  // an answer inside the grey band: unsure
  const unsure = harness({ diff: SOFT, answers: [0.5, 0.5] });
  await earn(unsure, "gaming");
  await unsure.council.endOfTurn(candidate());
  await wait();
  assert.match(unsure.mails[0].body, /Why you are asked: the member's reading fell between sure and clear/);

  // a clear first answer is not asked twice, and nothing goes to the chair
  const clear = harness({ diff: SOFT, answers: [0.02, 0.9] });
  await earn(clear, "gaming");
  await clear.council.endOfTurn(candidate());
  await wait();
  assert.deepEqual([clear.asked.length, clear.mails.length], [1, 0]);
});

test("the council's log keeps appeals a season and lets older ones go; an appeal whose time is up is marked lapsed first", () => {
  const h = harness();
  const appeal = (finding: string) =>
    h.store.addAppeal({
      readingId: h.store.read(found("gaming", "s")),
      member: "gaming",
      seat: "s",
      finding,
      chair: "hq",
      packet: "{}",
      dueInMs: 30 * 60_000,
    });
  const keep = appeal("a");
  h.clock.at += 40 * 86_400_000;
  const late = appeal("b");
  h.clock.at += 60 * 86_400_000;
  assert.equal(h.council.expire(), 2, "the one older than the 90 days goes, with its reading");
  assert.equal(h.store.appeal(keep), null);
  assert.equal(h.store.appeal(late)?.status, "lapsed");
});

test("an appeal names a reading the council kept: one that names none is refused, and a reading that goes takes its appeals", () => {
  const h = harness();
  const appeal = (readingId: number) =>
    h.store.addAppeal({
      readingId,
      member: "gaming",
      seat: "s",
      finding: "f",
      chair: "hq",
      packet: "{}",
      dueInMs: 60_000,
    });
  const reading = h.store.read(found("gaming", "s"));
  assert.throws(() => appeal(reading + 1), /FOREIGN KEY/);
  h.clock.at += 2 * 86_400_000;
  const id = appeal(reading);
  h.clock.at += 90 * 86_400_000 - 86_400_000;
  h.council.expire();
  assert.equal(h.store.appeal(id), null, "its reading went by age, unlabelled, and the appeal with it");
});

test("a seat that starts a turn is noted as seen, whether or not the council reads it, and a failure to note it is no failure of the turn", () => {
  const seen: string[] = [];
  const base = {
    store: () => harness().store,
    decider: null,
    policy: () => ({ mode: "off" as const, keepDays: 90, tickSeconds: 60 }),
    log: () => {},
  };
  const council = new Council({ ...base, seen: (seat) => void seen.push(seat) });
  council.turnStarted("peer-1", ROOT);
  assert.deepEqual(seen, ["peer-1"]);
  const broken = new Council({
    ...base,
    seen: () => {
      throw new Error("busy");
    },
  });
  assert.doesNotThrow(() => broken.turnStarted("peer-1", ROOT));
});

test("an appeal's evidence is kept whole and bounded, however much the turn ran and the brief says", async () => {
  const h = harness({
    diff: {
      gaming: gamingOf(
        [
          sourceFile,
          testFile(
            Array.from({ length: 200 }, (_, i) => ASSERT(`f(${i})`, `${i}`)),
            [],
          ),
        ],
        0,
      ),
      returned: false,
    },
  });
  await earn(h, "gaming");
  const long = "x".repeat(100_000);
  const events = Array.from({ length: 40 }, (_, i) => shell(`run ${i} ${long}`, 1));
  const input = {
    ...candidate("CANDIDATE: hours added", events),
    brief: `Outcome: ${long}\nWrite scope: ${long}\nNon-goals: ${long}`,
  };
  await h.council.endOfTurn(input);
  await new Promise((resolve) => setImmediate(resolve));
  const row = h.store.appeal(1)!;
  assert.ok(row.packet.length <= 8000);
  const packet = JSON.parse(row.packet);
  assert.equal(packet.member, "gaming");
  assert.ok(packet.commands.length <= 10 && packet.commands.every((c: { command: string }) => c.command.length <= 201));
  assert.ok(h.mails[0].body.length < 12_000);
  assert.match(await h.chair.rule("hq", 1, true, "Two hundred checks went while the code changed."), /^Sent back/);
});

test("a packet past the limit loses its diff, then its commands, and stays whole JSON", async () => {
  const h = harness();
  const big = {
    member: "gaming",
    why: "found" as const,
    finding: "gaming: x",
    readings: [],
    commands: Array.from({ length: 10 }, () => ({ command: "y".repeat(1000), exit: 0 })),
    diff: "z".repeat(3000),
    brief: {},
  };
  const id = await new Chair({
    room: { seat: () => "hq", isChair: () => true, ownerOf: () => null, titleOf: (seat) => seat, tell: async () => {} },
    store: () => h.store,
    minutes: () => undefined,
    log: () => {},
  }).appeal({ reading: h.store.read(found("gaming", "s")), member: "gaming", seat: "s", finding: "f", packet: big });
  const kept = JSON.parse(h.store.appeal(id!)!.packet);
  assert.deepEqual([kept.diff, kept.commands.length], [undefined, 0]);
});

test("the lines read of a diff stop at what is shown, however many test files changed", () => {
  const seen: number[] = [];
  const real = redactModule.redact;
  redactModule.redact = (text: string) => (seen.push(text.length), real(text));
  try {
    const files = Array.from({ length: 3000 }, (_, i) => ({
      ...testFile(
        Array.from({ length: 20 }, (_, n) => ASSERT(`f${i}(${n})`, `${n}`)),
        [],
      ),
      path: `test/file${i}.test.ts`,
    }));
    const evidence = gamingOf([sourceFile, ...files], 0)!;
    assert.equal(evidence.dropped, 3000 * 20);
    assert.ok(evidence.excerpt.length <= 3000);
    assert.ok(Math.max(...seen) <= 4000, `redaction read ${Math.max(...seen)} characters`);
  } finally {
    redactModule.redact = real;
  }
});
