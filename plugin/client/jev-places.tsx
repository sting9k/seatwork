import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { jevPlaceSet, jevPlaces } from "../shared/setup";
import { Link, Toggle, type Colors } from "./kit";

/** Where the decision model works, on the Jev card: how many places are on, and a modal that turns the optional ones on and off. */

type Places = RpcOutput<typeof jevPlaces>;
type Place = Places["required"][number];

const KEY = ["seatwork", "jev.places"];

/** One section of the modal: its title and a card of places, each with its switch, or a lock when the room needs it. */
function Section(props: { title: string; places: Place[]; colors: Colors; onTurn?(id: string, on: boolean): void }) {
  const { colors: c, onTurn } = props;
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ ...muted, fontWeight: "500" }}>{props.title}</Text>
      <View
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface2,
          overflow: "hidden",
        }}
      >
        {props.places.map((place, index) => (
          <View
            key={place.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderTopWidth: index > 0 ? 1 : 0,
              borderTopColor: c.border,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "500" }}>
                {place.label}
              </Text>
              <Text style={muted}>{place.about}</Text>
            </View>
            {onTurn ? (
              <Toggle
                label={place.label}
                value={place.on}
                onChange={(on: boolean) => onTurn(place.id, on)}
                colors={c}
              />
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name="Lock" size={13} color={c.foregroundMuted} />
                <Text style={{ ...muted, fontWeight: "500" }}>Always on</Text>
              </View>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

/** The card's line and its modal. */
export function WhereItWorks(props: { colors: Colors }) {
  const c = props.colors;
  const read = useRpc(jevPlaces);
  const write = useRpc(jevPlaceSet);
  const queries = useQueryClient();
  const places = useQuery({ queryKey: KEY, queryFn: () => read({}) });
  const [open, setOpen] = useState(false);
  const turn = useMutation({
    mutationFn: (change: { id: string; on: boolean }) => write(change),
    onSuccess: (list: Places) => queries.setQueryData(KEY, list),
  });
  const Sheet = Modal as any;
  const data: Places | undefined = places.data;
  const small = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
  const on = data ? data.required.length + data.optional.filter((place) => place.on).length : null;
  const all = data ? data.required.length + data.optional.length : null;
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, ...small }}>Where it works</Text>
        <Text style={{ ...small, color: c.foreground }}>{on === null ? "…" : `${on} of ${all} on`}</Text>
        <Link label="Edit" onPress={() => setOpen(true)} colors={c} />
      </View>
      <Sheet
        title="Jev · where it works"
        open={open}
        onOpenChange={(shown: boolean) => (shown ? undefined : setOpen(false))}
      >
        <Sheet.Content>
          <View style={{ gap: 18 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
              Jev answers the room's small calls and stays on. Choose where it is asked; what each call costs is logged.
            </Text>
            {data ? (
              <>
                <Section title="Needed for the room to work right" places={data.required} colors={c} />
                <Section
                  title="Optional: when off, the room keeps its own rule"
                  places={data.optional}
                  colors={c}
                  onTurn={(id, value) => turn.mutate({ id, on: value })}
                />
              </>
            ) : (
              <Text style={small}>
                {places.isError ? `Where Jev works could not be read: ${String(places.error)}` : "Reading…"}
              </Text>
            )}
            {turn.isError ? <Text style={{ ...small, color: c.statusWarning }}>{String(turn.error)}</Text> : null}
            <Text style={small}>A switch reaches the room at once, and stays through updates.</Text>
          </View>
        </Sheet.Content>
      </Sheet>
    </>
  );
}
