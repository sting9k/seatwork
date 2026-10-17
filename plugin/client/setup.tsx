import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
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
import settings from "../shared/settings.json";
import { ROOM_PROJECT, ROOM_ROLE, traits } from "../shared/workflow";
import { roomClean } from "../shared/room";
import { roomSettings, setupInit, setupProject, setupRemove, setupState, type RoomChoices } from "../shared/setup";
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
  MONO,
  Tabs,
  tint,
  Toggle,
  type Colors,
  type Inside,
} from "./kit";
import { JevCard } from "./jev";
import { ModelChip, RoleTree, type Harness } from "./models";

type State = RpcOutput<typeof setupState>;
type Project = State["projects"][number];
type Choices = Record<string, unknown>;

const STATE_KEY = ["seatwork", "setup.state"];
const ROOM_ROLES = [...SEAT_ROLES, ...TIER_ROLES];
const OWN = ROOM_ROLE ? traits(ROOM_ROLE).label : "the room's own seat";

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
    `The room was removed. Its folder is kept at ${short(done.movedTo)}${count ? `, with the room's notes from ${count} project${count === 1 ? "" : "s"}` : ""}, for ${settings.keepRemovedDays} days.`,
    kept.length ? `Left in place, not the room's: ${kept.join("; ")}.` : "",
    ...done.notes,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The projects the room works in, each with what it changes in the room's table; a press opens one's models. */
