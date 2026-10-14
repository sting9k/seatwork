import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  changedRoles,
  merge,
  sameChoices,
  SEAT_ROLES,
  seatChoice,
  tierChoices,
  TIER_ROLES,
  type ModelChoice,
  type Table,
} from "../shared/model-choices";
import { ROOM_PROJECT, ROOM_ROLE, traits } from "../shared/workflow";
import {
  roomSettings,
  setupInit,
  setupProject,
  setupRemove,
  setupState,
  setupWatcherKey,
  type RoomChoices,
} from "../shared/setup";
import {
  Badge,
  Btn,
  Card,
  CardHead,
  Chip,
  CLI_COLOR,
  Dot,
  IconTile,
  KeyValue,
  Link,
  Seg,
  Tabs,
  tint,
  Toggle,
  type Colors,
  type Inside,
} from "./kit";
import { ModelChip, RoleTree, type Harness } from "./models";

type State = RpcOutput<typeof setupState>;
type Project = State["projects"][number];
type Choices = Record<string, unknown>;

const STATE_KEY = ["seatwork", "setup.state"];
const ROOM_ROLES = [...SEAT_ROLES, ...TIER_ROLES];
/** The room's own seat by name, for the lines that tell where to ask it. */
const OWN = ROOM_ROLE ? traits(ROOM_ROLE).label : "the room's own seat";
const WATCHER_DOES = {
  off: "Nothing is read.",
  shadow: "Reads the turns of the seats it watches and logs what it finds. Nobody is mailed.",
  on: "Reads the turns of the seats it watches. What it finds is mailed to the seat above.",
} as const;
const MONO = { dataSet: { pmono: "true" }, style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } };

/** What went wrong, in the room's words: Paseo wraps a refused request in its own prefix. */
const failed = (error: unknown) =>
  error
    ? (error instanceof Error ? error.message : String(error))
        .replace(/^Request failed: /, "")
        .replace(/ requestType=\S+( code=\S+)?$/, "")
    : null;
/** A path as its owner writes it. */
const short = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

/** The sidebar row: it opens the screen, and says when the room is not set up or a check needs the Owner. */
export function SetupItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const read = useRpc(setupState);
  const state = useQuery({ queryKey: STATE_KEY, queryFn: () => read({}) });
  const data = state.data as State | undefined;
  const word = !data
    ? null
    : !data.applied
      ? "Set up"
      : data.checks.some((check) => check.ok === false)
        ? "Needs you"
        : null;
  return (
    <SidebarRow
      icon="Armchair"
      label="Seatwork"
      active={currentScreen?.screenId === "setup"}
      onPress={() => openScreen({ screenId: "setup" })}
      trailing={word ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{word}</Text> : undefined}
    />
  );
}

/** How the page lays itself out at the width it was given. */
interface Fit {
  rail: boolean;
  narrow: boolean;
}

/** The room screen's two parts. */
type Part = "settings" | "projects";
/** Opens the screen: on a project's own models, or on one of its parts. */
export type Open = (to?: { project?: string; part?: Part }) => void;

/** Seatwork's screen: the room's setup in two parts, or one project's own models. */
export function SetupScreen({ theme, layout, params, open }: PluginScreenProps & { open: Open }) {
  const c = theme.colors;
  const readState = useRpc(setupState);
  const state = useQuery({ queryKey: STATE_KEY, queryFn: () => readState({}) });
  const data = state.data as State | undefined;
  const [width, setWidth] = useState(0);
  const fit: Fit = { rail: width >= 1000, narrow: layout.compact || (width > 0 && width < 700) };
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        paddingVertical: layout.compact ? 16 : 28,
        paddingHorizontal: layout.compact ? 16 : 28,
        alignItems: "center",
      }}
    >
      <View
        onLayout={(event: { nativeEvent: { layout: { width: number } } }) => setWidth(event.nativeEvent.layout.width)}
        style={{ width: "100%", maxWidth: 1088, gap: fit.narrow ? 16 : 24 }}
      >
        {!data ? (
          <Text style={{ color: state.error ? c.statusDanger : c.foregroundMuted }}>
            {failed(state.error) ?? "Reading this host…"}
          </Text>
        ) : params.project ? (
          <View key={params.project} style={{ gap: fit.narrow ? 16 : 24 }}>
            <ProjectModels data={data} name={params.project} open={open} fit={fit} colors={c} />
          </View>
        ) : (
          <RoomSetup
            data={data}
            open={open}
            start={params.part === "projects" ? "projects" : "settings"}
            fit={fit}
            colors={c}
          />
        )}
      </View>
    </ScrollView>
  );
}

