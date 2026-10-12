import type { RpcOutput } from "@getpaseo/plugin";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { changedRoles, chooseSeat, chooseTier, clearRole, dropTier, isTierLabel, merge, seatChanged, seatChoice, tierChoices, tierDiff, type ModelChoice, type SeatRole, type Table, type TierRole } from "../shared/model-choices";
import type { setupState } from "../shared/setup";
import { Btn, Chip, CLI_COLOR, Dot, IconTile, Seg, tint, type Colors, type Inside } from "./kit";

export type Harness = RpcOutput<typeof setupState>["harnesses"][number];
type Role = SeatRole | TierRole;
type Choices = Record<string, unknown>;

export const ROLE_LABEL: Record<Role, string> = { hq: "HQ", supervisor: "Supervisor", lead: "Lead", peer: "Peer", lens: "Lens" };
const ROLE_ICON: Record<Role, string> = { hq: "Building2", supervisor: "Compass", lead: "Flag", peer: "Hammer", lens: "Eye" };
/** How many of each role a room has: the line under its name. */
const ROLE_COUNT: Record<Role, string> = { hq: "sees every project", supervisor: "one per project", lead: "one per workstream", peer: "one per task", lens: "one per hard question" };

/** What each role is, for whoever opens it to choose its model. */
const ROLE_JOB: Record<Role, string> = {
  hq: "Sees every project and passes your instructions down. It runs on one model.",
  supervisor: "Your counterpart in a project: it splits the work and reports to you. It runs on one model.",
  lead: "Runs one workstream: plans, briefs Peers, accepts or rejects their results. It runs on one model.",
  peer: "One role, several models. The Lead reads each name and what it is for, and picks one per task.",
  lens: "One role, several models. The Lead picks by the question; two lenses are always two different models.",
};

const isTierRole = (role: Role): role is TierRole => role === "peer" || role === "lens";
/** The host's modal; its type leans on React's, which this plugin does not install. */
const Sheet = Modal as any;
/** Paseo sets its own font on everything but what carries this mark. */
const MONO = { dataSet: { pmono: "true" }, style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } };

/** A model as this host names it. */
const modelName = (choice: ModelChoice, harnesses: Harness[]) => harnesses.find((h) => h.id === choice.harness)?.models.find((m) => m.id === choice.model)?.label ?? choice.model;

/** A seat's model as a chip. */
export function ModelChip(props: { choice: ModelChoice; harnesses: Harness[]; tone?: "was" | "new" | "gone"; width?: number; grow?: boolean; colors: Colors }) {
  const { choice, harnesses, tone, width, grow, colors } = props;
  return <Chip cli={choice.harness} model={modelName(choice, harnesses)} thinking={choice.thinking || undefined} tone={tone} width={width} grow={grow} colors={colors} />;
}

