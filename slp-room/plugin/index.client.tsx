import type { PluginClientContext } from "@getpaseo/plugin/client";
import { chime } from "./client/chime";
import { RoomItem, RoomScreen } from "./client/room";
import { SetupScreen } from "./client/setup";
import { roomWaiting } from "./shared/room";

/** How often the open app asks the room what waits on the Owner. */
const EVERY_MS = 15_000;

/**
 * slp-seat in the app: the setup screen (Settings, Plugins), the Room screen and its sidebar row, and a short
 * sound for each turn that newly waits on the Owner. Asking the room is also what lets it move held mail after a
 * daemon restart.
 */
export default function contribute(client: PluginClientContext) {
  const heard = new Set<string>();
  let first = true;
  let stopped = false;
  const look = async () => {
    try {
      const { chime: wanted, waiting } = await client.rpc(roomWaiting, {});
      const fresh = waiting.filter((item) => !heard.has(item.key));
      for (const item of fresh) heard.add(item.key);
      // what already waited when the app opened is on screen, not news
      if (wanted && fresh.length > 0 && !first && !stopped) await client.playAudio(chime());
      first = false;
    } catch {
      // the daemon is away or the plugin is reloading: the next look asks again
    }
  };
  void look();
  const timer = setInterval(() => void look(), EVERY_MS);
  const screen = client.addScreen({ id: "room", title: "Room", Component: RoomScreen });
  const item = client.addSidebarFooterItem({ id: "room", title: "Room", Component: RoomItem });
  const setup = client.addSettingsScreen({ id: "setup", title: "Seatwork", icon: "Armchair", Component: SetupScreen });
  const command = client.addCommandCenterItem({ id: "setup", title: "Seatwork: set up the room", icon: "Armchair", context: "global", onSelect: ({ openSettings }) => openSettings("setup") });
  return () => {
    stopped = true;
    clearInterval(timer);
    void command();
    void setup();
    void item();
    void screen();
  };
}
