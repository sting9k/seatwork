import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Host } from "../server/host";
import { PaseoHost } from "../server/paseo/host";
import { HOST_CONTRACT } from "./support/host-contract";
import { StandInApp } from "./support/stand-in-app";

const QUICK = { readSeconds: 0.03, historySeconds: 0.03, writeSeconds: 0.03, startSeconds: 0.03 };

/** Each Host the room can run on, made over a stand-in app, with or without the client the app hands. */
const HOSTS: Record<string, (app: StandInApp, client: boolean) => Host> = {
  paseo: (app, client) => {
    const host = new PaseoHost(QUICK);
    if (client) host.use(app.client());
    return host;
  },
};

let apps = 0;
for (const [name, make] of Object.entries(HOSTS))
  for (const [method, clauses] of Object.entries(HOST_CONTRACT))
    for (const clause of clauses)
      test(`${name} host, ${method}: ${clause.says}`, { timeout: 5000 }, async () => {
        const app = new StandInApp(join(ROOM_HOME, "..", `stand-in-${(apps += 1)}`));
        const before = process.env.SEATWORK_PASEO_BIN;
        process.env.SEATWORK_PASEO_BIN = app.cli;
        try {
          await clause.run({ host: make(app, !clause.before), app });
        } finally {
          if (before === undefined) delete process.env.SEATWORK_PASEO_BIN;
          else process.env.SEATWORK_PASEO_BIN = before;
        }
      });

test("every method of the Host contract has a clause", () => {
  assert.deepEqual(
    Object.entries(HOST_CONTRACT).flatMap(([method, clauses]) => (clauses.length ? [] : [method])),
    [],
  );
});
