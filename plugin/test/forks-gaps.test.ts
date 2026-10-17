import { shipSql } from "./support/room";
import forkCatalog from "../shared/forks.json";
import { forksWith, freshStore, modelSaying, RULES } from "./forks-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NewMail, SeatRecord } from "../server/coordination/engine";
import type { ForkName } from "../server/orchestration/forks";
import { afterWork, type WorkForkDeps } from "../server/orchestration/work-forks";
import { WorkStore } from "../server/tasks/store";
import { work } from "../server/tasks/tools";

shipSql();

const record = (agentId: string, role: string, parent: string | null): SeatRecord => ({
  agentId,
  parentAgentId: parent,
  role,
  provider: `claude-${role}`,
  title: `[${role}] ${agentId}`,
});
const SEATS = [record("boss", "supervisor", null), record("lead", "lead", "boss"), record("peer", "peer", "lead")];

/** A room with the chain boss > lead > peer, a decision model, and the mail it posted. */
function roomOf(model: ReturnType<typeof modelSaying>, on: readonly ForkName[], gone: readonly string[] = []) {
  const posted: NewMail[] = [];
  const { forks, lines } = forksWith(model.router, on);
  const deps: WorkForkDeps = {
    forks,
    log: (line) => lines.push(line),
    engine: {
      seat: (id) => SEATS.find((one) => one.agentId === id),
      parentOf: (id) => SEATS.find((one) => one.agentId === id)?.parentAgentId ?? null,
      folderOf: () => "project",
      recipientStatus: async (id) => (gone.includes(id) ? "gone" : "idle"),
      post: async (mail: NewMail) => {
        posted.push(mail);
        return {} as never;
      },
    },
  };
  return { deps, posted, lines };
}

/** The seat's claim of an issue as the room's tool runs it. */
async function claims(deps: WorkForkDeps, store: WorkStore, id: string, seat = "peer") {
  const args = { do: "claim", id };
  const done = work(store, RULES, { id: seat, owner: false }, args);
  return (await afterWork(deps, store, seat, args, done)) as Record<string, unknown>;
}

const murky = (store: WorkStore, extra: object = {}) =>
  store.create(
    { title: "Make the export better", description: "It should be faster, or maybe smaller.", ...extra },
    "lead",
  );

test("an issue the decision model reads as ready, or as split, or with the fork off, is claimed as it always was", async () => {
  for (const [name, model, on] of [
    ["ready", modelSaying("ready"), ["gaps"]],
    ["split", modelSaying("unclear", 0.6), ["gaps"]],
    ["off", modelSaying("unclear"), []],
  ] as const) {
    const store = freshStore("forks-gaps");
    const { deps, posted } = roomOf(model, on);
    const issue = murky(store);
    const answer = await claims(deps, store, issue.id);
    assert.deepEqual(Object.keys(answer).sort(), ["assignee", "id", "issue_type", "priority", "status", "title"], name);
    assert.equal(posted.length, 0, name);
    assert.equal(store.get(issue.id).notes, "", `${name}: nothing was written`);
  }
});

test("the model is shown the issue's title, description, acceptance and scope, clipped, with the five labels the catalog gives", async () => {
  const store = freshStore("forks-gaps");
  const model = modelSaying("ready");
  const { deps } = roomOf(model, ["gaps"]);
  const issue = store.create(
    { title: "Add paging", description: "x".repeat(5000), acceptance_criteria: "Page two returns 20 rows." },
    "lead",
  );
  await claims(deps, store, issue.id);
  const [call] = model.asked;
  assert.equal(call.caller, "forks.gaps@1");
  assert.deepEqual(call.labels, ["ready", "unclear", "no-acceptance", "needs-decision", "too-big"]);
  const shown = call.state.issue as Record<string, string>;
  assert.equal(shown.acceptance, "Page two returns 20 rows.");
  assert.equal(shown.write_scope, "(none)");
  assert.ok(shown.description.length <= 1501, "a long description is clipped");
});

