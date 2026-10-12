import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsInput, SettingsSelect, SettingsSwitch, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { changedRoles, merge, sameChoices, SEAT_ROLES, TIER_ROLES, type Table } from "../shared/model-choices";
import { roomSettings, setupInit, setupProject, setupRemove, setupState, setupWatcherKey, type RoomChoices } from "../shared/setup";
import { Button, Card, Line, Note, Part, Pill, type Colors, type Inside } from "./kit";
import { ROLE_LABEL, Roles } from "./models";

type State = RpcOutput<typeof setupState>;
type Project = State["projects"][number];
type Choices = Record<string, unknown>;

const STATE_KEY = ["slp-seat", "setup.state"];
const ROOM_ROLES = [...SEAT_ROLES, ...TIER_ROLES] as const;
/** A project's table has no HQ: HQ sits above the projects. */
const PROJECT_ROLES = ["supervisor", "lead", "peer", "lens"] as const;
const WATCHER_DOES = { off: "Nothing is read.", shadow: "Turns are read and findings are logged. Nobody is mailed.", on: "Findings are also mailed to the seat above." } as const;

/** What went wrong, in the room's words: Paseo wraps a refused request in its own prefix and request details. */
const failed = (error: unknown) => (error ? (error instanceof Error ? error.message : String(error)).replace(/^Request failed: /, "").replace(/ requestType=\S+( code=\S+)?$/, "") : null);

/** The sidebar row: it opens the screen, and says when the room is not set up or a check needs the Owner. */
export function SetupItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const read = useRpc(setupState);
  const state = useQuery({ queryKey: STATE_KEY, queryFn: () => read({}) });
  const data = state.data as State | undefined;
  const word = !data ? null : !data.applied ? "Set up" : data.checks.some((check) => check.ok === false) ? "Needs you" : null;
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

/** The screen's page: one column, no wider than a settings page reads well. */
function Page(props: { colors: Colors; compact: boolean; children: Inside }) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: props.colors.surface0 }} contentContainerStyle={{ padding: props.compact ? 16 : 28, alignItems: "center" }}>
      <View style={{ width: "100%", maxWidth: 760, gap: 28 }}>{props.children}</View>
    </ScrollView>
  );
}

/**
 * Seatwork's screen: the room's setup, or one project's own models when the screen was opened
 * for a project.
 */
export function SetupScreen({ theme, layout, params, open }: PluginScreenProps & { open(project?: string): void }) {
  const c = theme.colors;
  const readState = useRpc(setupState);
  const state = useQuery({ queryKey: STATE_KEY, queryFn: () => readState({}) });
  const data = state.data as State | undefined;
  if (!data) {
    return (
      <Page colors={c} compact={layout.compact}>
        <Text style={{ color: state.error ? c.statusDanger : c.foregroundMuted }}>{failed(state.error) ?? "Reading this host…"}</Text>
      </Page>
    );
  }
  return (
    <Page colors={c} compact={layout.compact}>
      {params.project ? (
        <View key={params.project} style={{ gap: 28 }}>
          <ProjectModels data={data} name={params.project} open={open} colors={c} />
        </View>
      ) : (
        <RoomSetup data={data} open={open} colors={c} compact={layout.compact} />
      )}
    </Page>
  );
}

/** A role's place in a table: one seat, or a Peer's or a Lens's models. */
const rolePart = (table: Table, role: (typeof ROOM_ROLES)[number]) => (role === "peer" || role === "lens" ? table[role] : table.seats[role]);

/** The room's table with what was last applied laid over it: what the room runs on now. */
const runningTable = (data: State): Table => merge(data.table, data.applied?.models ?? {}) as Table;

/**
 * The room's setup: its state and the one button that changes it, what each role runs on, the
 * projects, the watcher, the sound, this host. Choices are kept as they are made; the room
 * changes on Init or Apply.
 */
