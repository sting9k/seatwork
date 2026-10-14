import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { chime } from "./client/chime";
import { RoomItem, RoomScreen } from "./client/room";
import { SetupItem, SetupScreen, type Open } from "./client/setup";
import { roomWaiting } from "./shared/room";
import { watchWaiting } from "./client/waiting";

/** Seatwork in the app: its two screens, their sidebar rows, and a sound when a turn newly waits on the Owner. */
export default function contribute(client: PluginClientContext) {
  // asking also moves mail held across a daemon restart
  const stopWatching = watchWaiting(
    () => client.rpc(roomWaiting, {}),
    () => client.playAudio(chime()),
    15_000,
  );
  const screen = client.addScreen({ id: "room", title: "Room", Component: RoomScreen });
  const item = client.addSidebarFooterItem({ id: "room", title: "Room", Component: RoomItem });
  // a project's own models and a part of the room screen open as the same screen, by its params
  const open: Open = (to) =>
    client.openScreen({
      screenId: "setup",
      ...(to?.project || to?.part
        ? { params: { ...(to.project ? { project: to.project } : {}), ...(to.part ? { part: to.part } : {}) } }
        : {}),
    });
  const setup = client.addScreen({
    id: "setup",
    title: ({ project }) => (project ? `Seatwork · ${project}` : "Seatwork"),
    Component: (props: PluginScreenProps) => <SetupScreen {...props} open={open} />,
  });
  const setupItem = client.addSidebarHeaderItem({ id: "setup", title: "Seatwork", Component: SetupItem });
  const command = client.addCommandCenterItem({
    id: "setup",
    title: "Seatwork: set up the room",
    icon: "Armchair",
    context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "setup" }),
  });
  return () => {
    stopWatching();
    void command();
    void setupItem();
    void setup();
    void item();
    void screen();
  };
}
