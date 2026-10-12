import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { chooseSeat, chooseTier, dropTier, isTierLabel, merge, sameChoices, SEAT_ROLES, seatChoice, tierChoices, TIER_ROLES, type ModelChoice, type Table, type TierRole } from "../shared/model-choices";
import { roomSettings, setupInit, setupRemove, setupState, setupWatcherKey, type RoomChoices } from "../shared/setup";

type State = RpcOutput<typeof setupState>;
type Harness = State["harnesses"][number];
type Colors = PluginSurfaceProps["theme"]["colors"];

const ROLE_LABEL = { hq: "HQ", supervisor: "Supervisor", lead: "Lead", peer: "Peer", lens: "Lens" } as const;

/** What went wrong, in the room's words: Paseo wraps a refused request in its own prefix and request details. */
const failed = (error: unknown) => (error ? (error instanceof Error ? error.message : String(error)).replace(/^Request failed: /, "").replace(/ requestType=\S+( code=\S+)?$/, "") : null);

/**
 * The room's setup: what each role runs on, the watcher and the chime, then one Init. The choices
 * are saved as they are made; the room changes only on Init or Apply.
 */
export function SetupScreen({ theme, layout }: PluginSurfaceProps) {
  const c = theme.colors;
  const settings = useSettings(roomSettings);
  const readState = useRpc(setupState);
  const runInit = useRpc(setupInit);
  const runRemove = useRpc(setupRemove);
  const saveKey = useRpc(setupWatcherKey);
  const state = useQuery({ queryKey: ["slp-seat", "setup.state"], queryFn: () => readState({}) });
  const data = state.data as State | undefined;
  const refetch = () => void state.refetch();
  const [opened, setOpened] = useState(null as string | null);
  const toggle = (role: string) => setOpened(opened === role ? null : role);
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState("");
  const keyInput = useRef(null as { replaceText(text: string): void } | null);

  const values: RoomChoices | null = settings.status === "ready" ? settings.values : null;
  const init = useMutation({ mutationFn: () => runInit(values!), onSuccess: refetch });
  const remove = useMutation({
    mutationFn: () => runRemove({}),
    onSuccess: () => {
      init.reset(); // what the last Init reported is no longer there
      refetch();
    },
  });
  const storeKey = useMutation({
    mutationFn: () => saveKey({ key }),
    onSuccess: () => {
      keyInput.current?.replaceText("");
      setKey("");
      refetch();
    },
  });
  const done = init.data as RpcOutput<typeof setupInit> | undefined;
  const moved = remove.data as RpcOutput<typeof setupRemove> | undefined;

  // a room set up before this screen existed (install.sh): the screen starts from what it runs on, not from the room's defaults
  const applied = data?.applied ?? null;
  const unsaved = settings.status === "ready" && settings.revision === "missing";
  useEffect(() => {
    if (unsaved && applied && settings.status === "ready") void settings.save({ models: applied.models, watcher: applied.watcher, chime: applied.chime }, settings.revision);
  }, [unsaved, applied !== null]);

  const pad = layout.compact ? 16 : 24;
  if (!values || !data) {
    const problem = settings.status === "error" || settings.status === "invalid" ? settings.error : failed(state.error);
    return (
      <View style={{ flex: 1, padding: pad, backgroundColor: c.surface0 }}>
        <Text style={{ color: problem ? c.statusDanger : c.foregroundMuted }}>{problem ?? "Reading this host…"}</Text>
      </View>
    );
  }

  const revision = settings.status === "ready" ? settings.revision : "";
  const save = (next: RoomChoices) => void settings.save(next, revision);
  const room = data.table as unknown as Table;
  const table = merge(room, values.models) as Table;
  const dirty = applied !== null && !sameChoices(values, { models: applied.models, watcher: applied.watcher, chime: applied.chime });
  const busy = init.isPending || remove.isPending;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: pad, gap: 20 }}>
      <SettingsSection title="Room">
        <SettingsAction
          label={applied ? `Set up: ${applied.seats.length} seats${dirty ? " · changes not applied" : ""}` : "Not set up yet"}
          hint={applied ? data.home : "Init creates the room's folder, its seats and profiles in Paseo, and the hq-seatwork project. Nothing exists before it."}
          actionLabel={init.isPending ? "Working…" : applied ? "Apply" : "Init"}
          disabled={busy}
          error={failed(init.error)}
          onPress={() => {
            remove.reset();
            init.mutate();
          }}
        />
        {done ? <SettingsRow label="Done" hint={[`Seats: ${done.seats.join(", ")}`, done.removed.length ? `Removed: ${done.removed.join(", ")}` : "", ...done.notes].filter(Boolean).join("\n")} /> : null}
        {moved ? <SettingsRow label="Room removed" hint={`Its folder is kept at ${moved.movedTo}`} /> : null}
      </SettingsSection>

      <SettingsSection title="What each role runs on">
        {SEAT_ROLES.map((role) => {
          const choice = seatChoice(table, role);
          return (
            <View key={role}>
              <RoleLine label={ROLE_LABEL[role]} summary={describe(choice, data.harnesses)} open={opened === role} onToggle={() => toggle(role)} colors={c} />
              {opened === role ? <ModelFields choice={choice} harnesses={data.harnesses} thinking onChange={(next) => save({ ...values, models: chooseSeat(values.models, role, next) as RoomChoices["models"] })} colors={c} /> : null}
            </View>
          );
        })}
        {TIER_ROLES.map((role) => (
          <View key={role}>
            <RoleLine
              label={ROLE_LABEL[role]}
              summary={tierChoices(table, role).map((tier) => `${tier.label}: ${modelName(tier, data.harnesses)}`).join("  ·  ")}
              open={opened === role}
              onToggle={() => toggle(role)}
              colors={c}
            />
            {opened === role ? <Tiers role={role} room={room} table={table} harnesses={data.harnesses} models={values.models} onChange={(models) => save({ ...values, models: models as RoomChoices["models"] })} colors={c} /> : null}
          </View>
        ))}
        {Object.keys(values.models).length ? <SettingsAction label="The room's own table" hint="Drops every choice above." actionLabel="Reset" onPress={() => save({ ...values, models: {} })} /> : null}
      </SettingsSection>

      <SettingsSection title="Watcher and sound">
        <SettingsSelect
          label="Watcher"
          hint="Off, shadow (it reads and logs), or on (it also mails the seat above)."
          value={values.watcher}
          options={[{ label: "Off", value: "off" }, { label: "Shadow", value: "shadow" }, { label: "On", value: "on" }]}
          onValueChange={(watcher: RoomChoices["watcher"]) => save({ ...values, watcher })}
        />
        {applied ? (
          <SettingsInput
            ref={keyInput}
            label="Watcher key"
            hint={data.watcherKey ? "A key is stored. Type a new one to replace it; save an empty one to remove it." : "No key: the rules that ask a model only log their facts."}
            placeholder="Paste a key"
            secureTextEntry
            onChangeText={setKey}
            error={failed(storeKey.error)}
          />
        ) : null}
        {applied && (key || data.watcherKey) ? <SettingsAction label={key ? "Store this key" : "Remove the stored key"} actionLabel={storeKey.isPending ? "Saving…" : key ? "Save" : "Remove"} disabled={storeKey.isPending} onPress={() => storeKey.mutate()} /> : null}
        <SettingsSwitch label="Chime" hint="A short sound in the open app when a seat waits on you." value={values.chime} onValueChange={(chime: boolean) => save({ ...values, chime })} />
      </SettingsSection>

      <SettingsSection title="This host">
        {data.checks.map((check) => (
          <SettingsRow key={check.id} label={check.label} hint={check.detail}>
            <Text style={{ color: check.ok ? c.statusSuccess : check.ok === false ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{check.ok ? "OK" : check.ok === false ? "Needs you" : "Unknown"}</Text>
          </SettingsRow>
        ))}
        {applied ? (
          <SettingsAction
            label="Remove the room"
            hint="Takes its seats and profiles out of Paseo, archives the hq-seatwork workspace and moves the room's folder aside. Mail and logs stay in the moved folder. The empty hq-seatwork project stays in Paseo's list; remove it there if you want it gone."
            actionLabel={remove.isPending ? "Removing…" : confirming ? "Press again to remove" : "Remove"}
            disabled={busy}
            error={failed(remove.error)}
            onPress={() => {
              if (confirming) remove.mutate();
              setConfirming(!confirming);
            }}
          />
        ) : null}
      </SettingsSection>
      {settings.saveError ? <Text style={{ color: c.statusDanger }}>{settings.saveError}</Text> : null}
    </ScrollView>
  );
}