/** A role's place in a table: one seat, or the models of a role of several. */
const rolePart = (table: Table, role: string) => (TIER_ROLES.includes(role) ? table[role] : table.seats[role]);
/** The room's table with what was last applied laid over it: what the room runs on now. */
const runningTable = (data: State): Table => merge(data.table, data.applied?.models ?? {}) as Table;

/** The main column beside the rail of cards about the room; one column when there is no room for two. */
function Columns(props: { fit: Fit; top?: Inside; main: Inside; rail: Inside }) {
  if (!props.fit.rail) {
    return (
      <View style={{ gap: props.fit.narrow ? 12 : 16 }}>
        {props.top}
        {props.main}
        {props.rail}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 20 }}>
      <View style={{ flex: 1, gap: 20 }}>{props.main}</View>
      <View style={{ width: 296, gap: 12 }}>
        {props.top}
        {props.rail}
      </View>
    </View>
  );
}

/** How things stand, in a dot and two lines: the head of a card that carries the one button. */
function Standing(props: { tone: "ok" | "warn" | "idle"; title: string; sub: string; colors: Colors }) {
  const c = props.colors;
  const color = props.tone === "ok" ? c.statusSuccess : props.tone === "warn" ? c.statusWarning : c.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: tint(color, 0.18),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Dot color={color} size={10} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>{props.title}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{props.sub}</Text>
      </View>
    </View>
  );
}

/** A rail card's name beside its icon. */
function RailHead(props: { icon: string; title: string; colors: Colors }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
      <Icon name={props.icon} size={15} color={props.colors.foreground} />
      <Text
        accessibilityRole="header"
        style={{ color: props.colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}
      >
        {props.title}
      </Text>
    </View>
  );
}

const RAIL = { padding: 16, gap: 12 };
const small = (c: Colors) => ({ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 });

/** The line under a table: when a change reaches a seat. */
function TableFoot(props: { text: string; right?: Inside; colors: Colors }) {
  const c = props.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderTopWidth: 1,
        borderTopColor: c.border,
      }}
    >
      <Icon name="Info" size={14} color={c.foregroundMuted} />
      <Text style={{ ...small(c), flex: 1, minWidth: 220 }}>{props.text}</Text>
      {props.right}
    </View>
  );
}

/** The agent CLIs a table puts a role on, each with its mark. */
function Legend(props: { table: Table; harnesses: Harness[]; colors: Colors }) {
  const { table, harnesses, colors: c } = props;
  const used = new Set([
    ...SEAT_ROLES.map((role) => seatChoice(table, role).harness),
    ...TIER_ROLES.flatMap((role) => tierChoices(table, role).map((tier) => tier.harness)),
  ]);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, paddingTop: 2 }}>
      {harnesses
        .filter((h) => used.has(h.id))
        .map((h) => (
          <View key={h.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot color={CLI_COLOR[h.id] ?? c.foregroundMuted} />
            <Text style={small(c)}>{h.label}</Text>
          </View>
        ))}
    </View>
  );
}