test("an unclear issue gets a Research child the claimer holds, which keeps the issue open, and the claim says what to do; it is made once", async () => {
  const store = freshStore("forks-gaps");
  const model = modelSaying("unclear");
  const { deps } = roomOf(model, ["gaps"]);
  const issue = murky(store);
  const answer = await claims(deps, store, issue.id);

  const child = store.get(`${issue.id}.1`);
  assert.equal(child.title, "Research: Make the export better");
  assert.deepEqual(
    [child.assignee, child.status, child.issue_type, child.created_by],
    ["peer", "in_progress", "question", "room"],
  );
  assert.deepEqual(
    store.blockers(issue.id),
    [`${child.id}:child-open`],
    "the issue cannot close while the research is open",
  );
  assert.match(String(answer.note), /search the room's record \(seatwork_knowledge\), the code and the docs/);
  assert.match(String(answer.note), new RegExp(`comment on ${child.id.replace(".", "\\.")}`));
  assert.match(store.get(issue.id).notes, /room\] gaps: unclear; /);

  const again = await claims(deps, store, issue.id);
  assert.equal(again.note, undefined);
  assert.equal(model.asked.length, 1);
  assert.equal(store.list({ status: "in_progress" }).total, 2);
});

test("a seat that claims the Research issue itself is not sent into another; an open Research child is never made twice", async () => {
  const store = freshStore("forks-gaps");
  const { deps } = roomOf(modelSaying("unclear"), ["gaps"]);
  const issue = murky(store);
  const made = store.create({ title: "Research: Make the export better", parent: issue.id }, "room");
  const answer = await claims(deps, store, made.id);
  assert.equal(answer.note, undefined, "a Research issue is not read for gaps");

  const other = murky(store, { title: "Make the import better" });
  const first = store.create({ title: "Research: Make the import better", parent: other.id }, "room");
  const reused = await claims(deps, store, other.id);
  assert.match(String(reused.note), new RegExp(first.id.replace(".", "\\.")));
  assert.equal(store.list({ type: "question" }).total, 0, "no second child was made");
});

test("an issue with no acceptance criteria: its creator, another seat, is mailed for them and the claimer goes on", async () => {
  const store = freshStore("forks-gaps");
  const { deps, posted } = roomOf(modelSaying("no-acceptance"), ["gaps"]);
  const issue = murky(store);
  const answer = await claims(deps, store, issue.id);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].to, ["lead"]);
  assert.equal(posted[0].from.agentId, "room");
  assert.match(posted[0].subject, /^ACCEPTANCE NEEDED: sw-\w+ "Make the export better"$/);
  assert.match(posted[0].body, /seatwork_work do=update id=sw-\w+ acceptance_criteria=/);
  assert.match(String(answer.note), /Go on, and say in a comment how you will tell it is done/);
  assert.equal(answer.status, "in_progress");

  // criteria the issue already has make the answer wrong: nobody is asked
  const given = roomOf(modelSaying("no-acceptance"), ["gaps"]);
  const stated = store.create({ title: "Stated", acceptance_criteria: "It exports in 2 s." }, "lead");
  assert.equal((await claims(given.deps, store, stated.id)).note, undefined);
  assert.equal(given.posted.length, 0);

  for (const [by, gone] of [
    ["peer", []],
    ["lead", ["lead"]],
    ["human", []],
  ] as const) {
    const one = roomOf(modelSaying("no-acceptance"), ["gaps"], gone);
    const bare = store.create({ title: `Bare by ${by}` }, by);
    const said = await claims(one.deps, store, bare.id);
    assert.equal(one.posted.length, 0, by);
    assert.equal(by === "peer" ? /you made it/.test(String(said.note)) : said.note === undefined, true, by);
  }
});

