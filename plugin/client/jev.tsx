import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { jevKey, jevState, jevTry } from "../shared/setup";
import { Btn, Card, KeyValue, Link, tint, type Colors } from "./kit";

/** The decision provider on the Seatwork screen: its key, model, today's calls, the last check and what it cost this month; a modal takes a new key. */

type State = RpcOutput<typeof jevState>;

const KEY_SAID = { file: "Set", env: "From its env variable", none: "Not set", keyless: "None needed" } as const;
const PROVIDER_NAME: Record<string, string> = { openrouter: "OpenRouter", jev: "TypeSafe" };

/** Hour and minute on this device's clock. */
const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** The card: what the provider stands on, and a way to give it a key and to check it. */
export function JevCard(props: { colors: Colors }) {
  const c = props.colors;
  const read = useRpc(jevState);
  const save = useRpc(jevKey);
  const check = useRpc(jevTry);
  const queries = useQueryClient();
  const state = useQuery({ queryKey: ["seatwork", "jev.state"], queryFn: () => read({}), refetchInterval: 30_000 });
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const refresh = () => void queries.invalidateQueries({ queryKey: ["seatwork", "jev.state"] });
  const checking = useMutation({ mutationFn: () => check({}), onSettled: refresh });
  const saving = useMutation({
    mutationFn: (key: string) => save({ key }),
    onSuccess: (done: RpcOutput<typeof jevKey>) => {
      if (done.ok) {
        setOpen(false);
        setTyped("");
      }
    },
    onSettled: refresh,
  });
  const Sheet = Modal as any;
  const data: State | undefined = state.data;
  const small = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
  const last = saving.data && !saving.data.ok ? saving.data : null;
  const name = PROVIDER_NAME[data?.provider ?? ""] ?? "the provider";
  return (
    <Card colors={c} style={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
        <Icon name="Scale" size={15} color={c.foreground} />
        <Text
          accessibilityRole="header"
          style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}
        >
          Jev
        </Text>
      </View>
      <Text style={small}>Answers the room's small calls: the council's readings, the forks, the knowledge gate.</Text>
      <View style={{ height: 1, backgroundColor: c.border }} />
      {data ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="KeyRound" size={13} color={c.foregroundMuted} />
            <Text style={{ flex: 1, ...small }}>{name === "the provider" ? "Key" : `${name} key`}</Text>
            <Text style={small}>{KEY_SAID[data.key]}</Text>
            {data.key === "file" || data.key === "none" ? (
              <Link label={data.key === "none" ? "Add" : "Change"} onPress={() => setOpen(true)} colors={c} />
            ) : null}
          </View>
          <KeyValue name="Model" value={data.model ?? "none"} colors={c} />
          <KeyValue
            name="Calls today"
            value={`${data.calls} · ${data.failed === 0 ? "none failed" : `${data.failed} failed`}`}
            colors={c}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ flex: 1, ...small }}>Last check</Text>
            <Text style={{ ...small, color: data.check && !data.check.ok ? c.statusWarning : c.foreground }}>
              {checking.isPending
                ? "checking…"
                : data.check
                  ? `${clock(data.check.at)} · ${data.check.ok ? `${((data.check.ms ?? 0) / 1000).toFixed(2)} s` : "failed"}`
                  : "not yet"}
            </Text>
            <Link label="Check" onPress={() => checking.mutate()} colors={c} />
          </View>
          {data.check && !data.check.ok ? (
            <Text style={{ ...small, color: c.statusWarning }}>{data.check.why}</Text>
          ) : data.why ? (
            <Text style={{ ...small, color: c.statusWarning }}>{data.why}</Text>
          ) : null}
          <KeyValue name="This month" value={`$${data.monthUsd.toFixed(4)}`} colors={c} />
        </>
      ) : (
        <Text style={small}>
          {state.isError ? `The provider could not be read: ${String(state.error)}` : "Reading…"}
        </Text>
      )}

      <Sheet
        title={`Jev · ${name === "the provider" ? "key" : `${name} key`}`}
        open={open}
        onOpenChange={(shown: boolean) => (shown ? undefined : setOpen(false))}
      >
        <Sheet.Content>
          <View style={{ gap: 14 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>
              Jev calls {name} with this key. The room keeps it in its own folder, readable by you alone; no seat sees
              it.
            </Text>
            <View
              style={{
                gap: 6,
                padding: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surface2,
              }}
            >
              <Text style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 15 }}>Key</Text>
              <TextInput
                accessibilityLabel={`${name} key`}
                placeholder="Paste the key here"
                placeholderTextColor={c.foregroundMuted}
                secureTextEntry
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                value={typed}
                onChangeText={setTyped}
                style={{
                  color: c.foreground,
                  fontSize: 13,
                  height: 34,
                  paddingHorizontal: 10,
                  borderRadius: 9,
                  borderWidth: 1,
                  borderColor: tint(c.foreground, 0.16),
                  backgroundColor: c.surface0,
                }}
              />
            </View>
            {last ? <Text style={{ color: c.statusWarning, fontSize: 12, lineHeight: 17 }}>{last.why}</Text> : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                Saving checks the key with one call.
              </Text>
              <Btn
                label={saving.isPending ? "Saving…" : "Save"}
                kind="primary"
                disabled={saving.isPending || typed.trim().length === 0}
                onPress={() => saving.mutate(typed.trim())}
                colors={c}
              />
            </View>
          </View>
        </Sheet.Content>
      </Sheet>
    </Card>
  );
}
