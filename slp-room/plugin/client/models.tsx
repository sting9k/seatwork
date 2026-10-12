import type { RpcOutput } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsInput, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { changedRoles, chooseSeat, chooseTier, clearRole, dropTier, isTierLabel, merge, seatChoice, tierChoices, type ModelChoice, type SeatRole, type Table, type TierRole } from "../shared/model-choices";
import type { setupState } from "../shared/setup";
import { Button, Card, Line, Note, Pill, type Colors } from "./kit";

export type Harness = RpcOutput<typeof setupState>["harnesses"][number];
type Role = SeatRole | TierRole;
type Choices = Record<string, unknown>;

export const ROLE_LABEL: Record<Role, string> = { hq: "HQ", supervisor: "Supervisor", lead: "Lead", peer: "Peer", lens: "Lens" };

/** What each role is, for whoever opens it to choose its model. */
const ROLE_JOB: Record<Role, string> = {
  hq: "Sees every project and passes your instructions down. It runs on one model.",
  supervisor: "Your counterpart in a project: it splits the work and reports to you. It runs on one model.",
  lead: "Runs one workstream: plans, briefs Peers, accepts or rejects their results. It runs on one model.",
  peer: "Writes the code for one task. One role with several models: the Lead reads each name and what it is for, and picks one for the task.",
  lens: "Reads only: a second opinion on one hard question. One role with several models: the Lead picks by the question, and two lenses are always two different models.",
};

const isTierRole = (role: Role): role is TierRole => role === "peer" || role === "lens";
/** The host's modal; its type leans on React's, which this plugin does not install. */
const Sheet = Modal as any;

/** A model as this host names it. */
const modelName = (choice: ModelChoice, harnesses: Harness[]) => harnesses.find((h) => h.id === choice.harness)?.models.find((m) => m.id === choice.model)?.label ?? choice.model;

/** A role in a line: the agent CLI, the model and the thinking level; a Peer's or a Lens's models by name. */
export function describeRole(table: Table, role: Role, harnesses: Harness[]): string {
  if (isTierRole(role)) return tierChoices(table, role).map((tier) => `${tier.label}: ${modelName(tier, harnesses)}`).join("  ·  ");
  const choice = seatChoice(table, role);
  return [harnesses.find((h) => h.id === choice.harness)?.label ?? choice.harness, modelName(choice, harnesses), choice.thinking || null].filter(Boolean).join(" · ");
}

/**
 * The roles of one model table, a row each; a press opens the role to choose what it runs on.
 * `choices` are the differences from `base`: the room's choices over the shipped table, or a
 * project's over the room's.
 */
export function Roles(props: {
  roles: readonly Role[];
  base: Table;
  choices: Choices;
  harnesses: Harness[];
  onChange(choices: Choices): void;
  /** Whose table this is, for the editor's title. */
  where: string;
  /** A project's table: a role it changes is marked, and can be given back to the room's. */
  own?: boolean;
  colors: Colors;
}) {
  const { roles, base, choices, harnesses, onChange, where, own, colors: c } = props;
  const [opened, setOpen] = useState(null as Role | null);
  const open = opened as Role | null;
  const table = merge(base, choices) as Table;
  const changed = changedRoles(choices);
  return (
    <View>
      <Card colors={c}>
        {roles.map((role) => (
          <View key={role}>
            <Line
              name={ROLE_LABEL[role]}
              nameWidth={96}
              value={describeRole(table, role, harnesses)}
              right={own && changed.includes(role) ? <Pill text="own" color={c.accent} colors={c} /> : undefined}
              onPress={() => setOpen(role)}
              colors={c}
            />
          </View>
        ))}
      </Card>
      <Sheet title={open ? `${ROLE_LABEL[open]} · ${where}` : ""} open={open !== null} onOpenChange={(shown: boolean) => (shown ? undefined : setOpen(null))}>
        <Sheet.Content>
          {open ? (
            <View style={{ gap: 16 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{ROLE_JOB[open]}</Text>
              {isTierRole(open) ? (
                <Tiers role={open} base={base} table={table} harnesses={harnesses} choices={choices} onChange={onChange} colors={c} />
              ) : (
                <Card colors={c}>
                  <ModelFields choice={seatChoice(table, open)} harnesses={harnesses} onChange={(next) => onChange(chooseSeat(choices, open, next))} colors={c} />
                </Card>
              )}
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10 }}>
                {own && changed.includes(open) ? <Button label="Same as the room's table" onPress={() => onChange(clearRole(choices, open))} colors={c} /> : null}
                <Button label="Done" kind="primary" onPress={() => setOpen(null)} colors={c} />
              </View>
            </View>
          ) : null}
        </Sheet.Content>
      </Sheet>
    </View>
  );
}

