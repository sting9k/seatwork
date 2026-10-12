import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { PluginTheme, RpcOutput } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import { roomStatus, roomWaiting } from "../shared/room";

type Room = RpcOutput<typeof roomStatus>;

/** A seat's dot: at work, stopped on something, or at rest. */
function tone(status: string, colors: PluginTheme["colors"]): string {
  if (status === "running" || status === "initializing") return colors.statusSuccess;
  if (status === "error") return colors.statusDanger;
  return status === "waiting" ? colors.statusWarning : colors.foregroundMuted;
}

/** A seat at rest says nothing: its dot is enough. */
const AT_REST = new Set(["idle", "closed"]);

/** Hour and minute on this device's clock. */
const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function RoomScreen({ theme, layout, navigation }: PluginScreenProps) {
  const read = useRpc(roomStatus);
  const room = useQuery({ queryKey: ["slp-seat", "room.status"], queryFn: () => read({}), refetchInterval: 10_000 });
  const c = theme.colors;
  const pad = layout.compact ? 16 : 24;
  const text = { color: c.foreground, fontSize: 14 };
  const muted = { color: c.foregroundMuted, fontSize: 12 };
  const warn = { color: c.statusWarning, fontSize: 12 };
  const card = { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10 };
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingVertical: 9, paddingHorizontal: 14 };
  const open = (agentId: string) => navigation?.openAgent({ agentId });

  if (room.isError) {
    return (
      <View style={{ flex: 1, padding: pad, backgroundColor: c.surface0 }}>
        <Text style={text}>The room could not be read: {String(room.error)}</Text>
      </View>
    );
  }
  const data: Room = room.data ?? { waiting: [], projects: [] };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: pad, gap: 18 }}>
      {data.waiting.length === 0 ? null : (
        <View style={{ gap: 8 }}>
          <Text style={[muted, { letterSpacing: 0.6 }]}>WAITING ON YOU</Text>
          <View style={[card, { borderColor: c.statusWarning }]}>
            {data.waiting.map((item) => (
              <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`Open ${item.title ?? item.agentId}`} style={row} onPress={() => open(item.agentId)}>
                <Text style={warn}>{item.what}</Text>
                <Text style={[text, { flex: 1 }]} numberOfLines={1}>{item.title ?? item.agentId}</Text>
                <Text style={muted}>{item.project} · {clock(item.at)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {data.projects.length === 0 && room.isSuccess ? <Text style={muted}>No seat is open.</Text> : null}

      {data.projects.map((project) => (
        <View key={project.name} style={card}>
          <View style={[row, project.seats.length > 0 ? { borderBottomColor: c.border, borderBottomWidth: 1 } : null]}>
            <Text style={[text, { flex: 1, fontWeight: "600" as const }]} numberOfLines={1}>{project.name}</Text>
            <Text style={muted}>{project.seats.length === 0 ? "no seat" : project.seats.length === 1 ? "1 seat" : `${project.seats.length} seats`}</Text>
          </View>
          {project.seats.map((seat) => (
            <Pressable key={seat.agentId} accessibilityRole="button" accessibilityLabel={`Open ${seat.title ?? seat.role}`} style={[row, { paddingLeft: 14 + seat.depth * 20 }]} onPress={() => open(seat.agentId)}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone(seat.status, c) }} />
              <Text style={[text, { flex: 1 }]} numberOfLines={1}>{seat.title ?? seat.role}</Text>
              {seat.held > 0 ? <Text style={warn}>{seat.held} held</Text> : null}
              {AT_REST.has(seat.status) ? null : <Text style={muted}>{seat.status}</Text>}
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/** The sidebar row: it opens the screen, and says how many turns wait on the Owner. */
export function RoomItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const read = useRpc(roomWaiting);
  const waiting = useQuery({ queryKey: ["slp-seat", "room.waiting"], queryFn: () => read({}), refetchInterval: 15_000 });
  const count = waiting.data?.waiting.length ?? 0;
  return (
    <SidebarRow
      icon="Network"
      label="Room"
      active={currentScreen?.screenId === "room"}
      onPress={() => openScreen({ screenId: "room" })}
      trailing={count > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{count} waiting</Text> : undefined}
    />
  );
}