/** A model as this host names it. */
const modelName = (choice: ModelChoice, harnesses: Harness[]) => harnesses.find((h) => h.id === choice.harness)?.models.find((m) => m.id === choice.model)?.label ?? choice.model;

/** A model in a line: the agent CLI, the model, the thinking level. */
function describe(choice: ModelChoice, harnesses: Harness[]): string {
  return [harnesses.find((h) => h.id === choice.harness)?.label ?? choice.harness, modelName(choice, harnesses), choice.thinking || null].filter(Boolean).join(" · ");
}

/** A role on one line; a press opens what it runs on. */
function RoleLine(props: { label: string; summary: string; open: boolean; onToggle(): void; colors: Colors }) {
  const { label, summary, open, onToggle, colors: c } = props;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${summary}`} onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 12 }}>
      <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600", width: 96 }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 13, flex: 1 }}>{summary}</Text>
      <Text style={{ color: c.foregroundMuted }}>{open ? "⌄" : "›"}</Text>
    </Pressable>
  );
}

/** The agent CLI, the model and, where the place carries one, the thinking level. */
function ModelFields(props: { choice: ModelChoice; harnesses: Harness[]; thinking: boolean; onChange(next: ModelChoice): void; colors: Colors }) {
  const { choice, harnesses, onChange, colors } = props;
  const harness = harnesses.find((h) => h.id === choice.harness);
  const model = harness?.models.find((m) => m.id === choice.model);
  // a model this host's list does not have stays choosable: it is what the room runs on now
  const models = [...(harness?.models ?? []), ...(model || !choice.model ? [] : [{ id: choice.model, label: `${choice.model} (not in this host's list)`, thinking: [] as string[], defaultThinking: "" }])];
  const pick = (id: string) => onChange({ ...choice, model: id, thinking: models.find((m) => m.id === id)?.defaultThinking ?? "" });
  return (
    <View>
      <SettingsSelect
        label="Agent CLI"
        hint={harness && !harness.available ? `Not ready on this host: ${harness.why}` : undefined}
        value={choice.harness}
        options={harnesses.filter((h) => h.available || h.id === choice.harness).map((h) => ({ label: h.available ? h.label : `${h.label} (not ready)`, value: h.id }))}
        onValueChange={(id: string) => {
          const first = harnesses.find((h) => h.id === id)?.models[0];
          onChange({ harness: id, model: first?.id ?? "", thinking: first?.defaultThinking ?? "" });
        }}
      />
      <ModelPicker value={choice.model} models={models} onPick={pick} colors={colors} />
      {props.thinking && model && model.thinking.length > 0 ? (
        <SettingsSelect label="Thinking" value={choice.thinking} options={model.thinking.map((id) => ({ label: id, value: id }))} onValueChange={(thinking: string) => onChange({ ...choice, thinking })} />
      ) : null}
    </View>
  );
}

/** The model of a place: its name, and a list to pick another from, narrowed by what is typed. */
function ModelPicker(props: { value: string; models: Harness["models"]; onPick(id: string): void; colors: Colors }) {
  const { value, models, onPick, colors: c } = props;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const wanted = typed.trim().toLowerCase();
  const shown = models.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(wanted));
  const current = models.find((m) => m.id === value);
  return (
    <View>
      <SettingsRow label="Model">
        <Pressable accessibilityRole="button" accessibilityLabel={`Model: ${current?.label ?? "none"}`} onPress={() => setOpen(!open)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: c.border }}>
          <Text style={{ color: c.foreground, fontSize: 13 }}>{current?.label ?? "Choose"} {open ? "⌃" : "⌄"}</Text>
        </Pressable>
      </SettingsRow>
      {open ? (
        <View style={{ marginHorizontal: 14, marginBottom: 8, borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.surface1 }}>
          <TextInput
            accessibilityLabel="Search models"
            placeholder="Search models"
            placeholderTextColor={c.foregroundMuted}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            value={typed}
            onChangeText={setTyped}
            style={{ color: c.foreground, fontSize: 13, paddingVertical: 9, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border }}
          />
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {shown.map((m) => (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                onPress={() => {
                  onPick(m.id);
                  setOpen(false);
                  setTyped("");
                }}
                style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 12 }}
              >
                <Text style={{ color: m.id === value ? c.accent : c.foreground, fontSize: 13 }}>{m.label}</Text>
                <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, flex: 1 }}>{m.id}</Text>
              </Pressable>
            ))}
            {shown.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 12, padding: 12 }}>No model matches.</Text> : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** A Peer's or a Lens's models: one role, several named models; the Lead reads the names and what each is for, and picks. */