/** The agent CLI, the model and, where the model has one, the thinking level. */
function ModelFields(props: { choice: ModelChoice; harnesses: Harness[]; onChange(next: ModelChoice): void; colors: Colors }) {
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
      {model && model.thinking.length > 0 ? (
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
      <Line
        name="Model"
        field
        right={
          <Pressable accessibilityRole="button" accessibilityLabel={`Model: ${current?.label ?? "none"}`} onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border }}>
            <Text style={{ color: c.foreground, fontSize: 13 }}>{current?.label ?? "Choose"}</Text>
            <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
          </Pressable>
        }
        colors={c}
      />
      {open ? (
        <View style={{ marginHorizontal: 16, marginBottom: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.surface0 }}>
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
          <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
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

/** A Peer's or a Lens's models: a card each, by the name the Lead reads; then a place to add one more. */
function Tiers(props: { role: TierRole; base: Table; table: Table; harnesses: Harness[]; choices: Choices; onChange(choices: Choices): void; colors: Colors }) {
  const { role, base, table, harnesses, choices, onChange, colors: c } = props;
  const tiers = tierChoices(table, role);
  const [label, setLabel] = useState("");
  const [use, setUse] = useState("");
  const labelInput = useRef(null as { replaceText(text: string): void } | null);
  const useInput = useRef(null as { replaceText(text: string): void } | null);
  const name = label.trim().toLowerCase();
  const taken = tiers.some((tier) => tier.label === name);
  const first = harnesses.find((h) => h.available);
  const add = () => {
    onChange(chooseTier(choices, role, name, { harness: first!.id, model: first!.models[0]?.id ?? "", thinking: first!.models[0]?.defaultThinking ?? "" }, use.trim()));
    for (const input of [labelInput, useInput]) input.current?.replaceText("");
    setLabel("");
    setUse("");
  };
  return (
    <View style={{ gap: 12 }}>
      {tiers.map((tier) => (
        <View key={tier.label}>
        <Card colors={c}>
          <Line
            name={tier.label}
            note={[tier.use, tier.more ? `The table lists ${tier.more} more under this name; choosing here leaves one.` : ""].filter(Boolean).join(" ")}
            right={tiers.length > 1 ? <Button label="Remove" onPress={() => onChange(dropTier(choices, base, role, tier.label))} colors={c} /> : undefined}
            colors={c}
          />
          <ModelFields choice={tier} harnesses={harnesses} onChange={(next) => onChange(chooseTier(choices, role, tier.label, next))} colors={c} />
        </Card>
        </View>
      ))}
      <Card colors={c}>
        <Note text="One more model for this role." colors={c} />
        <View>
          <SettingsInput ref={labelInput} label="Name" hint="As the Lead reads it: cheap, high, extra…" placeholder="name" onChangeText={setLabel} error={name && !isTierLabel(name) ? "Lower-case letters, digits and dashes." : taken ? "That name is in the table already." : null} />
          <SettingsInput ref={useInput} label="Use for" hint="What the Lead picks it for." placeholder="the kind of work" onChangeText={setUse} />
          <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingBottom: 12 }}>
            <Button label={name && isTierLabel(name) && !taken ? `Add "${name}"` : "Add"} disabled={!first || !isTierLabel(name) || taken} onPress={add} colors={c} />
          </View>
        </View>
      </Card>
    </View>
  );
}
