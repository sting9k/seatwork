import { installRoom, hostOf, MAIL_POLICY, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { chime } from "../client/chime";
import { watchWaiting } from "../client/waiting";
import contribute from "../index.server";
import { MailEngine } from "../server/coordination/engine";
import { fakeServer } from "./support/server";

shipSql();

test("mail that was held when the daemon stopped moves once the app is open, before any agent runs", async () => {
  installRoom(["claude-lead"]);
  const output = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  // before the restart the Lead was in a turn, so its mail waited on disk
  const busy = { agents: { ref: () => ({ refresh: async () => {}, current: () => ({ status: "running" }) }) } };
  const held = await new MailEngine(hostOf(busy), MAIL_POLICY, () => {}).post({
    from: { agentId: "room", role: "system" },
    to: "lead-restart",
    priority: "action",
    subject: "ANSWER: seconds",
    body: "ANSWER\nseconds",
    needs: "nothing",
  });

  // after it every seat is closed and no hook has fired: the app's question reaches the plugin first
  const inbox: string[] = [];
  let listed = 0;
  const paseo = {
    agents: {
      list: async () => ({ entries: [], listed: (listed += 1) }),
      ref: () => ({
        refresh: async () => {},
        current: () => ({ status: "closed" }),
        send: async (text: string) => void inbox.push(text),
      }),
    },
  };
  const paseoSide = fakeServer();
  const dispose = contribute(paseoSide.server);
  try {
    await paseoSide.call("rpc room.waiting", {}, { paseo });
    for (let waited = 0; inbox.length === 0 && waited < 100; waited += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await dispose();
    Object.assign(console, output);
  }

  assert.equal(inbox.length, 1);
  assert.ok(inbox[0].includes(`<mail id="${held.id}"`));
  assert.equal(
    listed,
    0,
    "the app asks every 15 seconds: with nothing waiting on the Owner, the daemon's agents are not listed",
  );
});

test("the chime is a WAV file whose header agrees with its samples, and it ends in silence", () => {
  const { base64, mimeType } = chime();
  const file = Buffer.from(base64, "base64");
  const samples = (file.length - 44) / 2;

  assert.equal(mimeType, "audio/wav");
  assert.equal(file.toString("base64"), base64, "not base64 a decoder gives back unchanged");
  assert.equal(
    file.toString("latin1", 0, 4) + file.toString("latin1", 8, 16) + file.toString("latin1", 36, 40),
    "RIFFWAVEfmt data",
  );
  assert.deepEqual([file.readUInt32LE(4), file.readUInt32LE(40)], [file.length - 8, samples * 2]);
  // PCM, mono, 16 bits at 16 kHz
  assert.deepEqual(
    [
      file.readUInt16LE(20),
      file.readUInt16LE(22),
      file.readUInt32LE(24),
      file.readUInt32LE(28),
      file.readUInt16LE(32),
      file.readUInt16LE(34),
    ],
    [1, 1, 16000, 32000, 2, 16],
  );
  assert.ok(samples / 16000 > 0.2 && samples / 16000 < 0.6, "not a short sound");
  const loudest = Math.max(...Array.from({ length: samples }, (_, n) => Math.abs(file.readInt16LE(44 + n * 2))));
  assert.ok(loudest > 6000 && loudest < 16000, `peak ${loudest}`);
  assert.ok(Math.abs(file.readInt16LE(file.length - 2)) < 100, "the file ends on a click");
});

test("the app asks the room once per interval: a chime for a turn that newly waits, none for what waited when it opened, and each answer to whoever shows it", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const answers = [
    { chime: true, waiting: [{ key: "a" }] },
    { chime: true, waiting: [{ key: "a" }, { key: "b" }] },
    { chime: true, waiting: [{ key: "b" }] },
    { chime: false, waiting: [{ key: "b" }, { key: "c" }] },
    { chime: true, waiting: [] },
  ];
  let asked = 0;
  let sounds = 0;
  const counts: number[] = [];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const stop = watchWaiting(
    async () => answers[asked++],
    async () => void (sounds += 1),
    15_000,
    (answer) => void counts.push(answer.waiting.length),
  );
  try {
    await settle();
    assert.deepEqual([asked, sounds, counts.at(-1)], [1, 0, 1], "what waited when the app opened is not news");
    for (const [chimed, count] of [
      [1, 2],
      [1, 1],
      [1, 2],
      [1, 0],
    ]) {
      mock.timers.tick(15_000);
      await settle();
      assert.deepEqual([sounds, counts.at(-1)], [chimed, count]);
    }
    assert.equal(asked, 5, "one question to the room for each interval");
    assert.deepEqual(counts, [1, 2, 1, 2, 0]);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test("a question to the room that is still unanswered is not asked again at the next interval", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let asked = 0;
  const stop = watchWaiting(
    () => new Promise<never>(() => void (asked += 1)),
    async () => {},
    15_000,
  );
  try {
    for (let beat = 0; beat < 4; beat += 1) mock.timers.tick(15_000);
    assert.equal(asked, 1);
  } finally {
    stop();
    mock.timers.reset();
  }
});

/** Watches a room that gives one of `answers` at each interval; how many questions were asked and sounds made once all were given. */
async function watched(answers: { chime: boolean; waiting: { key: string }[] }[]) {
  mock.timers.enable({ apis: ["setInterval"] });
  let asked = 0;
  let sounds = 0;
  const told: number[] = [];
  const stop = watchWaiting(
    async () => answers[asked++],
    async () => void (sounds += 1),
    15_000,
    (answer) => void told.push(answer.waiting.length),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    for (let beat = 1; beat < answers.length; beat += 1) {
      mock.timers.tick(15_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { asked, sounds, told };
  } finally {
    stop();
    mock.timers.reset();
  }
}

test("a room that answers nothing for a moment, as it restarts, does not make the app chime again for what it already told", async () => {
  const { asked, sounds } = await watched([
    { chime: true, waiting: [{ key: "a" }] },
    { chime: true, waiting: [{ key: "a" }, { key: "b" }] },
    { chime: false, waiting: [] },
    { chime: true, waiting: [{ key: "a" }, { key: "b" }] },
  ]);
  assert.deepEqual([asked, sounds], [4, 1]);
});

test("the app does not remember every turn that ever waited: a key long gone is news again", async () => {
  const { asked, sounds } = await watched([
    ...Array.from({ length: 1000 }, (_, n) => ({ chime: true, waiting: [{ key: `k${n}` }] })),
    { chime: true, waiting: [{ key: "k1" }] },
  ]);
  assert.deepEqual([asked, sounds], [1001, 1000]);
});

test("each answer of the room is handed on, so the pill on each composer follows it", async () => {
  const { told } = await watched([
    { chime: true, waiting: [{ key: "a" }] },
    { chime: true, waiting: [{ key: "a" }, { key: "b" }] },
    { chime: true, waiting: [{ key: "a" }, { key: "b" }] },
  ]);
  assert.deepEqual(told, [1, 2, 2]);
});
