import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import vocabulary from "../shared/work.json";
import { projectFolder } from "./support/seats";
import { pluginRoom } from "./support/plugin";

const { agents, seat } = pluginRoom(["claude-lead", "claude-peer"], { timers: "clock" });

test("once a claim's lease runs out, the issue of a seat gone from the app's list is open again and its Owner is told; a seat still listed keeps its claim", async () => {
  const project = projectFolder("lease-project");
  const lead = await seat("lead-lease", "claude-lead", null, "[Lead] store", project);
  const gone = await seat("peer-lease-gone", "claude-peer", "lead-lease", "[Peer] schema", project);
  const here = await seat("peer-lease-here", "claude-peer", "lead-lease", "[Peer] views", project);
  const issue = async (title: string) =>
    (JSON.parse(await lead.call("seatwork_work", { do: "create", title })) as { id: string }).id;
  const [first, second] = [await issue("schema"), await issue("views")];
  await gone.call("seatwork_work", { do: "claim", id: first });
  await here.call("seatwork_work", { do: "claim", id: second });

  // the time passes for both claims; the seat that is listed will be pushed on, the other will not
  delete agents["peer-lease-gone"];
  for (let minute = 0; minute <= vocabulary.leaseMinutes; minute += 1) mock.timers.tick(60_000);
  for (let waited = 0; lead.inbox.length === 0 && waited < 200; waited += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));

  const db = new DatabaseSync(join(project, ".seatwork", ".work", "work.db"), { readOnly: true });
  const rows = db.prepare("SELECT id, status, assignee, lease_until FROM issues").all() as {
    id: string;
    status: string;
    assignee: string | null;
    lease_until: string | null;
  }[];
  db.close();
  const row = (id: string) => rows.find((one) => one.id === id)!;
  assert.deepEqual([row(first).status, row(first).assignee, row(first).lease_until], ["open", null, null]);
  assert.deepEqual([row(second).status, row(second).assignee], ["in_progress", "peer-lease-here"]);
  assert.ok(Date.parse(row(second).lease_until!) > Date.now(), "the listed seat's lease was pushed on");
  assert.equal(lead.inbox.length, 1);
  assert.match(lead.inbox[0], /subject="LEASE: 1 claimed issue went back to the board"/);
  assert.ok(lead.inbox[0].includes(first));
  assert.ok(!lead.inbox[0].includes(second));
  assert.match(await lead.call("seatwork_work", { do: "show", id: first }), /peer-lease-gone is gone/);
});
