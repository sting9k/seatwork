# Seatwork guide

Tiếng Việt: [GUIDE.vi.md](GUIDE.vi.md)

Seatwork is a plugin for Paseo. It runs several coding agents as one team,
which this guide calls the **room**. You give the work to one agent. It
splits the work, passes the parts on, checks what comes back and reports to
you.

## 1. The room

```text
You ── daily work ──▶ Supervisor     one per project
 │                        │
 │                      Lead         one per workstream
 │                      ├─ Peer      one per task
 │                      └─ Lens      one per hard question
 │
 └── management ───▶ HQ              one for all projects
```

| Role | What it does | Writes code |
|---|---|---|
| **Supervisor** | Your counterpart in one project. Writes down what you asked for, splits it into workstreams, starts a Lead for each, reports to you. | No |
| **Lead** | Runs one workstream. Plans, writes a brief for each task, gives it to a Peer, accepts or rejects the result. | Tiny jobs only |
| **Peer** | Does one task, inside the files its brief names. | Yes |
| **Lens** | Answers one hard question for a Lead, or reviews something, without seeing the Lead's own opinion. | No, it only reads |
| **HQ** | Sees every project. Sets a project up and passes your instructions down to its Supervisor. | No |

Two words used below:

- A **seat** is one role on one agent CLI, named `<harness>-<role>`:
  `claude-lead`, `codex-peer`. "Harness" is the code's word for an agent
  CLI: `claude`, `codex`, `pi` or `opencode`. Any of the four can hold any
  role.
- The **Owner** is whoever a seat reports to. For a Supervisor that is you.

Three rules:

- **Daily work goes to the project's Supervisor.**
- **HQ is for management:** the state of all projects, a new project, an
  instruction sent down.
- **Nothing travels up to HQ.** A project's seats do not know HQ exists. HQ
  looks when you ask it to.

## 2. Install

You need:

- Paseo 0.11.2 or later, on macOS or Linux.
- At least one of Claude Code, Codex, Pi (0.99 or later) and OpenCode,
  signed in. The shipped choices use Claude Code and Codex.
- Paseo's tools for agents turned on. That is Paseo's default.

### Step 1: install the plugin

In Paseo open **Settings → Plugins**. Paste this into **Plugin source** and
press **Install plugin**:

```
git:sting9k/seatwork:slp-room/plugin
```

This only downloads the plugin. No folder, no seat and no project exists
yet.

### Step 2: choose what each role runs on

**Seatwork** is now a row at the top of Paseo's sidebar. Press it. The
screen lists the five roles with the shipped choice for each. Change what
you want or leave it as it is. Section 3 explains every part of the screen.

### Step 3: press Init

Init creates:

- the room's folder, `~/.config/slp-room`;
- the seats in Paseo, one provider per seat;
- four profiles: **HQ Supervisor**, **Supervisor**, **Lead**, **Peer**;
- the `hq-seatwork` project, where HQ lives.

Nothing needs a restart.

### Signing in

A seat uses the sign-in of its agent CLI in your terminal. Seatwork stores
no token. For Claude, one sign-in covers every role:

```bash
claude auth login
```

### From a terminal instead

Use this on a machine without the app, or when you work on the room's own
files. It needs `node`, `npm` and `paseo`.

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

It does what Init does and is safe to run again. A first run asks two
questions: what HQ runs on, and whether to turn the watcher on. Flags
answer without the question:

| Flag | Meaning |
|---|---|
| `--hq default` | HQ on the room's own choice |
| `--hq <harness>/<model>` | HQ on that model; add `--hq-thinking <level>` when needed |
| `--watcher off\|shadow\|on` | The watcher's mode (section 10) |
| `--seat <harness>-<role>` | Set up one more seat; may be repeated |
| `--mail-port <port>` | The port of the room's mail server, when the default is taken |
| `--seats-only` | Only the seats; the room's files and the plugin stay as they are |

A room set up this way shows on the Seatwork screen with the choices it runs
on.

## 3. The Seatwork screen

Press **Seatwork** at the top of Paseo's sidebar. The Command Center has it
too, as "Seatwork: set up the room". The row says "Set up" while no room
exists and "Needs you" when a check of this machine fails.

The screen has seven parts, from top to bottom.

### The room

One card with the state of the room and one button: **Init** the first
time, **Apply** afterwards. Your choices below are saved as you make them,
but the room changes only when you press that button. Until then the card
names what is not applied yet.

### Models

The room's table: one line per role. Press a role to choose what it runs
on.

