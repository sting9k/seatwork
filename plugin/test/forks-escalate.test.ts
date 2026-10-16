import { hostOf, MAIL_POLICY, shipSql } from "./support/room";
import forkCatalog from "../shared/forks.json";
import { forksWith, modelSaying } from "./forks-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MailEngine, type SeatRecord } from "../server/coordination/engine";
import type { LiveSeat } from "../server/host";
import type { Forks } from "../server/orchestration/forks";
import type { RoomContext } from "../server/room/context";
import { sendMail } from "../server/room/mail-tools";

shipSql();

const idle = { refresh: async () => {}, current: () => ({ status: "idle" }), send: async () => {} };
const gone = { refresh: async () => null, current: () => null };

let cases = 0;
const names = () => {
  cases += 1;
  return Object.fromEntries(["hq", "boss", "lead", "peer"].map((role) => [role, `${role}-esc-${cases}`]));
};

const seat = (agentId: string, role: string, parent: string | null): SeatRecord => ({
  agentId,
  parentAgentId: parent,
  role,
  provider: `claude-${role}`,
  title: `[${role}] ${agentId}`,
});

/** The room's seats hq > boss (a supervisor) > lead > peer, with `forks` deciding where a question goes; the roles in `away` are archived. */
function roomOf(forks: Pick<Forks, "take">, away: string[] = []) {
  const id = names();
  const handles = Object.fromEntries(
    Object.entries(id)
      .filter(([role]) => !away.includes(role))
      .map(([, one]) => [one, idle]),
  );
  const paseo = { agents: { ref: (agent: string) => handles[agent] ?? gone } };
  const engine = new MailEngine(hostOf(paseo), MAIL_POLICY, () => {}, {});
  engine.rememberSeat(seat(id.hq, "hq", null));
  engine.rememberSeat(seat(id.boss, "supervisor", id.hq));
  engine.rememberSeat(seat(id.lead, "lead", id.boss));
  engine.rememberSeat(seat(id.peer, "peer", id.lead));
  const room = {
    engine,
    host: {
      live: async () =>
        new Map(Object.keys(handles).map((one) => [one, { id: one, status: "idle", waiting: false } as LiveSeat])),
    },
    mailedUp: new Map(),
    lastSignal: new Map(),
    rounds: { rejected: () => 0, answered: () => 0 },
    works: { existing: () => null },
    taskKeys: { of: (one: string) => one },
    forks,
  } as unknown as RoomContext;
  return { room, engine, id };
}

const ask = {
  subject: "QUESTION: which vendor",
  body: "Two vendors fit; one costs more.",
  needs: "decision",
  to: "owner",
};
const reached = (engine: MailEngine, at: string, sent: number) =>
  engine
    .storeOf(at, false)!
    .deliveries(sent)
    .map(({ seat: who, kind }) => `${who}:${kind}`)
    .sort();

test("a question the decision model reads as only a person's goes to the top seat the workflow lets the sender mail, the Owner copied; the model reads whose work it is in", async () => {
  const model = modelSaying("person");
  const { room, engine, id } = roomOf(forksWith(model.router, ["escalate"]).forks);
  const sent = JSON.parse(await sendMail(room, id.peer, ask));
  assert.deepEqual(reached(engine, id.peer, sent.sent), [`${id.boss}:to`, `${id.lead}:cc`].sort());
  assert.deepEqual(sent.to, [`supervisor ${id.boss}`]);
  assert.match(sent.note, /only a person can decide: it went to supervisor .* with your Owner copied/);
  assert.match(engine.storeOf(id.boss, false)!.get(sent.sent)!.why, /only a person can decide: bring it to the person/);
  // the labels are the seats the workflow lets a Peer mail: not the room's own seat, whose route is closed
  assert.deepEqual(model.asked[0].labels, ["owner", "above", "person"]);
  assert.equal(model.asked[0].caller, `forks.escalate@${forkCatalog.forks.escalate.version}`);
  assert.deepEqual(model.asked[0].state, {
    message: { signal: "QUESTION", subject: ask.subject, body: ask.body },
    sender: { role: "peer", title: `[peer] ${id.peer}` },
    owner: { role: "lead", title: `[lead] ${id.lead}` },
    above: { role: "supervisor", title: `[supervisor] ${id.boss}` },
  });
});

