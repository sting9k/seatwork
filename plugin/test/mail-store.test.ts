import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MailStore, MailStoreError, type NewMessage } from "../server/coordination/store";

const base = mkdtempSync(join(tmpdir(), "seatwork-mail-store-"));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));

const SCRIPTS = join(__dirname, "..", "room", "sql", "mail");
let folders = 0;
/** A store of its own, with a clock that moves a second at every reading. */
function fresh(): { store: MailStore; dir: string } {
  const dir = join(base, `store-${(folders += 1)}`);
  let tick = Date.parse("2026-10-14T00:00:00Z");
  return { store: new MailStore(dir, 2000, () => new Date((tick += 1000)), SCRIPTS), dir };
}

const mail = (sender: string, subject: string, extra: Partial<NewMessage> = {}): NewMessage => ({
  sender,
  senderRole: "peer",
  signal: subject.split(":")[0],
  subject,
  body: "the offset index is rebuilt on every append",
  needs: "nothing",
  fingerprint: `${sender}|${subject}`,
  ...extra,
});

test("a message is stored once with a line per recipient, and a thread of its own when it joins none", () => {
  const { store } = fresh();
  const first = store.insert(mail("lead", "INSTRUCTION: rebase"), [
    { seat: "p1", kind: "to", priority: "action" },
    { seat: "p2", kind: "cc", priority: "fyi", quiet: true },
  ]);
  assert.equal(first.thread, `m${first.id}`);
  assert.deepEqual(
    store.deliveries(first.id).map((d) => [d.seat, d.kind, d.state, d.quiet]),
    [
      ["p1", "to", "queued", false],
      ["p2", "cc", "queued", true],
    ],
  );
  const reply = store.insert(mail("p1", "ACK: rebased", { thread: first.thread, replyTo: first.id }), [
    { seat: "lead", kind: "to", priority: "fyi" },
  ]);
  assert.deepEqual(
    store.thread(first.thread, null, 10).map((m) => m.id),
    [first.id, reply.id],
  );
  assert.equal(store.count(), 2);
});

test("what waits for a seat is handed out oldest first, and a settled delivery waits no longer", () => {
  const { store } = fresh();
  const a = store.insert(mail("lead", "ANSWER: use the v2 format"), [{ seat: "p1", kind: "to", priority: "blocking" }]);
  const b = store.insert(mail("lead", "FYI: main moved"), [{ seat: "p1", kind: "to", priority: "fyi" }]);
  assert.deepEqual(
    store.queued("p1").map((m) => m.id),
    [a.id, b.id],
  );
  assert.deepEqual([...store.waiting()], [["p1", { count: 2, since: a.at }]]);
  store.mark("p1", [a.id], "sending");
  assert.equal(store.queued("p1")[0].state, "sending");
  store.mark("p1", [a.id, b.id], "delivered", "idle");
  assert.deepEqual(store.queued("p1"), []);
  const [done] = store.deliveries(a.id);
  assert.equal(done.state, "delivered");
  assert.equal(done.how, "idle");
  assert.ok(done.deliveredAt);
});

test("a report kept for its sender's turn end goes out once, to the Owner the seat has by then", () => {
  const { store } = fresh();
  const report = store.insert(mail("p1", "CANDIDATE: store", { needs: "reply" }), [
    { seat: "lead", kind: "to", priority: "action", state: "kept" },
  ]);
  assert.deepEqual(store.queued("lead"), []);
  assert.equal(store.kept("p1")[0].id, report.id);
  assert.deepEqual(store.posted("2026-01-01"), []);
  store.mark("lead", [report.id], "withdrawn");
  store.revise(report.id, { body: "the offset index\n\n[room] second candidate" });
  store.revive(report.id, "lead-2");
  assert.deepEqual(
    store.queued("lead-2").map((m) => [m.id, m.body]),
    [[report.id, "the offset index\n\n[room] second candidate"]],
  );
  assert.deepEqual(
    store.posted("2026-01-01").map((line) => [line.from, line.to, line.subject]),
    [["p1", "lead-2", "CANDIDATE: store"]],
  );
});

test("an ask is owed until its answer; the first answer stands", () => {
  const { store } = fresh();
  const ask = store.insert(mail("p1", "QUESTION: which format?", { needs: "decision" }), [
    { seat: "lead", kind: "to", priority: "action" },
  ]);
  assert.deepEqual(store.owedBy("lead"), [], "not owed before it arrived");
  store.mark("lead", [ask.id], "delivered", "idle");
  assert.deepEqual(
    store.owedBy("lead").map((m) => m.id),
    [ask.id],
  );
  assert.deepEqual(
    store.owedTo("p1").map((m) => m.id),
    [ask.id],
  );
  assert.equal(store.openAsk("p1", "lead")?.id, ask.id);
  assert.equal(store.openAsk("p1", "lead", "another-thread"), null);
  const answer = store.insert(mail("lead", "ANSWER: v2"), [{ seat: "p1", kind: "to", priority: "blocking" }]);
  assert.equal(store.answer(ask.id, answer.id), true);
  assert.equal(store.answer(ask.id, answer.id + 1), false);
  assert.equal(store.get(ask.id)?.answeredBy, answer.id);
  assert.deepEqual(store.owedBy("lead"), []);
  assert.deepEqual(store.owedTo("p1"), []);
});