- **HQ, Supervisor, Lead** run on one model each. Choose the agent CLI,
  the model and the thinking level. The model list has a search box. The
  lists show what this machine has; a CLI that is not ready is marked so,
  with the reason.
- **Peer and Lens** are one role with several models. Each model has a
  name (`cheap`, `default`, `high`…) and a line saying what it is for. The
  Lead reads the names and the lines and picks one for each task. You can
  change a model, **Remove** it, or add one more: give it a name
  (lower-case letters, digits, dashes) and a "Use for" line.
- **Back to the shipped table** drops all your choices.

HQ runs on this table, and so does every project that has no table of its
own. The part says how many projects that is.

A seat is set up when a choice needs it. Put the Lead on Codex, press
Apply, and `codex-lead` exists.

### Projects

One line per project of the room: "the room's table", or "own" with the
roles it changes. Press a project to give it models of its own, for that
project only. Section 7 has the details.

### Watcher

- **Mode**: Off, Shadow or On. See section 10.
- **Key**: shown after Init. Optional.

### Sound

**Chime**: a short sound in the open app when a seat waits on you.

### This host

Checks of this machine. Each says **OK**, **Needs you** or **Unknown**.

| Check | Needs you when |
|---|---|
| Paseo's tools for agents | They are off. Seats cannot create or reach each other without them. |
| Room files | The plugin and the room's files are from different versions. Press Apply. |
| Pi | A Pi seat is set up and Pi is missing or older than 0.99. |
| Dictation, Voice mode | One is on. It is on for every agent on this machine; turn it off in Paseo's settings. |

### Remove the room

Press **Remove** twice. It refuses while a seat of the room is still open:
archive those agents first. Then it:

- takes the seats and profiles out of Paseo;
- archives the `hq-seatwork` workspace;
- moves the room's folder to `~/.config/slp-room.removed-<time>`, mail and
  logs included.

The empty `hq-seatwork` project stays in Paseo's list; remove it there if
you want it gone. Removing the plugin alone does not undo Init, so remove
the room first.

## 4. Your first project

Once per project, through HQ.

1. Add the project's folder to Paseo.
2. In the `hq-seatwork` project, open an agent on the **HQ Supervisor**
   profile. HQ starts only there.
3. Write: "set up project X".
4. HQ reads the README and shows you a draft **mission**: what the project
   is for and what done looks like. Say yes or correct it.
5. HQ asks one question: does the project use the room's model table, or a
   table of its own (section 7)?
6. HQ registers the project and opens its Supervisor to write the **law**:
   the project's own rules, such as how work is reviewed and what needs
   your yes first.
7. Write HQ again ("how is it going"). It passes on the questions the
   Supervisor could not answer from the repository, each with a
   recommendation. Answer them, or say "all recommended".
8. Write once more to hear that the project is ready.

HQ looks only when you write, because nothing reports up to it.

Once the first project is registered, Supervisors, Leads, Peers and Lenses
start only inside registered projects.

The project now has a `.slp/` folder:

```text
.slp/
├── room.json        marks the project; holds its own model table, if any
├── mission.md       what the project is for
├── <name>-law.md    the project's own rules
├── status.md        the intent, decisions, overruled objections, progress
└── notebook.md      lessons learned
```

## 5. Daily work

Open an agent on the **Supervisor** profile in the project's workspace and
say what you need. A complete request has three parts:

| Part | Example |
|---|---|
| The result | "Add a `notes search <word>` command" |
| How to accept it | "With tests; `python3 -m unittest` passes" |
| Authority | "Commits are fine, do not push" |

The Supervisor asks for whatever is missing. Then the room works on its
own:

1. The Supervisor splits the work into workstreams and starts a Lead for
   each.
2. A Lead splits its workstream into tasks, writes a brief for each and
   starts a Peer on it.
3. A Peer hands in its result. The Lead inspects it, has a Peer from
   another model family review it, then accepts it or sends it back with
   the repair.
4. When every task is accepted, the Lead runs the acceptance checks once,
   on everything together.
5. The Supervisor reports to you in the same chat.

The Supervisor also sizes the request: tiny, normal or high-risk. High-risk
work (sign-in and permissions, data loss, money, migrations) gets a written
plan before any code and a deeper review at the end.

You do not have to watch. Ask "how is it going" whenever you want.

### Reading the report

The first line is the state:

| First line | Meaning |
|---|---|
| `DONE` | Everything is accepted and nothing is running |
| `STATUS` | Work in progress |
| `DECISION_NEEDED` | You have to decide something |
| `BLOCKED` | Stuck; it cannot continue |

