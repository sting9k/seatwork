import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { deleteProjectAt } from "../hq";
import { HQ_PROJECT, ROOM_HOME, WATCH_DIR } from "../../paths";
import { keptAt, roomFolders, takeRoomFiles } from "./project-files";
import { isSetUp, moveRoomHomeAside } from "./room-home";

/** Clears a room from before 0.19.0 (`slp-room`, `.slp/`) as its own Remove would; returns where it went, or null. */
export async function clearOldRoom(): Promise<string | null> {
  const home = join(dirname(ROOM_HOME), "slp-room");
  if (!isSetUp(home)) return null;
  const folders = roomFolders(home);
  await deleteProjectAt(join(home, HQ_PROJECT));
  const key = join(home, "watch", "key");
  if (existsSync(key) && !existsSync(join(WATCH_DIR, "key"))) {
    mkdirSync(WATCH_DIR, { recursive: true, mode: 0o700 });
    copyFileSync(key, join(WATCH_DIR, "key"));
    chmodSync(join(WATCH_DIR, "key"), 0o600);
  }
  const movedTo = moveRoomHomeAside(home);
  for (const root of folders) {
    try {
      takeRoomFiles(root, keptAt(movedTo, root, ".slp"), ".slp");
    } catch {
      // a project that cannot be reached keeps its .slp/
    }
  }
  return movedTo;
}
