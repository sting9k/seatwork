import { ROOM_HOME } from "./support/room";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureRoomProject, removeRoomProject } from "../server/paseo/room-project";
import { roomProjectDir } from "../server/orchestration/registry";

test("the HQ project is opened once however many ask at the same moment; when the room goes it is deleted from Paseo, alone, or archived when the CLI cannot", async () => {
  let workspaces: { id: string; projectRootPath: string }[] = [{ id: "other", projectRootPath: "/somewhere/else" }];
  const paseo = {
    workspaces: {
      list: async () => ({ entries: workspaces }),
      // a daemon that takes a moment: a second caller that listed before this landed would open another
      open: ({ cwd }: { cwd: string }) =>
        new Promise<void>((done) =>
          setTimeout(() => done(void workspaces.push({ id: `w${workspaces.length}`, projectRootPath: cwd })), 5),
        ),
      archive: async (id: string) => void (workspaces = workspaces.filter((workspace) => workspace.id !== id)),
    },
  };

  await Promise.all([ensureRoomProject(paseo as never, () => {}), ensureRoomProject(paseo as never, () => {})]);
  assert.deepEqual(
    workspaces.map((workspace) => workspace.projectRootPath),
    ["/somewhere/else", roomProjectDir()],
  );

  // a paseo CLI that lists the HQ project beside one of the user's, and notes what it is told to delete
  const failing = process.env.SEATWORK_PASEO_BIN;
  const deleted = join(ROOM_HOME, "..", "deleted-projects");
  const cli = join(ROOM_HOME, "..", "paseo-lists-projects");
  const listed = JSON.stringify([
    { projectId: "prj_mine", path: "/somewhere/else" },
    { projectId: "prj_hq", path: roomProjectDir() },
  ]);
  writeFileSync(
    cli,
    `#!/bin/sh\ncase "$1 $2" in\n"project ls") echo '${listed}' ;;\n"project delete") echo "$3" >> '${deleted}' ;;\n*) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );
  process.env.SEATWORK_PASEO_BIN = cli;
  assert.equal(await removeRoomProject(paseo as never), true);
  assert.deepEqual(
    [readFileSync(deleted, "utf8"), workspaces.length],
    ["prj_hq\n", 2],
    "the CLI deletes the project; the SDK is not asked to archive",
  );

  process.env.SEATWORK_PASEO_BIN = failing;
  assert.equal(await removeRoomProject(paseo as never), false);
  assert.deepEqual(
    [workspaces.map((workspace) => workspace.id), existsSync(deleted) && readFileSync(deleted, "utf8")],
    [["other"], "prj_hq\n"],
  );
});
