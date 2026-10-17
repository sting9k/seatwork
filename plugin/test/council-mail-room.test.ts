import assert from "node:assert/strict";
import { test } from "node:test";
import { parserRepo } from "./support/seats";
import { pluginRoom } from "./support/plugin";

const { seat, turnEnds, rotatable } = pluginRoom(["claude-supervisor", "claude-lead", "claude-peer"], {
  policy: (policy) => void (policy.safety.council.levels = { report: 2 }),
});

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