test("a retry of the same text is found by its print, and a key by the text it was first used for", () => {
  const { store } = fresh();
  const first = store.insert(mail("p1", "STATUS: half way", { fingerprint: "print-1", key: "k1" }), [
    { seat: "lead", kind: "to", priority: "fyi" },
  ]);
  assert.equal(store.duplicate("p1", "print-1", "2026-10-13T00:00:00Z")?.id, first.id);
  assert.equal(store.duplicate("p1", "print-1", "2027-01-01T00:00:00Z"), null, "outside the window");
  assert.equal(store.duplicate("p2", "print-1", "2026-10-13T00:00:00Z"), null, "another sender");
  assert.deepEqual(store.byKey("p1", "k1", "2026-10-13T00:00:00Z")?.fingerprint, "print-1");
  assert.equal(store.byKey("p1", "k2", "2026-10-13T00:00:00Z"), null);
});

test("a reader sees the mail it wrote or got, and the mail of the seats it is handed", () => {
  const { store } = fresh();
  const mine = store.insert(mail("p1", "CANDIDATE: offset index"), [{ seat: "lead", kind: "to", priority: "action" }]);
  const other = store.insert(mail("p2", "CANDIDATE: tax table", { body: "the offset of the tax table" }), [
    { seat: "lead-b", kind: "to", priority: "action" },
  ]);
  assert.equal(store.seen(mine.id, ["p1"]), true);
  assert.equal(store.seen(mine.id, ["lead"]), true);
  assert.equal(store.seen(other.id, ["p1", "lead"]), false);
  assert.deepEqual(
    store.search("offset", ["p1"], { limit: 10 }).map((hit) => hit.id),
    [mine.id],
  );
  assert.deepEqual(
    store
      .search("offset", null, { limit: 10 })
      .map((hit) => hit.id)
      .sort(),
    [mine.id, other.id],
  );
  assert.deepEqual(
    store.search("tax tab", null, { limit: 10, signal: "CANDIDATE" }).map((hit) => hit.id),
    [other.id],
    "the last word may be the start of one",
  );
  assert.deepEqual(store.search('"*) OR 1', null, { limit: 10 }), [], "odd input is no query");
  assert.match(store.search("offset", ["p1"], { limit: 1 })[0].snippet, /\[offset\]/);
});

test("mail that waits for a replaced seat waits for its successor; what it already got stays its own", () => {
  const { store } = fresh();
  const read = store.insert(mail("lead", "ANSWER: one"), [{ seat: "old", kind: "to", priority: "action" }]);
  store.mark("old", [read.id], "delivered", "idle");
  const waiting = store.insert(mail("lead", "ANSWER: two"), [{ seat: "old", kind: "to", priority: "action" }]);
  assert.equal(store.readdress("old", "new"), 1);
  assert.deepEqual(
    store.queued("new").map((m) => m.id),
    [waiting.id],
  );
  assert.equal(store.deliveries(read.id)[0].seat, "old");
});

test("pruning drops finished mail and the posted lines older than the line, and keeps what still waits or is owed", () => {
  const { store } = fresh();
  const done = store.insert(mail("lead", "ACCEPT: store"), [{ seat: "p1", kind: "to", priority: "action" }]);
  store.revise(done.id, { file: "/tmp/a.md" });
  store.mark("p1", [done.id], "delivered", "idle");
  const waiting = store.insert(mail("lead", "FYI: still queued"), [{ seat: "p1", kind: "to", priority: "fyi" }]);
  const owed = store.insert(mail("p1", "QUESTION: open", { needs: "reply" }), [
    { seat: "lead", kind: "to", priority: "action" },
  ]);
  store.mark("lead", [owed.id], "delivered", "idle");
  const pruned = store.prune("2027-01-01T00:00:00Z");
  assert.deepEqual(pruned, { messages: 1, files: ["/tmp/a.md"], threads: [`m${done.id}`], ids: new Set([done.id]) });
  assert.equal(store.get(done.id), null);
  assert.ok(store.get(waiting.id) && store.get(owed.id));
  assert.deepEqual(store.posted("2026-01-01"), []);
  assert.deepEqual(
    store
      .search("offset", null, { limit: 10 })
      .map((hit) => hit.id)
      .sort(),
    [waiting.id, owed.id],
  );
});

test("a damaged database is set aside, kept beside the new one, and a new one started", () => {
  const { store, dir } = fresh();
  store.insert(mail("lead", "FYI: one"), [{ seat: "p1", kind: "to", priority: "fyi" }]);
  store.close();
  writeFileSync(join(dir, "mail.db"), "not a database at all");
  const again = new MailStore(dir, 2000, undefined, SCRIPTS);
  assert.equal(again.startedOver, true);
  assert.equal(again.count(), 0);
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("mail.db.damaged-")).length, 1);
  again.close();
});