test("a question for the seat above its Owner goes there with the Owner copied; its own Owner answers when the model says so, or is unsure", async () => {
  const above = roomOf(forksWith(modelSaying("above").router, ["escalate"]).forks);
  const sent = JSON.parse(
    await sendMail(above.room, above.id.peer, { ...ask, subject: "DECISION_NEEDED: pick the vendor" }),
  );
  assert.deepEqual(
    reached(above.engine, above.id.peer, sent.sent),
    [`${above.id.boss}:to`, `${above.id.lead}:cc`].sort(),
  );
  assert.match(sent.note, /one for a seat above your Owner: it went to supervisor/);
  assert.match(
    above.engine.storeOf(above.id.boss, false)!.get(sent.sent)!.why,
    /you must answer, not only the sender's Owner/,
  );

  for (const [name, forks] of [
    ["owner", forksWith(modelSaying("owner").router, ["escalate"]).forks],
    ["split", forksWith(modelSaying("person", 0.6).router, ["escalate"]).forks],
    ["off", forksWith(modelSaying("person").router, []).forks],
    ["no model", forksWith(null, ["escalate"]).forks],
    ["a label nobody asked", { take: async () => "something" } as unknown as Forks],
  ] as const) {
    const one = roomOf(forks);
    const kept = JSON.parse(await sendMail(one.room, one.id.peer, ask));
    assert.deepEqual(reached(one.engine, one.id.peer, kept.sent), [`${one.id.lead}:to`], name);
    assert.equal(kept.note, undefined, name);
  }
});

test("a Lead's question has no seat above its Owner to ask: the person's question goes to its Owner, which is told so", async () => {
  const model = modelSaying("person");
  const { room, engine, id } = roomOf(forksWith(model.router, ["escalate"]).forks);
  const sent = JSON.parse(await sendMail(room, id.lead, { ...ask, subject: "BLOCKED: waiting for a key" }));
  assert.deepEqual(reached(engine, id.lead, sent.sent), [`${id.boss}:to`]);
  assert.deepEqual(model.asked[0].labels, ["owner", "person"], "the route lead>hq is closed");
  assert.match(engine.storeOf(id.boss, false)!.get(sent.sent)!.why, /bring it to the person/);
});

test("only a seat's question to its Owner is read: other subjects, answers, a mail to the team and a stop pass untouched", async () => {
  const model = modelSaying("person");
  const { room, engine, id } = roomOf(forksWith(model.router, ["escalate"]).forks);
  const first = JSON.parse(await sendMail(room, id.lead, { ...ask, to: id.peer, subject: "INSTRUCTION: go on" }));
  const asked = JSON.parse(await sendMail(room, id.lead, { ...ask, to: id.peer, subject: "QUESTION: which vendor" }));
  const answer = JSON.parse(
    await sendMail(room, id.peer, { subject: "ACK: started", body: "On it.", reply_to: first.sent }),
  );
  const status = JSON.parse(
    await sendMail(room, id.peer, { subject: "STATUS: half done", body: "Half.", to: "owner" }),
  );
  const team = JSON.parse(await sendMail(room, id.lead, { subject: "FYI: main moved", body: "Rebase.", to: "team" }));
  assert.deepEqual(reached(engine, id.lead, first.sent), [`${id.peer}:to`]);
  assert.deepEqual(
    reached(engine, id.lead, asked.sent),
    [`${id.peer}:to`],
    "a question to a seat below is no escalation",
  );
  assert.ok(answer.sent && status.sent && team.sent);
  assert.equal(model.asked.length, 0);
});

test("a seat the model picks that is gone leaves the mail with the Owner; a replay of the same question is not sent twice", async () => {
  const away = roomOf(forksWith(modelSaying("person").router, ["escalate"]).forks, ["boss"]);
  const kept = JSON.parse(await sendMail(away.room, away.id.peer, ask));
  assert.deepEqual(reached(away.engine, away.id.peer, kept.sent), [`${away.id.lead}:to`]);

  const model = modelSaying("person");
  const { room, id } = roomOf(forksWith(model.router, ["escalate"]).forks);
  const first = JSON.parse(await sendMail(room, id.peer, ask));
  const again = JSON.parse(await sendMail(room, id.peer, ask));
  assert.deepEqual([again.replayed, again.sent], [true, first.sent]);
});
