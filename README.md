# seatwork

Seatwork is a plugin for [Paseo](https://paseo.sh). It runs several coding
agents as one team. You talk to one agent. It splits the work, hands the
parts to other agents, checks what comes back and reports to you.

```text
You ── daily work ──▶ Supervisor     one per project
 │                        │
 │                      Lead         one per request
 │                        └─ Peer    one per task
 │
 └── management ───▶ HQ              one for all projects
```

| Role | What it does |
|---|---|
| **Supervisor** | Hands your request to a Lead, watches how the work goes and proposes the smallest correction. Brings you the decisions that are yours. Writes no code. |
| **Lead** | Owns one request: plans, briefs Peers, integrates, accepts or sends work back. Writes no code. |
| **Peer** | Does one task inside the scope its brief names. A spec in its title (`search`, `scout`, `review`, `arch`) makes it answer a question or judge a candidate, a plan or a design instead. |
| **HQ** | Sees every project, adds new ones and runs the room: incidents, spend, the settings it may tune. |

Each role runs on the agent CLI and model you choose: Claude Code, Codex, Pi
or OpenCode.

What the plugin adds to Paseo:

- **Roles.** Each agent gets the room's law, its role's prompt and skills,
  and the project's mission and law.
- **Isolation.** An agent of the room does not load your personal skills,
  plugins, hooks, MCP servers or memory.
- **Mail.** Agents write to each other without interrupting a running turn.
  The plugin checks who may mail whom and who may create whom.
- **Checks in code.** A guard on every command and file write, a check of
  each hand-in's diff, a council that reads turns for the room's law, leases
  on tasks, and a daily spend cap per project.
- **A decision model** (optional). With a key in
  `~/.config/seatwork/jev/`, the council and the room's records ask it.
  Without one nothing leaves your machine and the checks in code still run.

## Install

You need Paseo 0.11.2 or later, and at least one of Claude Code, Codex, Pi
(0.99 or later) and OpenCode, signed in.

1. In Paseo open **Settings → Plugins**. Paste this into **Plugin source**
   and press **Install plugin**. Nothing is created yet.

   ```
   git:sting9k/seatwork:plugin
   ```

2. Press **Seatwork**, now at the top of Paseo's sidebar. Choose what each
   role runs on, or keep the shipped choices.

3. Press **Init**. It creates the room's folder (`~/.config/seatwork`), the
   room's providers and four profiles in Paseo, and the `hq-seatwork`
   project.

That is the whole setup. Nothing is left to run in a terminal.

To change a choice later, change it on the same screen and press **Apply**:
it reaches every project that has no models of its own, for the seats
opened from then on. A project gets models of its own on the same screen,
on its **Projects** tab. **Remove the room** undoes Init: the `hq-seatwork`
project leaves Paseo, and the room's folder is moved aside together with
what the room wrote in each project's `.seatwork/`. That folder is kept for
30 days, then the plugin deletes it.

## First project

1. Add your project's folder to Paseo.
2. In the `hq-seatwork` project, open an agent on the **HQ Supervisor**
   profile and write "set up project X". It asks for the project's mission
   and law, then opens the project's Supervisor.
3. From then on, open an agent on the **Supervisor** profile inside your
   project and say what you need.

## From a terminal

`install.sh` is a second way to do the same setup, in place of the three
steps above. Pick one: a plugin installed from Paseo's settings is set up
with Init, never with the script.

Use the script on a machine without the app, or to work on the room's own
files. It needs `node`, `npm` and `paseo`.

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork && ./install.sh
```

It installs the plugin from the clone's folder, does what Init does, and is
safe to run again. The flags are at the top of the script.

The script refuses to run over a plugin installed from Paseo's settings:
Paseo would keep running its own copy while the room's folder was filled
from the clone, two copies that can differ. To move a machine to a clone,
run `paseo plugin remove seatwork` first, then the script.

## What it changes on your machine

- Paseo's config: the room's providers and profiles, and the switch that
  gives agents Paseo's tools.
- Three switches for every agent on the machine, not only the room's:
  Paseo's browser tools off, terminal agent hooks off, Paseo's bundled
  skills kept out of agents. `install.sh` also turns dictation and voice
  mode off; Init only reports them.
- A mail server on `127.0.0.1` for the agents' mail tool.
- `~/.config/seatwork`: logs, copies of your agent CLI config and each
  agent's temporary files, readable by your user only. Its `policy.json`
  holds the guard's rules, spend caps and the decision model's settings:
  what you change there stays through Apply and plugin updates.
- In each project, `.seatwork/`: the mission, the law, and the stores of
  mail, work and record. The stores keep themselves out of the project's
  git.

The room's rules guard against mistakes. They are not a security boundary:
every agent runs under your account.

## Working on the room

```text
seatwork/
├── install.sh           the terminal setup
├── plugin/              the Paseo plugin (id seatwork)
│   ├── room/            what agents read: the room's law, role prompts, specs, skills, the model table
│   ├── paseo/           what setup writes for a machine: policy.json, seats.json, profiles.json
│   ├── shared/          what the plugin itself defines: workflow.json, tools.json, settings.json
│   ├── server/          mail, tasks, safety, the decision model, knowledge, operations, orchestration
│   ├── client/          the Seatwork screen and the Room screen
│   └── test/
└── AGENTS.md            the rules for changing the plugin
```

- After an edit, run `./install.sh` at the top of the clone. It copies the
  room's files into `~/.config/seatwork` and reloads the plugin. This needs
  a room set up from this clone: see [From a terminal](#from-a-terminal).
- Tests: `npm test` in `plugin/` (Node 22.15 or later).
- Format: `npm run format` in `plugin/` (Prettier, 120 columns; code only).
- Logs: `paseo plugin logs seatwork`.

## Sources

The video "Giáo án của Quỷ Vương", the Quỷ Vương Codex Room toolkit,
and vhlam.com on SLP and coding-agent anti-patterns. The room's skills
adapt openclaw, pstack, piggery, Codex and pi-herdsman; see
[plugin/room/skills/NOTICE.md](plugin/room/skills/NOTICE.md).
