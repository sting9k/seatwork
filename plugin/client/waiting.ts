/** What waits on the Owner, asked of the room on a timer: a sound for each turn that newly waits, and each answer for whoever shows it. */

interface Answer {
  chime: boolean;
  waiting: readonly { key: string }[];
}

const MAX_HEARD = 200;

/** Asks the room every `everyMs`, one question at a time; `play` sounds the chime, `told` hears each answer. Returns what stops it. */
export function watchWaiting<A extends Answer>(
  ask: () => Promise<A>,
  play: () => Promise<void>,
  everyMs: number,
  told?: (answer: A) => void,
): () => void {
  const heard = new Set<string>();
  let first = true;
  let stopped = false;
  let asking = false;
  const look = async () => {
    if (asking) return;
    asking = true;
    try {
      const answer = await ask();
      if (stopped) return;
      const fresh = answer.waiting.map((item) => item.key).filter((key) => !heard.has(key));
      for (const key of fresh) heard.add(key);
      // the oldest keys go first: a room that answered nothing for a moment must not make the next answer news
      while (heard.size > MAX_HEARD) heard.delete(heard.values().next().value!);
      told?.(answer);
      // what already waited when the app opened is on screen, not news
      if (answer.chime && fresh.length > 0 && !first) await play();
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
  };
}