function ProjectsCard(props: {
  projects: Project[];
  running: Table;
  harnesses: Harness[];
  open: Open;
  fit: Fit;
  colors: Colors;
}) {
  const { projects, running, harnesses, open, fit, colors: c } = props;
  return (
    <Card colors={c}>
      <CardHead
        title="Projects"
        count={projects.length}
        sub="A project runs on the room's table unless you give it models of its own. Press one to change its models."
        colors={c}
      />
      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        {projects.map((project, index) => (
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
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, lineHeight: 19, fontWeight: "600" }}>
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
            <ProjectChanges project={project} running={running} harnesses={harnesses} brief={fit.narrow} colors={c} />
            <Icon name="ChevronRight" size={16} color={c.foregroundMuted} />
          </Pressable>
        ))}
        {projects.length === 0 ? (
          <Text style={{ ...small(c), paddingVertical: 10, paddingHorizontal: 12 }}>
            No project is in the room yet. Open {OWN} in the {ROOM_PROJECT} project and write: set up project X.
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

/** What this host can run: its checks, and which agent CLIs are ready. */
function HostCard(props: { checks: State["checks"]; harnesses: Harness[]; colors: Colors }) {
  const { checks, harnesses, colors: c } = props;
  return (
    <Card colors={c} style={RAIL}>
      <RailHead icon="Monitor" title="This host" colors={c} />
      {checks.map((check) => (
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
        {harnesses.map((h) => (
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
  );
}

/** The way out of the room: a link, then a confirmation that says what Remove takes and keeps. */
/** GC on demand: the pass the room runs on its own schedule, run now, and what it cleared. */
function CleanCard(props: { colors: Colors }) {
  const { colors: c } = props;
  const run = useRpc(roomClean);
  const clean = useMutation({ mutationFn: () => run({}) });
  const done = clean.data as RpcOutput<typeof roomClean> | undefined;
  const lines = done?.lines ?? [];
  const shown = lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n… and ${lines.length - 12} more` : "");
  return (
    <Card colors={c} style={RAIL}>
      <RailHead icon="Sparkles" title="Clean up" colors={c} />
      <Text style={small(c)}>
        The room clears what it no longer needs on its own schedule: idle seats, what closed seats left, finished mail,
        old logs and records, and folders set aside by Remove after {settings.keepRemovedDays} days.
      </Text>
      <Btn
        label={clean.isPending ? "Cleaning…" : "Clean up now"}
        disabled={clean.isPending}
        onPress={() => clean.mutate()}
        colors={c}
      />
      {clean.error ? <Text style={{ ...small(c), color: c.statusDanger }}>{failed(clean.error)}</Text> : null}
      {done ? (
        <Text style={small(c)}>
          {done.running ? "A pass was already running; what it clears goes to the log. " : ""}
          {lines.length === 0 ? "Nothing to clear." : shown}
        </Text>
      ) : null}
    </Card>
  );
}

function RemoveCard(props: {
  confirming: boolean;
  setConfirming(on: boolean): void;
  busy: boolean;
  pending: boolean;
  error: unknown;
  onRemove(): void;
  colors: Colors;
}) {
  const { confirming, setConfirming, busy, pending, error, onRemove, colors: c } = props;
  return confirming ? (
    <Card colors={c} style={{ ...RAIL, borderColor: tint(c.statusDanger, 0.5) }}>
      <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>Remove the room?</Text>
      <Text style={small(c)}>
        Its seats, its profiles, the {ROOM_PROJECT} project and the records of its archived seats leave Paseo, and the
        switches Init set for every agent go back to what they were. The room's folder is moved aside with its mail,
        logs and its seats' Claude sessions, and with it the notes the room kept in each project's .seatwork folder; it
        is deleted {settings.keepRemovedDays} days later. Your projects and their code stay as they are. Archive the
        room's agents first.
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn
          label={pending ? "Removing…" : "Remove"}
          kind="danger"
          grow
          disabled={busy}
          onPress={() => onRemove()}
          colors={c}
        />
        <Btn label="Cancel" disabled={busy} onPress={() => setConfirming(false)} colors={c} />
      </View>
      {error ? <Text style={{ ...small(c), color: c.statusDanger }}>{failed(error)}</Text> : null}
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
  );
}

/** How the room stands: not set up, changes not applied, files older than the plugin, or running; and the one button for it. */
function RoomStanding(props: {
  applied: State["applied"];
  waiting: string[];
  stale: { detail: string } | null;
  version: string;
  home: string;
  pending: boolean;
  busy: boolean;
  onApply(): void;
  onDiscard(): void;
  error: unknown;
  notes: string[];
  moved: string | null;
  colors: Colors;
}) {
  const {
    applied,
    waiting,
    stale,
    version,
    home,
    pending,
    busy,
    onApply,
    onDiscard,
    error,
    notes,
    moved,
    colors: c,
  } = props;
  return (
    <Card colors={c} style={RAIL}>
      {!applied ? (
        <>
          <Standing tone="idle" title="Not set up yet" sub="Nothing exists before Init." colors={c} />
          <Text style={small(c)}>
            Init creates the room's folder, its seats and profiles in Paseo, and the {ROOM_PROJECT} project.
          </Text>
          <Btn label={pending ? "Working…" : "Init"} kind="primary" disabled={busy} onPress={onApply} colors={c} />
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
              label={pending ? "Working…" : "Apply changes"}
              kind="primary"
              grow
              disabled={busy}
              onPress={onApply}
              colors={c}
            />
            <Btn label="Discard" disabled={busy} onPress={onDiscard} colors={c} />
          </View>
        </>
      ) : stale ? (
        <>
          <Standing
            tone="warn"
            title="The room's files are older"
            sub={`${stale.detail} No new seat opens until they are applied.`}
            colors={c}
          />
          <Btn label={pending ? "Working…" : "Apply"} kind="primary" disabled={busy} onPress={onApply} colors={c} />
        </>
      ) : (
        <Standing tone="ok" title={`Running · ${applied.seats.length} seats`} sub="Everything is applied" colors={c} />
      )}
      {error ? <Text style={{ ...small(c), color: c.statusDanger }}>{failed(error)}</Text> : null}
      {notes.length > 0 ? <Text style={small(c)}>{notes.join(" ")}</Text> : null}
      {moved ? <Text style={small(c)}>{moved}</Text> : null}
      <KeyValue name="Plugin" value={version} colors={c} />
      {applied ? <KeyValue name="Folder" value={short(home)} mono colors={c} /> : null}
    </Card>
  );
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
  const queries = useQueryClient();
  const refetch = () => void queries.invalidateQueries({ queryKey: STATE_KEY });
  const [confirming, setConfirming] = useState(false);

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
  const done = init.data as RpcOutput<typeof setupInit> | undefined;
  const moved = remove.data as RpcOutput<typeof setupRemove> | undefined;

  // a room set up from a terminal: the screen starts from what it runs on
  const applied = data.applied;
  const unsaved = settings.status === "ready" && settings.revision === "missing";
  useEffect(() => {
    if (unsaved && applied && settings.status === "ready")
      void settings.save({ models: applied.models, chime: applied.chime }, settings.revision);
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

  const waiting =
    !applied || !running
      ? []
      : [
          ...ROOM_ROLES.filter((role) => !sameChoices(rolePart(table, role), rolePart(running, role))).map(
            (role) => `${traits(role).label} ${TIER_ROLES.includes(role) ? "models" : "model"}`,
          ),
          ...(values.chime !== applied.chime ? ["Chime"] : []),
        ];
  const stale = data.checks.find((check) => check.id === "version") ?? null;
  const sharing = data.projects.filter((project) => !project.own).length;
  const apply = () => {
    remove.reset();
    init.mutate();
  };

  const room = (
    <RoomStanding
      applied={applied}
      waiting={waiting}
      stale={stale}
      version={data.version}
      home={data.home}
      pending={init.isPending}
      busy={busy}
      onApply={apply}
      onDiscard={() => save({ models: applied!.models, chime: applied!.chime })}
      error={init.error}
      notes={done?.notes ?? []}
      moved={moved ? removedLine(moved) : null}
      colors={c}
    />
  );

  const pad = fit.narrow ? 12 : 20;
  const main = (
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
  );

  const projects =
    applied && running ? (
      <ProjectsCard
        projects={data.projects}
        running={running}
        harnesses={data.harnesses}
        open={open}
        fit={fit}
        colors={c}
      />
    ) : (
      <Card colors={c} style={RAIL}>
        <Text style={small(c)}>Projects appear here once the room is set up: press Init under Settings.</Text>
      </Card>
    );

  const rail = (
    <>
      {applied ? <JevCard colors={c} /> : null}

      <Card colors={c} style={{ ...RAIL, flexDirection: "row", alignItems: "center" }}>
        <Icon name="Bell" size={15} color={c.foreground} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>Chime</Text>
          <Text style={small(c)}>When a seat waits on you</Text>
        </View>
        <Toggle label="Chime" value={values.chime} onChange={(chime) => save({ ...values, chime })} colors={c} />
      </Card>

      <HostCard checks={data.checks.filter((check) => check !== stale)} harnesses={data.harnesses} colors={c} />

      <CleanCard colors={c} />

      {applied ? (
        <RemoveCard
          confirming={confirming}
          setConfirming={setConfirming}
          busy={busy}
          pending={remove.isPending}
          error={remove.error}
          onRemove={() => remove.mutate()}
          colors={c}
        />
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
