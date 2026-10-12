import "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeHqProject, ensureHqProject, hqDir } from "../server/hq";

test("the HQ project is opened once however many ask at the same moment, and archived when the room goes", async () => {
  let workspaces: { id: string; projectRootPath: string }[] = [{ id: "other", projectRootPath: "/somewhere/else" }];
  const paseo = {
    workspaces: {
      list: async () => ({ entries: workspaces }),
      // a daemon that takes a moment: a second caller that listed before this landed would open another
      open: ({ cwd }: { cwd: string }) => new Promise<void>((done) => setTimeout(() => done(void workspaces.push({ id: `w${workspaces.length}`, projectRootPath: cwd })), 5)),
      archive: async (id: string) => void (workspaces = workspaces.filter((workspace) => workspace.id !== id)),
    },
  };

  await Promise.all([ensureHqProject(paseo as never, () => {}), ensureHqProject(paseo as never, () => {})]);
  assert.deepEqual(workspaces.map((workspace) => workspace.projectRootPath), ["/somewhere/else", hqDir()]);

  await closeHqProject(paseo as never);
  assert.deepEqual(workspaces.map((workspace) => workspace.id), ["other"]);
});
