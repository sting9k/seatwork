import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { roomDecisions } from "../shared/room";
import { tint, type Colors } from "./kit";

/** The decisions a workspace's seats follow, as a tab of the right panel: its project's and the room's in force, those still waiting, and the ended ones on request. */

type Decisions = RpcOutput<typeof roomDecisions>;
type Shown = Decisions["inForce"][number];

/** Day and month on this device's calendar. */
const day = (at: string) => new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });

/** A state as a small mark: in force, waiting for its turn to end, or ended. */
function Mark(props: { state: string; colors: Colors }) {
  const c = props.colors;
  const [text, color] =
    props.state === "active"
      ? ["in force", c.statusSuccess]
      : props.state === "pending"
        ? ["pending", c.statusWarning]
        : [props.state, c.foregroundMuted];
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint(color, 0.16) }}>
      <Text style={{ color, fontSize: 11, lineHeight: 15, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}

/** One decision: its topic and state, what it says, since when and whom it was told to. */
function Item(props: { decision: Shown; mixed: boolean; colors: Colors; key?: number }) {
  const { decision: d, mixed, colors: c } = props;
  const told = d.toldTo ? ` · told to ${/^[A-Z]+$/.test(d.toldTo) ? d.toldTo : `the ${d.toldTo}`}` : "";
  const meta =
    d.state === "pending"
      ? "in force when its turn ends"
      : `since ${day(d.since)}${d.until ? `, until ${day(d.until)}` : ""}${told} · v${d.version}`;
  return (
    <View
      style={{
        gap: 4,
        paddingVertical: 9,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        opacity: d.state === "active" || d.state === "pending" ? 1 : 0.7,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ flex: 1, color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
          {d.topic}
          {mixed && d.scope === "room" ? (
            <Text style={{ color: c.foregroundMuted, fontWeight: "400" }}> · room</Text>
          ) : null}
        </Text>
        <Mark state={d.state} colors={c} />
      </View>
      <Text style={{ color: c.foreground, fontSize: 12.5, lineHeight: 18 }}>{d.statement}</Text>
      <Text style={{ color: c.foregroundMuted, fontSize: 11.5, lineHeight: 16 }}>{meta}</Text>
    </View>
  );
}

/** The panel for one workspace, its folder read from the app's list of workspaces. */
export function decisionsPanel(client: PluginClientContext) {
  return function DecisionsPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
    const c = theme.colors;
    const read = useRpc(roomDecisions);
    const [folder, setFolder] = useState(null as string | null);
    const [ended, setEnded] = useState(false);
    useEffect(() => {
      let gone = false;
      void client.paseo.workspaces
        .list()
        .then(({ entries }) => {
          const found = (entries as { id: string; projectRootPath: string; workspaceDirectory?: string }[]).find(
            (entry) => entry.id === workspaceId,
          );
          if (!gone && found) setFolder(found.workspaceDirectory ?? found.projectRootPath);
        })
        .catch(() => undefined);
      return () => void (gone = true);
    }, [workspaceId]);
    const decisions = useQuery({
      queryKey: ["seatwork", "room.decisions", folder, ended],
      queryFn: () => read({ folder: folder!, earlier: ended }),
      enabled: folder !== null,
      refetchInterval: 30_000,
    });
    const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
    const data = decisions.data as Decisions | undefined;
    const mixed = data?.project != null;
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
        <View style={{ gap: 2 }}>
          <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
            {data?.project ? `Decisions for ${data.project}` : "Decisions for the room"}
          </Text>
          <Text style={muted}>
            What you decided; the seats follow it. To change one, tell the seat you decided it with.
          </Text>
        </View>
        {decisions.isError ? (
          <Text style={muted}>The decisions could not be read: {String(decisions.error)}</Text>
        ) : null}
        {data && data.inForce.length + data.pending.length === 0 ? (
          <Text style={muted}>Nothing decided yet.</Text>
        ) : null}
        {data?.inForce.map((d) => (
          <Item key={d.id} decision={d} mixed={mixed} colors={c} />
        ))}
        {data?.pending.map((d) => (
          <Item key={d.id} decision={d} mixed={mixed} colors={c} />
        ))}
        {data && data.earlier > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ended ? "Hide the earlier decisions" : "Show the earlier decisions"}
            onPress={() => setEnded(!ended)}
            style={{ flexDirection: "row", alignItems: "center", paddingTop: 2 }}
          >
            <Text style={{ flex: 1, ...muted, color: c.foregroundMuted }}>
              {data.earlier} earlier, replaced or withdrawn
            </Text>
            <Text style={muted}>{ended ? "Hide" : "Show"}</Text>
          </Pressable>
        ) : null}
        {ended ? data?.closed.map((d) => <Item key={d.id} decision={d} mixed={mixed} colors={c} />) : null}
      </ScrollView>
    );
  };
}
