import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { chime } from "./client/chime";
import { RoomItem, RoomScreen } from "./client/room";
import { SetupItem, SetupScreen, type Open } from "./client/setup";
import { roomWaiting } from "./shared/room";

/** How often the open app asks the room what waits on the Owner; asking also moves held mail after a restart. */
const EVERY_MS = 15_000;

/** Seatwork in the app: its two screens, their sidebar rows, and a sound when a turn newly waits on the Owner. */
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
  // a project's own models and a part of the room screen open as the same screen, by its params
  const open: Open = (to) => client.openScreen({ screenId: "setup", ...(to?.project || to?.part ? { params: { ...(to.project ? { project: to.project } : {}), ...(to.part ? { part: to.part } : {}) } } : {}) });
  const setup = client.addScreen({ id: "setup", title: ({ project }) => (project ? `Seatwork · ${project}` : "Seatwork"), Component: (props: PluginScreenProps) => <SetupScreen {...props} open={open} /> });
  const setupItem = client.addSidebarHeaderItem({ id: "setup", title: "Seatwork", Component: SetupItem });
  const command = client.addCommandCenterItem({ id: "setup", title: "Seatwork: set up the room", icon: "Armchair", context: "global", onSelect: ({ openScreen }) => openScreen({ screenId: "setup" }) });
  return () => {
    stopped = true;
    clearInterval(timer);
    void command();
    void setupItem();
    void setup();
    void item();
    void screen();
  };
}