test("an issue that needs a decision is sent to the claimer's Owner, and where the escalation fork is on, to the seat it picks with the Owner copied", async () => {
  const store = freshStore("forks-gaps");
  const plain = roomOf(modelSaying("needs-decision"), ["gaps"]);
  const issue = murky(store);
  const answer = await claims(plain.deps, store, issue.id);
  assert.deepEqual([plain.posted[0].to, plain.posted[0].needs], [["lead"], "decision"]);
  assert.equal(plain.posted[0].from.agentId, "room");
  assert.match(plain.posted[0].subject, /^ISSUE NEEDS A DECISION: /);
  assert.match(String(answer.note), /Your Owner was asked, and you hear by mail\. Wait for it\./);

  const second = murky(store, { title: "Pick a payment vendor" });
  const model = modelSaying((labels) => (labels.includes("needs-decision") ? "needs-decision" : "person"));
  const both = roomOf(model, ["gaps", "escalate"]);
  const said = await claims(both.deps, store, second.id);
  assert.deepEqual(
    model.asked.map((one) => one.caller),
    ["forks.gaps@1", `forks.escalate@${forkCatalog.forks.escalate.version}`],
  );
  assert.deepEqual(both.posted[0].to, ["boss"], "the top of the chain, said to be a person's to decide");
  assert.deepEqual(both.posted[0].cc, ["lead"]);
  assert.match(String(both.posted[0].why), /only a person can decide/);
  assert.match(String(said.note), /supervisor \[supervisor\] boss was asked/);
});

test("an issue that is too big tells the claimer's Owner in a mail read with its next, and nobody else", async () => {
  const store = freshStore("forks-gaps");
  const { deps, posted } = roomOf(modelSaying("too-big"), ["gaps"]);
  const issue = murky(store);
  const answer = await claims(deps, store, issue.id);
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].to, posted[0].priority, posted[0].quiet], [["lead"], "fyi", true]);
  assert.match(posted[0].subject, /^SPLIT SUGGESTED: /);
  assert.match(String(answer.note), /Your Owner was told, and may split it/);
});

test("a fork that fails, or a mail that cannot be posted, leaves the claim as it was and writes nothing", async () => {
  const store = freshStore("forks-gaps");
  const throwing = roomOf(modelSaying("too-big"), ["gaps"]);
  throwing.deps.engine.post = async () => {
    throw new Error("the store is locked");
  };
  const issue = murky(store);
  const answer = await claims(throwing.deps, store, issue.id);
  assert.equal(answer.note, undefined);
  assert.equal(answer.status, "in_progress");
  assert.equal(store.get(issue.id).notes, "");
  assert.match(throwing.lines.join("\n"), /was not posted: the store is locked/);

  // a research child that cannot be made is a fork that failed
  const closed = murky(store, { title: "Closed parent" });
  const broken = roomOf(modelSaying("unclear"), ["gaps"]);
  const answer2 = (await afterWork(
    broken.deps,
    store,
    "peer",
    { do: "claim", id: closed.id },
    { id: "sw-nonesuch" },
  )) as Record<string, unknown>;
  assert.equal(answer2.note, undefined);
  assert.match(broken.lines.join("\n"), /fork gaps: nothing was done for sw-nonesuch/);
});

test("a Research issue that cannot be claimed stands unassigned and the claim still says what to do", async () => {
  const store = freshStore("forks-gaps");
  const { deps, lines } = roomOf(modelSaying("unclear"), ["gaps"]);
  const issue = murky(store);
  const done = work(store, RULES, { id: "peer", owner: false }, { do: "claim", id: issue.id });
  const claim = store.claim.bind(store);
  store.claim = () => {
    throw new Error("the store is locked");
  };
  const answer = (await afterWork(deps, store, "peer", { do: "claim", id: issue.id }, done)) as Record<string, unknown>;
  store.claim = claim;
  assert.match(String(answer.note), /search the room's record/);
  assert.equal(store.get(`${issue.id}.1`).assignee, null);
  assert.match(lines.join("\n"), /stands unassigned: the store is locked/);
});

test("only a claim is read: a show, a list, a claim that fails and a plan made in one call pass through", async () => {
  const store = freshStore("forks-gaps");
  const model = modelSaying("unclear");
  const { deps } = roomOf(model, ["gaps", "duplicate"]);
  const issue = murky(store);
  for (const args of [
    { do: "show", id: issue.id },
    { do: "list" },
    { do: "create", issues: [{ title: "a" }, { title: "b" }] },
  ]) {
    const done = work(store, RULES, { id: "peer", owner: false }, args);
    assert.equal(await afterWork(deps, store, "peer", args, done), done);
  }
  assert.equal(model.asked.length, 0);
});
