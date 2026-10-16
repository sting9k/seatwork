import { installRoom, ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import contribute from "../index.server";
import { fakeServer } from "./support/server";
import { parserRepo, roomSeats } from "./room-seats";

const paseoSide = fakeServer();
const { call } = paseoSide;
const output = { log: console.log, error: console.error };
let dispose: () => Promise<void>;

before(() => {
  installRoom(["claude-supervisor", "claude-lead", "claude-peer"]);
  const file = join(ROOM_HOME, "policy.json");
  const policy = JSON.parse(readFileSync(file, "utf8"));
  policy.safety.council.levels = { report: 2 };
  writeFileSync(file, JSON.stringify(policy));
  console.log = console.error = () => {};
  dispose = contribute(paseoSide.server);
});

after(async () => {
  await dispose();
  Object.assign(console, output);
});

const { seat, turnEnds, rotatable } = roomSeats(call);

test("a finding at the level that mails the seat above is mailed when its seat is rotated with no report kept, and once", async () => {
  const dir = parserRepo("council-mail-rotate");
  const lead = await seat("lead-mail", "claude-lead", null, "[Lead] stream", dir);
  const peer = await seat("peer-mail", "claude-peer", lead.agent.id, "[Peer] parser mail", dir);
  rotatable(peer, "peer-mail-2", dir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const mailed = () => lead.inbox.filter((text) => /subject="COUNCIL: report on \[Peer\] parser mail"/.test(text));

  await lead.call("seatwork_rotate", { agent_id: peer.agent.id });
  await turnEnds(
    peer,
    "HANDOFF\nCURRENT TASK: the parser\nPROGRESS: fixed the bug at src/parse.js:400\nBLOCKERS: none",
  );
  const told = `${lead.inbox.join("\n")}\n${await lead.call("seatwork_inbox", {})}`;
  assert.match(told, /ROTATED: peer .*parser mail continues in a fresh seat/);
  assert.equal(mailed().length, 1);
  assert.match(mailed()[0], /cites &quot;src\/parse\.js:400&quot;, the file has 9 lines/);

  // the old seat stays when what it launched did not move; it says the same thing again
  await turnEnds(peer, "DONE: parser fixed\nthe bug was at src/parse.js:400");
  assert.equal(mailed().length, 1, "and the finding is mailed once");
});