/** What Remove did: where the room went, whose notes went with it, and what it would not touch. */
function removedLine(done: RpcOutput<typeof setupRemove>): string {
  const count = done.projects.length;
  const kept = done.projects
    .filter((project) => project.left.length > 0)
    .map((project) => `${short(project.root)}/.seatwork (${project.left.join(", ")})`);
  return [
    `The room was removed. Its folder is kept at ${short(done.movedTo)}${count ? `, with the room's notes from ${count} project${count === 1 ? "" : "s"}` : ""}, for 30 days.`,
    kept.length ? `Left in place, not the room's: ${kept.join("; ")}.` : "",
    ...done.notes,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The room's setup: each role's model and the projects that follow it; the room changes on Init or Apply. */
function RoomSetup({
  data,
  open,
  start,
  fit,
  colors: c,
}: {
  data: State;
  open: Open;
  start: Part;
  fit: Fit;
  colors: Colors;
}) {
  const [part, setPart] = useState(start);
  const settings = useSettings(roomSettings);
  const runInit = useRpc(setupInit);
  const runRemove = useRpc(setupRemove);
  const saveKey = useRpc(setupWatcherKey);
  const queries = useQueryClient();
  const refetch = () => void queries.invalidateQueries({ queryKey: STATE_KEY });
  const [confirming, setConfirming] = useState(false);
  const [keying, setKeying] = useState(false);
  const [key, setKey] = useState("");

  const values: RoomChoices | null = settings.status === "ready" ? settings.values : null;
  const init = useMutation({ mutationFn: () => runInit(values!), onSuccess: refetch });
  const remove = useMutation({
    mutationFn: () => runRemove({}),
    onSuccess: () => {
      init.reset(); // what the last Init reported is no longer there
      setConfirming(false);
      refetch();
    },
  });
  const storeKey = useMutation({
    mutationFn: (value: string) => saveKey({ key: value }),
    onSuccess: () => {
      setKey("");
      setKeying(false);
      refetch();
    },
  });
  const done = init.data as RpcOutput<typeof setupInit> | undefined;
  const moved = remove.data as RpcOutput<typeof setupRemove> | undefined;

  // a room set up from a terminal: the screen starts from what it runs on
  const applied = data.applied;
  const unsaved = settings.status === "ready" && settings.revision === "missing";
  useEffect(() => {
    if (unsaved && applied && settings.status === "ready")
      void settings.save({ models: applied.models, watcher: applied.watcher, chime: applied.chime }, settings.revision);
  }, [unsaved, applied !== null]);

  if (!values) {
    const problem = settings.status === "error" || settings.status === "invalid" ? settings.error : null;
    return (
      <Text style={{ color: problem ? c.statusDanger : c.foregroundMuted }}>{problem ?? "Reading this host…"}</Text>
    );
  }

  const revision = settings.status === "ready" ? settings.revision : "";
  const save = (next: RoomChoices) => void settings.save(next, revision);
  const shipped = data.table as unknown as Table;
  const table = merge(shipped, values.models) as Table;
  const running = applied ? runningTable(data) : null;
  const busy = init.isPending || remove.isPending;

  // what Apply would change, by name
  const waiting =
    !applied || !running
      ? []
      : [
          ...ROOM_ROLES.filter((role) => !sameChoices(rolePart(table, role), rolePart(running, role))).map(
            (role) => `${traits(role).label} ${TIER_ROLES.includes(role) ? "models" : "model"}`,
          ),
          ...(values.watcher !== applied.watcher ? ["Watcher mode"] : []),
          ...(values.chime !== applied.chime ? ["Chime"] : []),
        ];
  const stale = applied !== null && applied.version !== data.version;
  const sharing = data.projects.filter((project) => !project.own).length;
  const apply = () => {
    remove.reset();
    init.mutate();
  };

  const room = (
    <Card colors={c} style={RAIL}>
      {!applied ? (
        <>
          <Standing tone="idle" title="Not set up yet" sub="Nothing exists before Init." colors={c} />
          <Text style={small(c)}>
            Init creates the room's folder, its seats and profiles in Paseo, and the {ROOM_PROJECT} project.
          </Text>
          <Btn label={init.isPending ? "Working…" : "Init"} kind="primary" disabled={busy} onPress={apply} colors={c} />
        </>
      ) : waiting.length > 0 ? (
        <>
          <Standing
            tone="warn"
            title={`${waiting.length} ${waiting.length === 1 ? "change" : "changes"} not applied`}
            sub={waiting.join(" · ")}
            colors={c}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Btn
              label={init.isPending ? "Working…" : "Apply changes"}
              kind="primary"
              grow
              disabled={busy}
              onPress={apply}
              colors={c}
            />
            <Btn
              label="Discard"
              disabled={busy}
              onPress={() => save({ models: applied.models, watcher: applied.watcher, chime: applied.chime })}
              colors={c}
            />
          </View>
        </>
      ) : stale ? (
        <>
          <Standing
            tone="warn"
            title="The room's files are older"
            sub={`Set up by ${applied.version || "an earlier version"}. No new seat opens until they are applied.`}
            colors={c}
          />
          <Btn
            label={init.isPending ? "Working…" : "Apply"}
            kind="primary"
            disabled={busy}
            onPress={apply}
            colors={c}
          />
        </>
      ) : (
        <Standing tone="ok" title={`Running · ${applied.seats.length} seats`} sub="Everything is applied" colors={c} />
      )}
      {init.error ? <Text style={{ ...small(c), color: c.statusDanger }}>{failed(init.error)}</Text> : null}
      {done && done.notes.length > 0 ? <Text style={small(c)}>{done.notes.join(" ")}</Text> : null}
      {moved ? <Text style={small(c)}>{removedLine(moved)}</Text> : null}
      <KeyValue name="Plugin" value={data.version} colors={c} />
      {applied ? <KeyValue name="Folder" value={short(data.home)} mono colors={c} /> : null}
    </Card>
  );

  const pad = fit.narrow ? 12 : 20;
  const main = (
    <>
      <Card colors={c}>
        <CardHead
          title="Models"
          sub={
            applied && data.projects.length
              ? `The room's table. ${OWN} and ${sharing} of ${data.projects.length} projects run on it.`
              : `The room's table: what each role runs on. ${OWN} and every project without models of its own follow it.`
          }
          right={fit.narrow ? undefined : <Legend table={table} harnesses={data.harnesses} colors={c} />}
          colors={c}
        />
        <View style={{ paddingHorizontal: pad, paddingBottom: 18 }}>
          <RoleTree
            mode="room"
            base={shipped}
            choices={values.models}
            running={running}
            harnesses={data.harnesses}
            onChange={(models) => save({ ...values, models: models as RoomChoices["models"] })}
            where="the room's table"
            compact={fit.narrow}
            colors={c}
          />
        </View>
        <TableFoot
          text={
            applied
              ? "A change reaches seats opened after Apply. Seats already open keep their model."
              : "Press a role to change what it runs on. You can change it again later."
          }
          right={
            Object.keys(values.models).length ? (
              <Link
                label="Back to the shipped table"
                icon="RotateCcw"
                onPress={() => save({ ...values, models: {} })}
                colors={c}
              />
            ) : undefined
          }
          colors={c}
        />
      </Card>
    </>
  );

  const projects = (
    <>
      {applied && running ? (
        <Card colors={c}>
          <CardHead
            title="Projects"
            count={data.projects.length}
            sub="A project runs on the room's table unless you give it models of its own. Press one to change its models."
            colors={c}
          />
          <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
            {data.projects.map((project, index) => (
              <Pressable
                key={project.name}
                accessibilityRole="button"
                accessibilityLabel={`${project.name}: its models`}
                onPress={() => open({ project: project.name })}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 14,
                  paddingVertical: 11,
                  paddingHorizontal: 12,
                  borderTopWidth: index > 0 ? 1 : 0,
                  borderTopColor: c.border,
                }}
              >
                <View style={{ gap: 1, ...(fit.narrow ? { flex: 1 } : { width: 208 }) }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: c.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}
                  >
                    {project.name}
                  </Text>
                  <Text
                    {...MONO}
                    numberOfLines={1}
                    style={{ ...MONO.style, color: c.foregroundMuted, fontSize: 11.5, lineHeight: 16 }}
                  >
                    {short(project.root)}
                  </Text>
                </View>
                <ProjectChanges
                  project={project}
                  running={running}
                  harnesses={data.harnesses}
                  brief={fit.narrow}
                  colors={c}
                />
                <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
              </Pressable>
            ))}
            {data.projects.length === 0 ? (
              <Text style={{ ...small(c), paddingVertical: 10, paddingHorizontal: 12 }}>
                No project is in the room yet. Open {OWN} in the {ROOM_PROJECT} project and write: set up project X.
              </Text>
            ) : null}
          </View>
        </Card>
      ) : (
        <Card colors={c} style={RAIL}>
          <Text style={small(c)}>Projects appear here once the room is set up: press Init under Settings.</Text>
        </Card>
      )}
    </>
  );

  const rail = (
    <>
      <Card colors={c} style={RAIL}>
        <RailHead icon="Eye" title="Watcher" colors={c} />
        <Seg
          options={[
            { label: "Off", value: "off" },
            { label: "Shadow", value: "shadow" },
            { label: "On", value: "on" },
          ]}
          value={values.watcher}
          onChange={(watcher: RoomChoices["watcher"]) => save({ ...values, watcher })}
          colors={c}
        />
        <Text style={small(c)}>{WATCHER_DOES[values.watcher]}</Text>
        {applied ? (
          <>
            <View style={{ height: 1, backgroundColor: c.border }} />
            <KeyValue
              name="Model key"
              icon="KeyRound"
              right={
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  {data.watcherKey ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                      <Icon name="Check" size={13} color={c.statusSuccess} />
                      <Text style={{ color: c.statusSuccess, fontSize: 12, fontWeight: "500" }}>Stored</Text>
                    </View>
                  ) : (
                    <Text style={small(c)}>Not set</Text>
                  )}
                  <Link
                    label={keying ? "Close" : data.watcherKey ? "Replace" : "Add"}
                    onPress={() => setKeying(!keying)}
                    colors={c}
                  />
                </View>
              }
              colors={c}
            />
            {keying ? (
              <View style={{ gap: 8 }}>
                <TextInput
                  accessibilityLabel="Watcher key"
                  placeholder="Paste a key"
                  placeholderTextColor={c.foregroundMuted}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={key}
                  onChangeText={setKey}
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
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Btn
                    label={storeKey.isPending ? "Saving…" : "Store key"}
                    kind="primary"
                    grow
                    disabled={!key.trim() || storeKey.isPending}
                    onPress={() => storeKey.mutate(key)}
                    colors={c}
                  />
                  {data.watcherKey ? (
                    <Btn
                      label="Remove"
                      kind="danger"
                      disabled={storeKey.isPending}
                      onPress={() => storeKey.mutate("")}
                      colors={c}
                    />
                  ) : null}
                </View>
                <Text style={small(c)}>
                  Four rules ask a model with it. Without a key they only log, and nothing leaves this machine.
                </Text>
                {storeKey.error ? (
                  <Text style={{ ...small(c), color: c.statusDanger }}>{failed(storeKey.error)}</Text>
                ) : null}
              </View>
            ) : null}
            {data.spend ? (
              <View style={{ gap: 7 }}>
                <KeyValue
                  name="This month"
                  value={`$${data.spend.usd.toFixed(2)} of $${data.spend.planUsd.toFixed(2)}`}
                  colors={c}
                />
                <View style={{ height: 4, borderRadius: 2, backgroundColor: tint(c.foreground, 0.1) }}>
                  <View
                    style={{
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: data.spend.usd > data.spend.planUsd ? c.statusWarning : c.statusSuccess,
                      width: `${Math.min(100, data.spend.planUsd > 0 ? (data.spend.usd / data.spend.planUsd) * 100 : 0)}%`,
                    }}
                  />
                </View>
              </View>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card colors={c} style={{ ...RAIL, flexDirection: "row", alignItems: "center" }}>
        <Icon name="Bell" size={15} color={c.foreground} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>Chime</Text>
          <Text style={small(c)}>When a seat waits on you</Text>
        </View>
        <Toggle label="Chime" value={values.chime} onChange={(chime) => save({ ...values, chime })} colors={c} />
      </Card>

      <Card colors={c} style={RAIL}>
        <RailHead icon="Monitor" title="This host" colors={c} />
        {data.checks.map((check) => (
          <View key={check.id} style={{ flexDirection: "row", alignItems: "flex-start", gap: 9 }}>
            <View style={{ paddingTop: 2 }}>
              <Icon
                name={check.ok ? "Check" : check.ok === false ? "TriangleAlert" : "CircleHelp"}
                size={14}
                color={check.ok ? c.statusSuccess : check.ok === false ? c.statusWarning : c.foregroundMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.foreground, fontSize: 12.5, lineHeight: 18 }}>{check.label}</Text>
              {check.ok ? null : <Text style={small(c)}>{check.detail}</Text>}
            </View>
          </View>
        ))}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 2 }}>
          {data.harnesses.map((h) => (
            <View
              key={h.id}
              accessibilityLabel={h.available ? `${h.label}: ready` : `${h.label}: not ready. ${h.why}`}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                height: 24,
                paddingHorizontal: 9,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surface2,
              }}
            >
              <Dot color={h.available ? (CLI_COLOR[h.id] ?? c.foregroundMuted) : tint(c.foreground, 0.25)} />
              <Text style={{ color: h.available ? c.foreground : c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>
                {h.label}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      {applied ? (
        confirming ? (
          <Card colors={c} style={{ ...RAIL, borderColor: tint(c.statusDanger, 0.5) }}>
            <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
              Remove the room?
            </Text>
            <Text style={small(c)}>
              Its seats, its profiles and the {ROOM_PROJECT} project leave Paseo. The room's folder is moved aside with
              its mail and logs, and with it the notes the room kept in each project's .seatwork folder; it is deleted
              30 days later. Your projects and their code stay as they are. Archive the room's agents first.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn
                label={remove.isPending ? "Removing…" : "Remove"}
                kind="danger"
                grow
                disabled={busy}
                onPress={() => remove.mutate()}
                colors={c}
              />
              <Btn label="Cancel" disabled={busy} onPress={() => setConfirming(false)} colors={c} />
            </View>
            {remove.error ? <Text style={{ ...small(c), color: c.statusDanger }}>{failed(remove.error)}</Text> : null}
          </Card>
        ) : (
          <View style={{ paddingVertical: 6, paddingHorizontal: 4 }}>
            <Link
              label="Remove the room…"
              icon="Trash2"
              color={c.statusDanger}
              onPress={() => setConfirming(true)}
              colors={c}
            />
          </View>
        )
      ) : null}
      {settings.saveError ? <Text style={{ ...small(c), color: c.statusDanger }}>{settings.saveError}</Text> : null}
    </>
  );

  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          flexWrap: "wrap",
          columnGap: 22,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 9, height: 36 }}>
          <IconTile icon="Armchair" size={22} fill={c.accent} color={c.accentForeground} colors={c} />
          <Text
            accessibilityRole="header"
            style={{ color: c.foreground, fontSize: 16, lineHeight: 21, fontWeight: "600" }}
          >
            Seatwork
          </Text>
        </View>
        <Tabs
          options={[
            { label: "Settings", value: "settings" },
            { label: "Projects", value: "projects", ...(applied ? { count: data.projects.length } : {}) },
          ]}
          value={part}
          onChange={setPart}
          colors={c}
        />
      </View>
      {part === "settings" ? <Columns fit={fit} top={room} main={main} rail={rail} /> : projects}
    </>
  );
}