function Tiers(props: { role: TierRole; room: Table; table: Table; harnesses: Harness[]; models: Record<string, unknown>; onChange(models: Record<string, unknown>): void; colors: Colors }) {
  const { role, room, table, harnesses, models, onChange, colors: c } = props;
  const tiers = tierChoices(table, role);
  const [label, setLabel] = useState("");
  const [use, setUse] = useState("");
  const labelInput = useRef(null as { replaceText(text: string): void } | null);
  const useInput = useRef(null as { replaceText(text: string): void } | null);
  const name = label.trim().toLowerCase();
  const taken = tiers.some((tier) => tier.label === name);
  const first = harnesses.find((h) => h.available);
  const add = () => {
    onChange(chooseTier(models, role, name, { harness: first!.id, model: first!.models[0]?.id ?? "", thinking: first!.models[0]?.defaultThinking ?? "" }, use.trim()));
    for (const input of [labelInput, useInput]) input.current?.replaceText("");
    setLabel("");
    setUse("");
  };
  return (
    <View>
      {tiers.map((tier) => (
        <View key={tier.label} style={{ borderTopWidth: 1, borderTopColor: c.border }}>
          <SettingsRow label={tier.label} hint={[tier.use, tier.more ? `The table lists ${tier.more} more under this name; choosing here leaves one.` : ""].filter(Boolean).join(" ")}>
            {tiers.length > 1 ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${tier.label}`} onPress={() => onChange(dropTier(models, room, role, tier.label))}>
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>Remove</Text>
              </Pressable>
            ) : null}
          </SettingsRow>
          <ModelFields choice={tier} harnesses={harnesses} thinking onChange={(next) => onChange(chooseTier(models, role, tier.label, next))} colors={c} />
        </View>
      ))}
      <View style={{ borderTopWidth: 1, borderTopColor: c.border }}>
        <SettingsInput ref={labelInput} label="One more model" hint="Its name in the table, for example cheap, high or extra." placeholder="name" onChangeText={setLabel} error={name && !isTierLabel(name) ? "Lower-case letters, digits and dashes." : taken ? "That name is in the table already." : null} />
        <SettingsInput ref={useInput} label="Use for" hint="What the Lead picks it for." placeholder="the kind of work" onChangeText={setUse} />
        <SettingsAction label={name && isTierLabel(name) && !taken ? `Add "${name}"` : "Add it"} hint="It starts on this host's first model; choose its own above after adding." actionLabel="Add" disabled={!first || !isTierLabel(name) || taken} onPress={add} />
      </View>
    </View>
  );
}
