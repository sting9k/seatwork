import { installRoom, MAIL_POLICY } from "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chime } from "../client/chime";
import contribute from "../index.server";
import { MailEngine } from "../server/mail";
import { fakeServer } from "./support/server";

test("mail that was held when the daemon stopped moves once the app is open, before any agent runs", async () => {
  installRoom(["claude-lead"]);
  const output = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  // before the restart the Lead was in a turn, so its mail waited on disk
  const busy = { agents: { ref: () => ({ refresh: async () => {}, current: () => ({ status: "running" }) }) } };
  const held = await new MailEngine(busy as never, MAIL_POLICY, { routes: {}, spawn: {} } as never, () => {}).post({
    from: { agentId: "room", role: "system" },
    to: "lead-restart",
    priority: "action",
    subject: "ANSWER: seconds",
    body: "ANSWER\nseconds",
    needs: "nothing",
    whyNow: "test",
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
  assert.ok(inbox[0].includes(`#${held.id}`));
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