test("every query the store runs is served by an index, but the rare whole-store ones named here with their reason", () => {
  const { store } = fresh();
  const ask = store.insert(mail("p1", "QUESTION: which unit", { needs: "reply" }), [
    { seat: "lead", kind: "to", priority: "action" },
    { seat: "p2", kind: "cc", priority: "fyi", quiet: true },
  ]);
  const answer = store.insert(mail("lead", "ANSWER: seconds", { thread: ask.thread, replyTo: ask.id }), [
    { seat: "p1", kind: "to", priority: "action" },
  ]);
  store.answer(ask.id, answer.id);
  store.queued("lead");
  store.waiting();
  store.owedBy("lead");
  store.owedTo("p1");
  store.duplicate("p1", "p1|QUESTION: which unit", "2026");
  store.byKey("p1", "k", "2026");
  store.thread(ask.thread, ["lead"], 10);
  store.sent("p1", 10);
  store.received("lead", 10, { signal: "QUESTION" });
  store.search("unit", ["lead"], { limit: 5 });
  store.posted("2026");
  store.openAsk("p1", "lead");
  store.kept();
  store.seen(ask.id, ["lead"]);
  store.mark("lead", [ask.id], "delivered", "idle");
  store.refusals("2026");
  store.expire("2026");
  // on request or by GC, never in a seat's turn: room stats, a successor's threads, the count, the prune
  const rare = [
    "SELECT at, answered_at FROM messages",
    "SELECT m.thread, max(m.id)",
    "SELECT count(*) AS n FROM messages",
    "SELECT m.id, m.file, m.thread FROM messages m WHERE m.at < ?",
    "DELETE FROM events WHERE at < ?",
  ];
  store.replies("2026");
  store.threadsOf("lead", 5);
  store.prune("2026");
  const scans = store
    .plans()
    .filter(({ plan }) => /\bSCAN (messages|deliveries|events|m|d)\b(?! USING)/.test(plan))
    .filter(({ sql }) => !rare.some((known) => sql.replace(/\s+/g, " ").includes(known)));
  assert.deepEqual(scans, []);
});

test("mail sent only to be read and never read is withdrawn as expired once it is old; an ask, or mail that starts a turn, never is", () => {
  const { store } = fresh();
  const notice = store.insert(mail("lead", "FYI: main moved"), [
    { seat: "p1", kind: "cc", priority: "fyi", quiet: true },
  ]);
  const ask = store.insert(mail("lead", "QUESTION: which unit", { needs: "reply" }), [
    { seat: "p1", kind: "to", priority: "fyi", quiet: true },
  ]);
  const loud = store.insert(mail("lead", "INSTRUCTION: rebase"), [{ seat: "p1", kind: "to", priority: "action" }]);
  assert.equal(store.expire("2026-10-14T00:00:00Z"), 0);
  assert.equal(store.expire("2026-10-15T00:00:00Z"), 1);
  assert.deepEqual(
    store.queued("p1").map((m) => m.id),
    [ask.id, loud.id],
  );
  assert.deepEqual(
    store.deliveries(notice.id).map((d) => [d.state, d.how]),
    [["withdrawn", "expired"]],
  );
});

test("how asks are answered and what the tools refused are read from the store", () => {
  const { store } = fresh();
  const asked = store.insert(mail("p1", "QUESTION: which unit", { needs: "decision" }), [
    { seat: "lead", kind: "to", priority: "action" },
  ]);
  store.insert(mail("p1", "QUESTION: which rounding", { needs: "reply" }), [
    { seat: "lead", kind: "to", priority: "action" },
  ]);
  const answer = store.insert(mail("lead", "ANSWER: seconds"), [{ seat: "p1", kind: "to", priority: "action" }]);
  store.answer(asked.id, answer.id);
  for (const code of ["NO_SIGNAL", "ROUTE_REFUSED", "NO_SIGNAL"]) store.note("refused", "p1", { code });

  const replies = store.replies("2026-10-14T00:00:00Z");
  assert.equal(replies.open, 1);
  assert.equal(replies.minutes.length, 1);
  assert.ok(replies.minutes[0] > 0);
  assert.deepEqual(
    [...store.refusals("2026-10-14T00:00:00Z")],
    [
      ["NO_SIGNAL", 2],
      ["ROUTE_REFUSED", 1],
    ],
  );
});

test("a mail written while another process writes the store is refused as one to try again", () => {
  const { store, dir } = fresh();
  store.close();
  const slow = new MailStore(dir, 50, undefined, SCRIPTS);
  const other = new DatabaseSync(join(dir, "mail.db"));
  other.exec("BEGIN IMMEDIATE");
  assert.throws(
    () => slow.insert(mail("lead", "FYI: one"), [{ seat: "p1", kind: "to", priority: "fyi" }]),
    (error: unknown) => error instanceof MailStoreError && error.code === "DATABASE_LOCKED",
  );
  other.exec("COMMIT");
  other.close();
  assert.equal(
    slow.insert(mail("lead", "FYI: one"), [{ seat: "p1", kind: "to", priority: "fyi" }]).subject,
    "FYI: one",
  );
  slow.close();
});
