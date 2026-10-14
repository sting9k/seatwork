/** What waits on the Owner, asked of the room on a timer: a sound for each turn that newly waits, and the count for the sidebar row. */

interface Answer {
  chime: boolean;
  waiting: readonly { key: string }[];
}

const MAX_HEARD = 200;
let count = 0;
const listeners = new Set<(count: number) => void>();

/** How many turns waited on the Owner at the last question. */
export const waitingCount = (): number => count;

/** Calls `listener` whenever that count changes; returns what takes it off. */
export function onWaitingCount(listener: (count: number) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function setCount(next: number): void {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener(count);
}

/** Asks the room every `everyMs`, one question at a time; `play` sounds the chime. Returns what stops it. */
export function watchWaiting(ask: () => Promise<Answer>, play: () => Promise<void>, everyMs: number): () => void {
  const heard = new Set<string>();
  let first = true;
  let stopped = false;
  let asking = false;
  const look = async () => {
    if (asking) return;
    asking = true;
    try {
      const { chime, waiting } = await ask();
      if (stopped) return;
      const fresh = waiting.filter((item) => !heard.has(item.key));
      for (const item of fresh) heard.add(item.key);
      // the oldest keys go first: a room that answered nothing for a moment must not make the next answer news
      while (heard.size > MAX_HEARD) heard.delete(heard.values().next().value!);
      setCount(waiting.length);
      // what already waited when the app opened is on screen, not news
      if (chime && fresh.length > 0 && !first) await play();
      first = false;
    } catch {
      // the daemon is away or the plugin is reloading: the next look asks again
    } finally {
      asking = false;
    }
  };
  void look();
  const timer = setInterval(() => void look(), everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    setCount(0);
  };
}
