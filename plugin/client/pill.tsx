import type { RpcOutput } from "@getpaseo/plugin";
import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { roomWaiting } from "../shared/room";

/** The room on each room seat's composer: a pill that says how much waits on the person and opens on it. */

type Waiting = RpcOutput<typeof roomWaiting>;

const LISTED_MOST = 200;
const LOOK_AGAIN_MS = 60_000;

let latest: Waiting | null = null;
const listeners = new Set<(answer: Waiting) => void>();

/** Hour and minute on this device's clock. */
const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The pill's words: the room, and how much waits on the person. */
const labelOf = (answer: Waiting | null) => {
  const count = answer?.waiting.length ?? 0;
  return count > 0 ? `Room · ${count} waiting` : "Room";
};

/** The list the pill opens on: what waits, and a way to every seat. */
function RoomPopover(props: PluginButtonContentProps & { openRoom(): void }) {
  const { theme, close, openRoom } = props;
  const c = theme.colors;
  const [answer, setAnswer] = useState(latest);
  useEffect(() => {
    listeners.add(setAnswer);
    return () => void listeners.delete(setAnswer);
  }, []);
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
  const all = () => {
    close();
    openRoom();
  };
  const shown = answer as Waiting | null;
  const waiting: Waiting["waiting"] = shown?.waiting ?? [];
  return (
    <View style={{ width: 540, maxWidth: "100%", padding: 6, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 4 }}>
        <Text style={{ flex: 1, ...muted }}>Waiting on you</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="All seats" onPress={all}>
          <Text style={muted}>All seats</Text>
        </Pressable>
      </View>
      <View>
        {waiting.length === 0 ? (
          <Text style={{ ...muted, paddingHorizontal: 8, paddingVertical: 7 }}>Nothing waits on you.</Text>
        ) : null}
        {waiting.map((item) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={`${item.title ?? item.agentId}: open the room`}
            onPress={all}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingVertical: 7,
              paddingHorizontal: 8,
              borderRadius: 6,
            }}
          >
            <Text
              numberOfLines={1}
              style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 13.5, lineHeight: 19 }}
            >
              {item.title ?? item.agentId}
            </Text>
            <Text style={muted}>{clock(item.at)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Keeps a Room pill on the composer of each room seat the app shows and takes it off a seat that is gone; `sync` takes each answer of the room, `stop` takes every pill off. */
export function roomPills(client: PluginClientContext, openRoom: () => void) {
  const pills = new Map<string, { pill: PluginButtonRegistration; label: string }>();
  const workspaceOf = new Map<string, string>();
  let lookedAt = 0;
  const Content = (props: PluginButtonContentProps) => <RoomPopover {...props} openRoom={openRoom} />;
  const button = (label: string): PluginButton => ({
    title: "Room",
    icon: "Network",
    label,
    behavior: { kind: "popover", Content },
  });
  /** The workspace of each open agent the app lists, asked again only when a seat is not among them, at most once a minute. */
  const lookUp = async (seats: readonly string[]) => {
    if (seats.every((seat) => workspaceOf.has(seat)) || Date.now() - lookedAt < LOOK_AGAIN_MS) return;
    lookedAt = Date.now();
    const listed = await client.paseo.agents.list({ filter: { includeArchived: false }, page: { limit: LISTED_MOST } });
    for (const entry of listed.entries as { agent?: { id?: string; workspaceId?: string } }[])
      if (entry.agent?.id && entry.agent.workspaceId) workspaceOf.set(entry.agent.id, entry.agent.workspaceId);
  };
  return {
    async sync(answer: Waiting): Promise<void> {
      latest = answer;
      for (const listener of listeners) listener(answer);
      const seats = new Set(answer.seats);
      await lookUp(answer.seats).catch(() => undefined);
      const label = labelOf(answer);
      for (const seat of seats) {
        const workspaceId = workspaceOf.get(seat);
        const held = pills.get(seat);
        if (!workspaceId) continue;
        if (!held) {
          const pill = client.addComposerPill({
            id: `room-${seat}`,
            workspaceId,
            agentId: seat,
            button: button(label),
          });
          pills.set(seat, { pill, label });
        } else if (held.label !== label) {
          held.pill.update({ label });
          held.label = label;
        }
      }
      for (const [seat, held] of pills)
        if (!seats.has(seat)) {
          held.pill.remove();
          pills.delete(seat);
        }
      for (const seat of workspaceOf.keys()) if (!seats.has(seat)) workspaceOf.delete(seat);
    },
    stop(): void {
      for (const held of pills.values()) held.pill.remove();
      pills.clear();
      latest = null;
    },
  };
}