Three parts keep you in control:

- **Evidence (Lead `<workstream>`)**: each check the Lead ran, with its
  last lines. The Supervisor runs no checks; it passes the Lead's on under
  the Lead's name.
- **Decided by the room**: what the agents chose on their own, and whether
  you may revisit it.
- **Overruled**: an objection some agent raised that was not followed,
  with its evidence.

The last rows say what happens next: `DONE: …`, `WAITING ON YOU: …`, or
`WORKING` with one line per Lead.

Agents never decide these for you: cost, product scope, anything that
cannot be undone, and outside actions such as push, merge and deploy. They
ask.

### Knowing when you are needed

- **The chime.** While the Paseo app is open it plays a short sound when
  HQ, a Supervisor or a seat you opened yourself ends a turn with
  `DECISION_NEEDED`, `BLOCKED`, a `WAITING ON YOU:` row, or a failure.
- **The Room row** at the bottom of Paseo's sidebar counts the turns that
  still wait on you. It opens a screen for the whole room: those turns on
  top, then one line for HQ and for each project with a seat open, with a
  dot per seat (green while it works). Press a project to see its seats as
  a tree; press a seat to open it. A turn stays on the list until its seat
  works again or is archived.

### Steering

Tell the Supervisor. If you write to a Peer directly it obeys, and its next
report opens with `DIRECT:` so its Lead knows.

## 6. HQ

| You want | Write HQ |
|---|---|
| The state of every project | "how are the projects doing" |
| A new project | "set up project X" |
| An instruction sent down | "project X: stop Y", "do Z first" |
| What the room did lately | "room stats for the last 14 days" |
| What the watcher found and cost | "watcher stats" |

HQ sends an instruction to the Supervisor as its Owner. The Supervisor does
not know it came from HQ. HQ creates Supervisors and nothing else.

## 7. Models

### The room's table

The plugin ships one table. It is one author's setup, not a recommendation.
The Seatwork screen starts from it.

| Role | Name | Model | The Lead picks it for |
|---|---|---|---|
| HQ, Supervisor, Lead | | `claude-opus-5-5`, high | |
| Peer | `cheap` | `claude-haiku-5-5` | Mechanical, fully specified work: renames, formatting, log triage, doc edits |
| Peer | `default` | `claude-sonnet-5-5` | Writing code, debugging, research |
| Peer | `cross-family` | `gpt-6.1-sol` (Codex) | Reviewing what a Claude Peer wrote; a tie-break; a retry |
| Lens | `default` | `gpt-6.1-sol` (Codex) | One lens: a second opinion on a plan or a bug |
| Lens | `high` | `gpt-6-astra` (Codex) | The one lens when the question is hard; one of two |
| Lens | `extra` | `claude-opus-5-5` | The other of two, from another model family; a third |

`claude-haiku-5-5` needs Claude Code 2.1.293 or later.

How the Lead uses it:

- For a Peer, when unsure, it starts on the lower model. It moves up only
  after a retry with a sharper brief has failed.
- Two lenses are always two different models.
- The Lead's procedures name the Peer models `cheap`, `default` and
  `cross-family`. Keep those three names and change the models under them.
  Add other names freely.

Change the table on the Seatwork screen, then press Apply.

### A project's own table

On the Seatwork screen, press the project under **Projects**. You see the
room's table for Supervisor, Lead, Peer and Lens. Change a role and press
**Save**: that role is now the project's own, and the rest still follows
the room's table. **Same as the room's table** gives one role back;
**Use the room's table** gives them all back.

HQ can also write the table when it registers the project.

The project's own choices are kept in the project, in the `models` object
of `.slp/room.json`. It holds only what differs from the room's table, and
you can edit it by hand:

```json
{
  "models": {
    "seats": { "lead": { "thinking": "medium" } },
    "peer": {
      "tiers": {
        "default": { "thinking": "medium" },
        "cross-family": null
      }
    }
  }
}
```

This makes the Lead and the `default` Peer model think at medium, and takes
`cross-family` out.

- `null` removes an entry. Delete `models` to go back to the room's table.
- A wrong entry stops the project's agents from starting; the error names
  the entry, and the screen marks the project "Needs you".
- A model is written `<harness>-<role>/<model>`. A seat the table names
  that the room does not have is set up when you press Save.

### When a change takes effect

The table decides at the moment a seat is opened. So:

