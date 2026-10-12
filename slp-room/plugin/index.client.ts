import type { PluginClientContext } from "@getpaseo/plugin/client";
import { chime } from "./client/chime";
import { roomWaiting } from "./shared/room";

/** How often the open app asks the room what waits on the Owner. */
const EVERY_MS = 15_000;

/**
 * slp-seat in the app: while it is open it asks the room what waits on the Owner, and plays a short sound for
 * each turn that newly does. The asking is also what lets the room move held mail after a daemon restart.
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
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