/** What a project changes against the room's table, as chips: the roles it puts on a model of its own. */
function ProjectChanges(props: {
  project: Project;
  running: Table;
  harnesses: Harness[];
  brief: boolean;
  colors: Colors;
}) {
  const { project, running, harnesses, brief, colors: c } = props;
  if (project.error) return <Badge text="Needs you" tone="warn" colors={c} />;
  if (!project.own)
    return brief ? (
      <Badge text="Room table" colors={c} />
    ) : (
      <View style={{ flex: 1, flexDirection: "row" }}>
        <Badge text="Room table" colors={c} />
      </View>
    );
  const roles = changedRoles(project.models);
  if (brief)
    return <Badge text={`Own · ${roles.length} ${roles.length === 1 ? "role" : "roles"}`} tone="own" colors={c} />;
  const own = merge(running, project.models) as Table;
  const items: { key: string; role: string; chip: Inside }[] = [];
  for (const role of roles) {
    if (TIER_ROLES.includes(role)) {
      const changed = ((project.models[role] as { tiers?: Record<string, unknown> } | undefined)?.tiers ??
        {}) as Record<string, unknown>;
      const now = new Map(tierChoices(own, role).map((tier) => [tier.label, tier as ModelChoice]));
      for (const [label, value] of Object.entries(changed)) {
        const tier = now.get(label);
        items.push({
          key: `${role}.${label}`,
          role: `${traits(role).label} ${label}`,
          chip:
            value === null || !tier ? (
              <Chip model="removed" tone="gone" colors={c} />
            ) : (
              <ModelChip choice={tier} harnesses={harnesses} colors={c} />
            ),
        });
      }
    } else {
      items.push({
        key: role,
        role: traits(role).label,
        chip: <ModelChip choice={seatChoice(own, role)} harnesses={harnesses} colors={c} />,
      });
    }
  }
  const shown = items.slice(0, 2);
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
      <Badge text="Own" tone="own" colors={c} />
      {shown.map((item) => (
        <View key={item.key} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text style={small(c)}>{item.role}</Text>
          {item.chip}
        </View>
      ))}
      {items.length > shown.length ? <Text style={small(c)}>+{items.length - shown.length} more</Text> : null}
    </View>
  );
}