/** One model table as its roles, each with its model; a press opens a role to choose what it runs on. */
export function RoleTree(props: {
  mode: "room" | "project";
  base: Table;
  choices: Choices;
  running: Table | null;
  harnesses: Harness[];
  onChange(choices: Choices): void;
  where: string;
  compact: boolean;
  colors: Colors;
}) {
  const { mode, base, choices, running, harnesses, onChange, where, compact, colors: c } = props;
  const [opened, setOpen] = useState(null as Role | null);
  const open = opened as Role | null;
  const [measured, setWidth] = useState(0);
  const width = (measured as number) || (compact ? 340 : 720);
  const table = merge(base, choices) as Table;
  const own = changedRoles(choices);
  // a role's models sit at the far end of its row when there is room, else under its name
  const extra = mode === "project" ? 90 : 0;
  const beside = (role: Role) => width >= (isTierRole(role) ? 490 : 380) + extra;
  const node = (role: Role) => <RoleNode role={role} table={table} running={mode === "room" ? running : base} mode={mode} own={own.includes(role)} row={beside(role)} harnesses={harnesses} onPress={() => setOpen(role)} colors={c} />;
  // a role sits under the one that opens it, while the indent leaves room for the models
  const indent = width >= 620;
  const kids = (children: Inside) => (indent ? <View style={{ marginLeft: 15, paddingLeft: 14, borderLeftWidth: 1.5, borderLeftColor: tint(c.foreground, 0.14), gap: 8 }}>{children}</View> : children);
  return (
    <View onLayout={(event: { nativeEvent: { layout: { width: number } } }) => setWidth(event.nativeEvent.layout.width)} style={{ gap: 8 }}>
      {mode === "project" ? (
        (["supervisor", "lead", "peer", "lens"] as const).map((role) => <View key={role}>{node(role)}</View>)
      ) : (
        <>
          {node("hq")}
          {kids(
            <>
              {node("supervisor")}
              {kids(
                <>
                  {node("lead")}
                  {kids(
                    <>
                      {node("peer")}
                      {node("lens")}
                    </>,
                  )}
                </>,
              )}
            </>,
          )}
        </>
      )}
      <Sheet title={open ? `${ROLE_LABEL[open]} · ${where}` : ""} open={open !== null} onOpenChange={(shown: boolean) => (shown ? undefined : setOpen(null))}>
        <Sheet.Content>
          {open ? (
            <View style={{ gap: 14 }}>
              <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{ROLE_JOB[open]}</Text>
              {isTierRole(open) ? (
                <Tiers role={open} base={base} table={table} harnesses={harnesses} choices={choices} onChange={onChange} colors={c} />
              ) : (
                <ModelCard choice={seatChoice(table, open)} harnesses={harnesses} onChange={(next) => onChange(chooseSeat(choices, open, next))} colors={c} />
              )}
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <Text style={{ flex: 1, minWidth: 160, color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{mode === "room" ? "Kept as a draft until you press Apply." : "Kept as a draft until you press Save."}</Text>
                {mode === "project" && own.includes(open) ? <Btn label="Same as the room's table" onPress={() => onChange(clearRole(choices, open))} colors={c} /> : null}
                <Btn label="Done" kind="primary" onPress={() => setOpen(null)} colors={c} />
              </View>
            </View>
          ) : null}
        </Sheet.Content>
      </Sheet>
    </View>
  );
}

/** One role as a row: what it is, and the model or models it runs on. */
function RoleNode(props: { role: Role; table: Table; running: Table | null; mode: "room" | "project"; own: boolean; row: boolean; harnesses: Harness[]; onPress(): void; colors: Colors }) {
  const { role, table, running, mode, own, row, harnesses, onPress, colors: c } = props;
  const narrow = !row;
  const pending = mode === "room";
  let changed = false;
  let models: Inside;
  if (isTierRole(role)) {
    const tiers = tierDiff(running, table, role);
    changed = tiers.some((tier) => tier.change !== "same");
    models = (
      <View style={{ gap: 6, alignItems: narrow ? "stretch" : "flex-end" }}>
        {tiers.map((tier) => (
          <View key={tier.label} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text {...MONO} numberOfLines={1} style={{ ...MONO.style, color: c.foregroundMuted, fontSize: 11.5, lineHeight: 16, textDecorationLine: tier.change === "removed" ? "line-through" : "none", ...(narrow ? { width: 84 } : { textAlign: "right" }) }}>{tier.label}</Text>
            {tier.change === "removed" ? (
              <Chip model={pending ? "removed" : "removed in this project"} tone="gone" width={narrow ? undefined : 186} grow={narrow} colors={c} />
            ) : (
              <ModelChip choice={tier} harnesses={harnesses} tone={pending && tier.change !== "same" ? "new" : undefined} width={narrow ? undefined : 186} grow={narrow} colors={c} />
            )}
          </View>
        ))}
      </View>
    );
  } else {
    changed = seatChanged(running, table, role);
    const now = seatChoice(table, role);
    models =
      pending && changed && running ? (
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, justifyContent: narrow ? "flex-start" : "flex-end" }}>
          <ModelChip choice={{ ...seatChoice(running, role), thinking: "" }} harnesses={harnesses} tone="was" colors={c} />
          <Icon name="ArrowRight" size={14} color={c.statusWarning} />
          <ModelChip choice={now} harnesses={harnesses} tone="new" colors={c} />
        </View>
      ) : (
        <ModelChip choice={now} harnesses={harnesses} colors={c} />
      );
  }
  const who = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 11, flex: 1, minWidth: 120 }}>
      <IconTile icon={ROLE_ICON[role]} colors={c} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>{ROLE_LABEL[role]}</Text>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{ROLE_COUNT[role]}</Text>
      </View>
    </View>
  );
  const source = mode === "project" ? <Text style={{ width: narrow ? undefined : 76, textAlign: "right", fontSize: 11.5, lineHeight: 16, fontWeight: own ? "600" : "400", color: own ? c.statusSuccess : c.foregroundMuted }}>{own ? "Own" : "Room table"}</Text> : null;
  const go = <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />;
  const waits = pending && changed;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ROLE_LABEL[role]}: choose what it runs on`}
      onPress={onPress}
      style={{ borderRadius: 11, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 12, minHeight: 56, borderColor: waits ? tint(c.statusWarning, 0.5) : mode === "project" && own ? tint(c.statusSuccess, 0.4) : c.border, backgroundColor: waits ? tint(c.statusWarning, 0.08) : c.surface2, ...(narrow ? { gap: 10 } : { flexDirection: "row", alignItems: "center", gap: 14 }) }}
    >
      {narrow ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {who}
            {source}
            {go}
          </View>
          <View style={isTierRole(role) ? {} : { paddingLeft: 43, alignItems: "flex-start" }}>{models}</View>
        </>
      ) : (
        <>
          {who}
          <View style={{ flexShrink: 1, alignItems: "flex-end" }}>{models}</View>
          {source}
          {go}
        </>
      )}
    </Pressable>
  );
}

/** A field of the editor: its name over its control. */
function Field(props: { name: string; grow?: boolean; width?: number; colors: Colors; children: Inside }) {
  return (
    <View style={{ gap: 6, ...(props.grow ? { flex: 1, minWidth: 160 } : {}), ...(props.width ? { width: props.width } : {}) }}>
      <Text style={{ color: props.colors.foregroundMuted, fontSize: 11, lineHeight: 15 }}>{props.name}</Text>
      {props.children}
    </View>
  );
}

/** A closed pick list: what is chosen, and a press to open the list under the fields. */
function PickBox(props: { label: string; text: string; cli?: string; open: boolean; onPress(): void; colors: Colors }) {
  const c = props.colors;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${props.label}: ${props.text}`} onPress={props.onPress} style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 34, paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: props.open ? c.accent : tint(c.foreground, 0.16), backgroundColor: c.surface0 }}>
      {props.cli ? <Dot color={CLI_COLOR[props.cli] ?? c.foregroundMuted} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: "500" }}>{props.text}</Text>
      <Icon name={props.open ? "ChevronUp" : "ChevronDown"} size={14} color={c.foregroundMuted} />
    </Pressable>
  );
}