- A change reaches every seat opened after you press Apply (the room's
  table) or Save (a project's). Nothing to reinstall.
- A seat that is already open keeps its model until it is archived.
- You do not have to replace a Supervisor or a Lead that is already open.
  Its prompt still shows the old table, but the plugin holds each seat it
  opens to the new one. A Supervisor, a Lead or HQ asked for on an old
  model starts on the table's model. A Peer or a Lens asked for on a model
  the table no longer lists is refused, with the models it lists now, and
  its Lead picks again.

## 8. How seats talk

Seats send **mail**. Mail never interrupts: it arrives when the recipient
has finished its current turn. A finished result goes up once, when its
sender's own turn has ended, so nobody acts on a seat that is still
working.

- A closed seat still gets mail: mail opens it. That includes every seat
  after a daemon restart.
- Mail to an archived or deleted seat comes back to its sender as
  `UNDELIVERABLE`.
- Some mail wakes nobody and is read with the next mail: an
  acknowledgement, a `DONE` that only repeats itself, and a Lead's
  `STATUS` after its first report (only the newest is kept).

The signals you will see in reports:

| Signal | Sent by | Meaning |
|---|---|---|
| `CANDIDATE` | Peer | A result is ready to check |
| `QUESTION` | Peer | The brief lacks information |
| `REOPEN_REQUEST` | Peer | The brief is wrong somewhere, with evidence the Peer ran |
| `DEPENDENCY_REQUEST` | Peer | It needs something outside its scope |
| `REVIEW` | Peer, Lens | A review or an answer, with a position |
| `ACCEPT` / `REJECT` | Lead | Accepted, or sent back with the repair |
| `REVISED BRIEF` | Lead | The Peer was right; the brief changed |
| `HOLD` / `NOTED` | Lead | The route stands; the objection is on record |

The plugin checks who may mail whom and who may create whom:

| Seat | May create | May mail |
|---|---|---|
| HQ | Supervisor | Supervisor |
| Supervisor | Lead, a research Peer | Lead, Peer |
| Lead | Peer, Lens | Supervisor, Peer, Lens |
| Peer | nobody | Lead, Supervisor |
| Lens | nobody | Lead |

Mail off this table is refused. A seat created off it is archived and its
creator is told; its first prompt may have started by then.

## 9. What a seat is given

A seat gets its role's prompt and skills, the project's mission and law,
the mail tool, and the Paseo tools its role may use. It does not get your
personal agent setup:

- **Claude seats** use your sign-in with your personal settings off: no
  personal skills, plugins, hooks or MCP servers. Claude Code's own extras
  are off too: memory, agent teams, the agent view, workflows, cloud
  routines and claude.ai connectors. Your `~/.claude/CLAUDE.md` is still
  added to the prompt.
- **Codex, Pi and OpenCode seats** each get a home of their own under
  `~/.config/slp-room/runtimes/`. It is built from yours with the sign-in
  kept and plugins, MCP servers, hooks and memory left out.
- Each CLI's own sub-agents are off in a seat. A seat gets help only by
  creating another seat.

These switches are part of the seat's provider in Paseo's config, so they
hold even while the plugin is not running.

Two limits to know:

- **The rules guard against mistakes. They are not a security boundary.**
  Every seat runs under your account, with your files. A Lens is told to
  read only; on Claude its edit tools are off, but a shell command can
  still write.
- **Init changes three switches for every agent on this machine**, not only
  for seats: Paseo's browser tools off, terminal agent hooks off, and
  Paseo's bundled skills kept out of agents. It also turns on the switch
  that gives agents Paseo's tools.

## 10. The watcher

The watcher reads every turn of a Lead and a Peer: the tool calls and the
final message, never the thinking. When a turn shows a sign of going wrong,
the seat above gets one mail from `room` whose subject starts with
`OBSERVATION`. A Peer's goes to its Lead, a Lead's to its Supervisor. The
watcher never stops or changes a seat.

| Mode | What happens |
|---|---|
| Off | Nothing is read |
| Shadow | Turns are read and findings are logged; nobody is mailed |
| On | Findings are also mailed, at most one per turn |

Ten rules read the tool calls and the brief. They cost nothing:

| Rule | It speaks when the seat |
|---|---|
| `irreversible` | ran something that cannot be undone from inside the task: `git reset --hard`, a recursive delete outside its scope, a forced push |
| `outside-project` | wrote outside the project |
| `outside-scope` | changed a file its brief's write scope does not cover |
| `edit-after-reopen` | mailed `REOPEN_REQUEST` and went on changing source |
| `review-without-check` | gave an accepting `REVIEW` while no check ran |
| `same-failure` | ran the same check 4 times with the same failure |
| `repeating` | did the same thing 4 times in a row with the same result |
| `shell-wait` | waited in the shell for a minute (`sleep`, a loop that sleeps) |
| `silent` | has been in its turn with no activity past its role's stall time |
| `incomplete-brief` | is a Peer whose brief lacks `Outcome`, `Write scope`, `Acceptance evidence`, `Reopen when` or the last line `Reply with slp_mail to: owner` |

Four rules need a reader for the seat's final message. Code decides when to
ask, a decision model reads what the message claims, and code compares the
two. The first one mails; the other three only log until you set them to
`raise` in `policy.json`.

| Rule | It asks when |
|---|---|
| `unverified-completion` | the message speaks of checks, and no test stands behind the last change |
| `external-action` | the seat pushed, published or deployed, and its brief has constraints |
| `decided-beyond-brief` | the message reports a decision of the seat's own |
| `reopen-condition` | the brief has a `Reopen when` line and the seat did not ask to reopen |

These four need a key. The decision model is Jev, reached through
OpenRouter. Paste the key into **Key** in the Watcher part of the Seatwork
screen. It is
stored in `~/.config/slp-room/watch/key`, readable by your user only, and
is never shown again. The environment variable `SLP_WATCH_KEY` works too.
Without a key the ten rules above still work and nothing leaves the
machine.

What is sent to the model: the lines of the brief a question reads, the
names of changed files, and the seat's final message with secrets blanked.
Tool output is never sent. Spending is counted from each reply: the plan is
6 USD a month and asking stops at 10. Paseo's Usage view shows it under
"Room watcher".

To switch it on, let it run in Shadow for a while, ask HQ for the watcher
stats, then set its Mode to On and press Apply.

## 11. Upkeep

### Updating

```bash
paseo plugin update slp-seat
```

Then press **Apply** on the Seatwork screen. Until you do, the room refuses
new seats, and the error says so. In a clone: `git pull`, then
`./install.sh`.

### Automatic cleanup

Every 10 minutes the plugin archives seats that have been idle too long and
have no running seat below them. A seat waiting for a permission or an
answer is left alone.

| Role | Archived after being idle for |
|---|---|
| HQ | Never |
| Supervisor | 7 days |
| Lead, Peer | 48 hours |
| Lens | 12 hours |

### Where files live

```text
~/.config/slp-room/
├── hq-seatwork/         HQ's working folder
├── room/                the prompts, skills and model table in use
├── role-skills/         per-role skills for Claude seats
├── runtimes/            the homes of Codex, Pi and OpenCode seats
├── mail/                mail and the mail log
├── watch/               the watcher: its key, scan log and spending
├── setup.json           this machine's choices
├── policy.json          the rules in use
├── seats.json           the seats set up on this machine
├── projects.json        registered projects
├── registry-log.jsonl   every seat created so far
└── gc.log               the cleanup log
```

Claude seats keep their sessions in `~/.claude/projects`, next to yours.

### Logs

```bash
paseo plugin logs slp-seat
```

Mail is logged in `~/.config/slp-room/mail/log.jsonl`, cleanup in
`~/.config/slp-room/gc.log`.

## 12. Errors

| Message | What to do |
|---|---|
| `is a room seat and no room is set up on this daemon` | Open the Seatwork screen and press Init |
| `the room's files were set up by version …` | Press Apply on the Seatwork screen |
| `is not a seat the room has set up` | Choose that agent CLI for the role on the Seatwork screen, then Apply |
| `may only be created in the hq-seatwork project` | Open HQ in the `hq-seatwork` project |
| `it holds only hq seats` | Open this role in its own project |
| `is not a registered SLP project` | Ask HQ to set the project up first |
| `lists for … only …` | The seat was asked for on a model its table does not list. Use one it lists, or change the table on the Seatwork screen |
| `which the room has not enabled` | Open the project on the Seatwork screen and press Save, or fix `.slp/room.json` |
| `its runtime could not be built` | Fix what the message names (often `~/.codex/config.toml`), then create the agent again |
| `still open … archive them first` | Archive the room's agents, then remove the room |
| `is too old: the room needs 0.11.2 or later` | Update Paseo, run `paseo daemon restart`, then install again |
| An agent says it is not signed in | Sign its agent CLI in, in your terminal |
| An agent does not know a new procedure | Open a new agent: a seat gets its prompt when it is created |