/** One project's own models: its differences from the room's table, written to `.seatwork/room.json` on Save. */
function ProjectModels({
  data,
  name,
  open,
  fit,
  colors: c,
}: {
  data: State;
  name: string;
  open: Open;
  fit: Fit;
  colors: Colors;
}) {
  const project = data.projects.find((entry) => entry.name === name);
  const write = useRpc(setupProject);
  const queries = useQueryClient();
  const [draft, setDraft] = useState((project?.models ?? {}) as Choices);
  const save = useMutation({
    mutationFn: (models: Choices) => write({ name, models: models as never }),
    onSuccess: () => void queries.invalidateQueries({ queryKey: STATE_KEY }),
  });
  const back = <Link label="Projects" icon="ArrowLeft" onPress={() => open({ part: "projects" })} colors={c} />;
  if (!project || !data.applied) {
    return (
      <>
        {back}
        <Text style={{ color: c.foregroundMuted }}>
          {name} is not a project of the room. Open {OWN} in the {ROOM_PROJECT} project and write: set up project {name}
          .
        </Text>
      </>
    );
  }
  const base = runningTable(data);
  const dirty = !sameChoices(draft, project.models);
  const roles = changedRoles(draft).map((role) => traits(role).label);
  const saved = save.data as RpcOutput<typeof setupProject> | undefined;
  const pad = fit.narrow ? 12 : 20;

  const main = (
    <Card colors={c}>
      <CardHead
        title="Models for this project"
        sub={
          roles.length
            ? `The room's table, with what this project changes. ${roles.length} ${roles.length === 1 ? "role is" : "roles are"} its own.`
            : "The room's table. Change a role to make it this project's own."
        }
        right={
          fit.narrow ? undefined : <Legend table={merge(base, draft) as Table} harnesses={data.harnesses} colors={c} />
        }
        colors={c}
      />
      <View style={{ paddingHorizontal: pad, paddingBottom: 18 }}>
        <RoleTree
          mode="project"
          base={base}
          choices={draft}
          running={base}
          harnesses={data.harnesses}
          onChange={setDraft}
          where={name}
          compact={fit.narrow}
          colors={c}
        />
      </View>
      <TableFoot
        text="Reaches the seats opened in this project from now on. Seats already open keep their model."
        colors={c}
      />
    </Card>
  );

  const state = (
    <Card colors={c} style={RAIL}>
      {dirty ? (
        <Standing
          tone="warn"
          title="Not saved yet"
          sub={
            roles.length ? `${roles.join(" · ")} will be this project's own` : "Every role will follow the room's table"
          }
          colors={c}
        />
      ) : project.error ? (
        <Standing
          tone="warn"
          title="Its table cannot be used"
          sub="Saving it again sets up a seat it lacks."
          colors={c}
        />
      ) : (
        <Standing
          tone="ok"
          title={saved ? "Saved" : roles.length ? "Own models" : "On the room's table"}
          sub={
            roles.length
              ? `${roles.join(" · ")} ${roles.length === 1 ? "is" : "are"} this project's own`
              : "Every role follows the room's table"
          }
          colors={c}
        />
      )}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {/* a table edited by hand may name a seat the room lacks: saving it as it is sets that seat up */}
        <Btn
          label={save.isPending ? "Saving…" : "Save"}
          kind="primary"
          grow
          disabled={(!dirty && !project.error) || save.isPending}
          onPress={() => save.mutate(draft)}
          colors={c}
        />
        {dirty ? (
          <Btn
            label="Discard"
            disabled={save.isPending}
            onPress={() => setDraft(project.models as Choices)}
            colors={c}
          />
        ) : null}
      </View>
      {save.error ? <Text style={{ ...small(c), color: c.statusDanger }}>{failed(save.error)}</Text> : null}
      {!dirty && project.error ? <Text style={{ ...small(c), color: c.statusWarning }}>{project.error}</Text> : null}
      {!dirty && saved && saved.seats.length ? (
        <Text style={small(c)}>Seats set up for it: {saved.seats.join(", ")}.</Text>
      ) : null}
      {roles.length ? (
        <Link label="Use the room's table for every role" icon="RotateCcw" onPress={() => setDraft({})} colors={c} />
      ) : null}
    </Card>
  );

  const rail = (
    <Card colors={c} style={RAIL}>
      <RailHead icon="Info" title="How it works" colors={c} />
      <Text style={small(c)}>
        A role marked Own uses this project's model. The rest follow the room's table, also when that table changes
        later.
      </Text>
    </Card>
  );

  return (
    <>
      <View style={{ gap: 6 }}>
        {back}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <Text
            accessibilityRole="header"
            style={{
              color: c.foreground,
              fontSize: fit.narrow ? 18 : 22,
              lineHeight: fit.narrow ? 24 : 28,
              fontWeight: "600",
            }}
          >
            {name}
          </Text>
          <Badge text={project.own ? "Own models" : "Room table"} tone={project.own ? "own" : undefined} colors={c} />
        </View>
        <Text {...MONO} style={{ ...MONO.style, color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {short(project.root)}/.seatwork/room.json
        </Text>
      </View>
      <Columns fit={fit} top={state} main={main} rail={rail} />
    </>
  );
}