function RoomSetup({ data, open, colors: c, compact }: { data: State; open(project?: string): void; colors: Colors; compact: boolean }) {
  const settings = useSettings(roomSettings);
  const runInit = useRpc(setupInit);
  const runRemove = useRpc(setupRemove);
  const saveKey = useRpc(setupWatcherKey);
  const queries = useQueryClient();
  const refetch = () => void queries.invalidateQueries({ queryKey: STATE_KEY });
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

  // a room set up from a terminal: the screen starts from what it runs on, not from the room's defaults
  const applied = data.applied;
  const unsaved = settings.status === "ready" && settings.revision === "missing";
  useEffect(() => {
    if (unsaved && applied && settings.status === "ready") void settings.save({ models: applied.models, watcher: applied.watcher, chime: applied.chime }, settings.revision);
  }, [unsaved, applied !== null]);

  if (!values) {
    const problem = settings.status === "error" || settings.status === "invalid" ? settings.error : null;
    return <Text style={{ color: problem ? c.statusDanger : c.foregroundMuted }}>{problem ?? "Reading this host…"}</Text>;
  }

  const revision = settings.status === "ready" ? settings.revision : "";
  const save = (next: RoomChoices) => void settings.save(next, revision);
  const shipped = data.table as unknown as Table;
  const table = merge(shipped, values.models) as Table;
  const busy = init.isPending || remove.isPending;

  // what Apply would change, by name
  const running = runningTable(data);
  const pending = !applied
    ? []
    : [
        ...ROOM_ROLES.filter((role) => !sameChoices(rolePart(table, role), rolePart(running, role))).map((role) => ROLE_LABEL[role]),
        ...(values.watcher !== applied.watcher ? ["Watcher"] : []),
        ...(values.chime !== applied.chime ? ["Chime"] : []),
        ...(applied.version !== data.version ? [`room files from ${applied.version || "an earlier version"}`] : []),
      ];
  const dirty = pending.length > 0 || (applied !== null && !sameChoices(values.models, applied.models));
  const sharing = data.projects.filter((project) => !project.own).length;

  return (
    <>
      <Card colors={c} border={dirty ? c.statusWarning : undefined}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 14, padding: 16 }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: applied ? c.statusSuccess : c.foregroundMuted }} />
          <View style={{ flex: 1, minWidth: 220, gap: 3 }}>
            <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>{applied ? `The room is set up · ${applied.seats.length} seats` : "The room is not set up yet"}</Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
              {applied ? `${data.home} · plugin ${data.version}` : "Init creates the room's folder, its seats and profiles in Paseo, and the hq-seatwork project. Nothing exists before it."}
            </Text>
          </View>
          <Button
            label={init.isPending ? "Working…" : applied ? "Apply" : "Init"}
            kind={!applied || dirty ? "primary" : "plain"}
            disabled={busy}
            onPress={() => {
              remove.reset();
              init.mutate();
            }}
            colors={c}
          />
        </View>
        {dirty ? <Note text={`Not applied yet: ${pending.join(", ") || "your choices"}. Press Apply.`} color={c.statusWarning} colors={c} /> : null}
        {init.error ? <Note text={failed(init.error) ?? ""} color={c.statusDanger} colors={c} /> : null}
        {done ? <Note text={[`Done. Seats: ${done.seats.join(", ")}.`, done.removed.length ? `Removed: ${done.removed.join(", ")}.` : "", ...done.notes].filter(Boolean).join(" ")} colors={c} /> : null}
        {moved ? <Note text={`The room was removed. Its folder is kept at ${moved.movedTo}`} colors={c} /> : null}
      </Card>

      <Part
        title="Models"
        note={
          applied
            ? `The room's table: what each role runs on. HQ uses it, and so does every project without a table of its own${data.projects.length ? ` (${sharing} of ${data.projects.length} projects now)` : ""}. A change reaches seats opened after you press Apply; seats already open keep their model.`
            : "What each role runs on. Press a role to change it; you can change it again later."
        }
        colors={c}
      >
        <Roles roles={ROOM_ROLES} base={shipped} choices={values.models} harnesses={data.harnesses} onChange={(models) => save({ ...values, models: models as RoomChoices["models"] })} where="the room's table" colors={c} />
        {Object.keys(values.models).length ? (
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Button label="Back to the shipped table" onPress={() => save({ ...values, models: {} })} colors={c} />
          </View>
        ) : null}
      </Part>

      {applied ? (
        <Part title="Projects" note="A project runs on the room's table. Press one to give it models of its own: for that project only, kept in the project." colors={c}>
          <Card colors={c}>
            {data.projects.map((project) => (
              <View key={project.name}>
                <Line name={project.name} nameWidth={compact ? 110 : 180} value={projectLine(project)} right={project.error ? <Pill text="Needs you" color={c.statusWarning} colors={c} /> : project.own ? <Pill text="own" color={c.accent} colors={c} /> : undefined} onPress={() => open(project.name)} colors={c} />
              </View>
            ))}
            {data.projects.length === 0 ? <Note text="No project is in the room yet. Open HQ in the hq-seatwork project and write: set up project X." colors={c} /> : null}
          </Card>
        </Part>
      ) : null}

      <Part title="Watcher" note="Reads the turns of Leads and Peers and tells the seat above when one goes wrong. It never stops a seat." colors={c}>
        <Card colors={c}>
          <SettingsSelect
            label="Mode"
            hint={WATCHER_DOES[values.watcher]}
            value={values.watcher}
            options={[{ label: "Off", value: "off" }, { label: "Shadow", value: "shadow" }, { label: "On", value: "on" }]}
            onValueChange={(watcher: RoomChoices["watcher"]) => save({ ...values, watcher })}
          />
          {applied ? (
            <View>
              <SettingsInput
                ref={keyInput}
                label="Key"
                hint={data.watcherKey ? "A key is stored. Four rules ask a model with it; type a new one to replace it." : "Optional. Without a key the four rules that ask a model only log, and nothing leaves this machine."}
                placeholder="Paste a key"
                secureTextEntry
                onChangeText={setKey}
                error={failed(storeKey.error)}
              />
              {key || data.watcherKey ? (
                <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingBottom: 12 }}>
                  <Button label={storeKey.isPending ? "Saving…" : key ? "Store this key" : "Remove the stored key"} disabled={storeKey.isPending} onPress={() => storeKey.mutate()} colors={c} />
                </View>
              ) : null}
            </View>
          ) : null}
        </Card>
      </Part>

      <Part title="Sound" colors={c}>
        <Card colors={c}>
          <SettingsSwitch label="Chime" hint="A short sound in the open app when a seat waits on you." value={values.chime} onValueChange={(chime: boolean) => save({ ...values, chime })} />
        </Card>
      </Part>

      <Part title="This host" note="What the room needs from this machine." colors={c}>
        <Card colors={c}>
          {data.checks.map((check) => (
            <View key={check.id}>
            <Line name={check.label} note={check.detail} right={<Pill text={check.ok ? "OK" : check.ok === false ? "Needs you" : "Unknown"} color={check.ok ? c.statusSuccess : check.ok === false ? c.statusWarning : undefined} colors={c} />} colors={c} />
            </View>
          ))}
        </Card>
      </Part>

      {applied ? (
        <Part title="Remove the room" colors={c}>
          <Card colors={c}>
            <Line
              name="Take the room off this machine"
              note="Its seats and profiles leave Paseo, the hq-seatwork workspace is archived, and the room's folder is moved aside with its mail and logs. Archive the room's agents first. The empty hq-seatwork project stays in Paseo's list."
              right={
                <Button
                  label={remove.isPending ? "Removing…" : confirming ? "Press again to remove" : "Remove"}
                  kind="danger"
                  disabled={busy}
                  onPress={() => {
                    if (confirming) remove.mutate();
                    setConfirming(!confirming);
                  }}
                  colors={c}
                />
              }
              colors={c}
            />
            {remove.error ? <Note text={failed(remove.error) ?? ""} color={c.statusDanger} colors={c} /> : null}
          </Card>
        </Part>
      ) : null}
      {settings.saveError ? <Text style={{ color: c.statusDanger }}>{settings.saveError}</Text> : null}
    </>
  );
}