/** The list a pick box opens: one press picks; a long list is narrowed by what is typed. */
function PickList(props: { items: { id: string; label: string; sub?: string; cli?: string }[]; value: string; onPick(id: string): void; search?: boolean; colors: Colors }) {
  const c = props.colors;
  const [typed, setTyped] = useState("");
  const wanted = typed.trim().toLowerCase();
  const shown = props.items.filter((item) => `${item.label} ${item.sub ?? ""}`.toLowerCase().includes(wanted));
  return (
    <View style={{ borderWidth: 1, borderColor: tint(c.foreground, 0.16), borderRadius: 11, backgroundColor: c.surface0, padding: 6, gap: 2 }}>
      {props.search ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 32, paddingHorizontal: 9, borderBottomWidth: 1, borderBottomColor: c.border, marginBottom: 4 }}>
          <Icon name="Search" size={14} color={c.foregroundMuted} />
          <TextInput accessibilityLabel="Search models" placeholder="Search models" placeholderTextColor={c.foregroundMuted} autoFocus autoCapitalize="none" autoCorrect={false} value={typed} onChangeText={setTyped} style={{ flex: 1, color: c.foreground, fontSize: 13, paddingVertical: 4 }} />
        </View>
      ) : null}
      <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {shown.map((item) => (
          <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.label} onPress={() => props.onPick(item.id)} style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 32, paddingHorizontal: 9, borderRadius: 7, backgroundColor: item.id === props.value ? tint(c.foreground, 0.08) : "transparent" }}>
            {item.cli ? <Dot color={CLI_COLOR[item.cli] ?? c.foregroundMuted} /> : null}
            <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>{item.label}</Text>
            <Text {...MONO} numberOfLines={1} style={{ ...MONO.style, flex: 1, color: c.foregroundMuted, fontSize: 11.5 }}>{item.sub ?? ""}</Text>
            {item.id === props.value ? <Icon name="Check" size={14} color={c.statusSuccess} /> : null}
          </Pressable>
        ))}
        {shown.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 12, padding: 10 }}>No model matches.</Text> : null}
      </ScrollView>
    </View>
  );
}