/** A project in one line: whose table it runs on. */
function projectLine(project: Project): string {
  if (project.error) return "its own table cannot be used as written";
  return project.own ? `own: ${changedRoles(project.models).map((role) => ROLE_LABEL[role]).join(", ")}` : "the room's table";
}

/**
 * One project's own models: the room's table with this project's differences. They are written
 * into the project (`.slp/room.json`) on Save and reach the seats opened in it from then on.
 */
function ProjectModels({ data, name, open, colors: c }: { data: State; name: string; open(project?: string): void; colors: Colors }) {
  const project = data.projects.find((entry) => entry.name === name);
  const write = useRpc(setupProject);
  const queries = useQueryClient();
  const [draft, setDraft] = useState((project?.models ?? {}) as Choices);
  const save = useMutation({
    mutationFn: (models: Choices) => write({ name, models: models as never }),
    onSuccess: () => void queries.invalidateQueries({ queryKey: STATE_KEY }),
  });
  const back = (
    <Pressable accessibilityRole="button" accessibilityLabel="Back to Seatwork" onPress={() => open()} style={{ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
      <Icon name="ArrowLeft" size={14} color={c.foregroundMuted} />
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Seatwork</Text>
    </Pressable>
  );
  if (!project || !data.applied) {
    return (
      <>
        {back}
        <Text style={{ color: c.foregroundMuted }}>{name} is not a project of the room. Open HQ in the hq-seatwork project and write: set up project {name}.</Text>
      </>
    );
  }
  const dirty = !sameChoices(draft, project.models);
  const roles = changedRoles(draft).map((role) => ROLE_LABEL[role]);
  const saved = save.data as RpcOutput<typeof setupProject> | undefined;
  return (
    <>
      {back}
      <Part title={`Models for ${name}`} note={`This project runs on the room's table, with what you change here. Its own choices are kept in the project: ${project.root}/.slp/room.json`} colors={c}>
        <Roles roles={PROJECT_ROLES} base={runningTable(data)} choices={draft} harnesses={data.harnesses} onChange={setDraft} where={name} own colors={c} />
      </Part>
      <Card colors={c} border={dirty ? c.statusWarning : undefined}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, padding: 16 }}>
          <Text style={{ flex: 1, minWidth: 200, color: c.foreground, fontSize: 14 }}>{roles.length ? `Its own: ${roles.join(", ")}. The rest follows the room's table.` : "Every role follows the room's table."}</Text>
          {roles.length ? <Button label="Use the room's table" onPress={() => setDraft({})} colors={c} /> : null}
          {dirty ? <Button label="Discard" onPress={() => setDraft(project.models as Choices)} colors={c} /> : null}
          {/* a table edited by hand may name a seat the room lacks: saving it as it is sets that seat up */}
          <Button label={save.isPending ? "Saving…" : "Save"} kind={dirty || project.error ? "primary" : "plain"} disabled={(!dirty && !project.error) || save.isPending} onPress={() => save.mutate(draft)} colors={c} />
        </View>
        {dirty ? <Note text="Not saved yet." color={c.statusWarning} colors={c} /> : null}
        {save.error ? <Note text={failed(save.error) ?? ""} color={c.statusDanger} colors={c} /> : null}
        {!dirty && project.error ? <Note text={project.error} color={c.statusWarning} colors={c} /> : null}
        {!dirty && saved ? <Note text={`Saved.${saved.seats.length ? ` Seats set up for it: ${saved.seats.join(", ")}.` : ""}`} colors={c} /> : null}
        <Note text="A change reaches the seats opened in this project from now on. Seats already open keep their model." colors={c} />
      </Card>
    </>
  );
}