/** One model of a role: the agent CLI, the model, its thinking level; a Peer's or a Lens's also has a name. */
function ModelCard(props: { choice: ModelChoice; harnesses: Harness[]; onChange(next: ModelChoice): void; tag?: string; use?: string; note?: string; onRemove?(): void; colors: Colors }) {
  const { choice, harnesses, onChange, tag, use, note, onRemove, colors: c } = props;
  const [opened, setOpened] = useState(null as "cli" | "model" | null);
  const harness = harnesses.find((h) => h.id === choice.harness);
  const model = harness?.models.find((m) => m.id === choice.model);
  // a model this host's list does not have stays choosable: it is what the room runs on now
  const models = [...(harness?.models ?? []), ...(model || !choice.model ? [] : [{ id: choice.model, label: `${choice.model} (not in this host's list)`, thinking: [] as string[], defaultThinking: "" }])];
  const toggle = (which: "cli" | "model") => setOpened(opened === which ? null : which);
  return (
    <View style={{ gap: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
      {tag ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ paddingVertical: 3, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: tint(c.foreground, 0.16), backgroundColor: c.surface0 }}>
            <Text {...MONO} style={{ ...MONO.style, color: c.foreground, fontSize: 12, lineHeight: 18 }}>{tag}</Text>
          </View>
          <Text style={{ flex: 1, color: c.foregroundMuted, fontSize: 12.5, lineHeight: 17 }}>{[use, note].filter(Boolean).join(" ")}</Text>
          {onRemove ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${tag}`} onPress={onRemove} style={{ padding: 4 }}>
              <Icon name="Trash2" size={14} color={c.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Field name="Agent CLI" width={150} colors={c}>
          <PickBox label="Agent CLI" text={harness ? (harness.available ? harness.label : `${harness.label} (not ready)`) : choice.harness} cli={choice.harness} open={opened === "cli"} onPress={() => toggle("cli")} colors={c} />
        </Field>
        <Field name="Model" grow colors={c}>
          <PickBox label="Model" text={models.find((m) => m.id === choice.model)?.label ?? "Choose"} open={opened === "model"} onPress={() => toggle("model")} colors={c} />
        </Field>
      </View>
      {harness && !harness.available ? <Text style={{ color: c.statusWarning, fontSize: 12, lineHeight: 17 }}>Not ready on this host: {harness.why}</Text> : null}
      {opened === "cli" ? (
        <PickList
          items={harnesses.filter((h) => h.available || h.id === choice.harness).map((h) => ({ id: h.id, label: h.label, sub: h.available ? `${h.models.length} models` : "not ready", cli: h.id }))}
          value={choice.harness}
          onPick={(id) => {
            const first = harnesses.find((h) => h.id === id)?.models[0];
            if (id !== choice.harness) onChange({ harness: id, model: first?.id ?? "", thinking: first?.defaultThinking ?? "" });
            setOpened(null);
          }}
          colors={c}
        />
      ) : null}
      {opened === "model" ? (
        <PickList
          search
          items={models.map((m) => ({ id: m.id, label: m.label, sub: m.id }))}
          value={choice.model}
          onPick={(id) => {
            onChange({ ...choice, model: id, thinking: models.find((m) => m.id === id)?.defaultThinking ?? "" });
            setOpened(null);
          }}
          colors={c}
        />
      ) : null}
      {model && model.thinking.length > 0 ? (
        <Field name="Thinking" colors={c}>
          <Seg options={model.thinking.map((id) => ({ label: id, value: id }))} value={choice.thinking} onChange={(thinking: string) => onChange({ ...choice, thinking })} colors={c} />
        </Field>
      ) : null}
    </View>
  );
}

/** A Peer's or a Lens's models: a card each, by the name the Lead reads; then a place to add one more. */
function Tiers(props: { role: TierRole; base: Table; table: Table; harnesses: Harness[]; choices: Choices; onChange(choices: Choices): void; colors: Colors }) {
  const { role, base, table, harnesses, choices, onChange, colors: c } = props;
  const tiers = tierChoices(table, role);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [use, setUse] = useState("");
  const name = label.trim().toLowerCase();
  const taken = tiers.some((tier) => tier.label === name);
  const problem = name && !isTierLabel(name) ? "Lower-case letters, digits and dashes." : taken ? "That name is in the table already." : null;
  const first = harnesses.find((h) => h.available);
  const close = () => {
    setAdding(false);
    setLabel("");
    setUse("");
  };
  const input = { color: c.foreground, fontSize: 13, height: 34, paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: tint(c.foreground, 0.16), backgroundColor: c.surface0 };
  return (
    <View style={{ gap: 10 }}>
      {tiers.map((tier) => (
        <View key={tier.label}>
          <ModelCard
            choice={tier}
            harnesses={harnesses}
            tag={tier.label}
            use={tier.use}
            note={tier.more ? `The table lists ${tier.more} more under this name; choosing here leaves one.` : undefined}
            onRemove={tiers.length > 1 ? () => onChange(dropTier(choices, base, role, tier.label)) : undefined}
            onChange={(next) => onChange(chooseTier(choices, role, tier.label, next))}
            colors={c}
          />
        </View>
      ))}
      {adding ? (
        <View style={{ gap: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Field name="Name, as the Lead reads it" width={190} colors={c}>
              <TextInput accessibilityLabel="Name of the new model" placeholder="high, extra…" placeholderTextColor={c.foregroundMuted} autoFocus autoCapitalize="none" autoCorrect={false} value={label} onChangeText={setLabel} style={input} />
            </Field>
            <Field name="Use for" grow colors={c}>
              <TextInput accessibilityLabel="What the Lead picks it for" placeholder="the kind of work" placeholderTextColor={c.foregroundMuted} value={use} onChangeText={setUse} style={input} />
            </Field>
          </View>
          {problem ? <Text style={{ color: c.statusWarning, fontSize: 12, lineHeight: 17 }}>{problem}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Btn label="Cancel" onPress={close} colors={c} />
            <Btn
              label={name && !problem ? `Add "${name}"` : "Add"}
              kind="primary"
              disabled={!first || !name || problem !== null}
              onPress={() => {
                onChange(chooseTier(choices, role, name, { harness: first!.id, model: first!.models[0]?.id ?? "", thinking: first!.models[0]?.defaultThinking ?? "" }, use.trim()));
                close();
              }}
              colors={c}
            />
          </View>
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Add a model" onPress={() => setAdding(true)} style={{ flexDirection: "row", alignItems: "center", gap: 9, height: 46, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: tint(c.foreground, 0.2) }}>
          <Icon name="Plus" size={15} color={c.foregroundMuted} />
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "500" }}>Add a model</Text>
          <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 12 }}>give it a name the Lead will read: high, extra…</Text>
        </Pressable>
      )}
    </View>
  );
}
