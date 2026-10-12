# Using seatwork

Tiếng Việt: [GUIDE.vi.md](GUIDE.vi.md)

Seatwork splits programming work across several agents on Paseo. You give
the work to one agent; it splits the work, talks to the others and checks
the result.

## 1. Who does what

```text
You ──────────────┬──────────────────────────┐
                  │ managing many projects   │ daily work
                  ▼                          ▼
                 HQ ···· instructions ··▶ Supervisor    one per project
                                            │
                                    ┌───────┴───────┐
                                    ▼               ▼
                                  Lead            Lead   one per workstream
                                    │
                            ┌───────┼───────┐
                            ▼       ▼       ▼
                          Peer    Peer    Lens
```

| Role | Its job |
|---|---|
| **Supervisor** | Takes the work from you, splits it into workstreams, watches and reports. Edits no code. |
| **Lead** | Runs one workstream: plans, hands tasks to Peers, accepts results. Does small jobs itself. |
| **Peer** | Writes the code for one task, inside the files it was given. |
| **Lens** | Reads only. Answers one hard question or reviews, independently of the Lead. |
| **HQ** | Sees across projects and passes your instructions down. Takes no part in the work. |

Three things to remember:

- **Daily work: talk to the project's Supervisor.**
- **HQ is for management only:** the state of several projects, adding a project, sending an instruction down.
- **Projects do not know HQ.** Reports go up only as far as the Supervisor. HQ reads what it needs.

## 2. Install

You need Paseo 0.11.2 or later, Claude Code and Codex (plus Pi 0.99 or
later, or OpenCode, if you put a role on one of them).

### From Paseo

1. Open Settings, Plugins. Paste this into "Plugin source" and press
   **Install plugin**:

   ```
   git:sting9k/seatwork:slp-room/plugin
   ```

   Installing creates nothing: no folder, no seat.

2. On the plugin's "…" menu choose **Seatwork**. The screen has one line for
   each role: HQ, Supervisor, Lead, Peer, Lens. Open a line to pick the agent
   CLI, the model (the list has a search box) and the thinking level, from
   what this machine has. A Peer and a Lens are one role with several
   models, each under a name such as `cheap`, `high` or `extra` with a line on
   what it is for; add or remove them there. The Lead reads the names and
   picks. Below the roles are the watcher's mode (section 11) and the chime.

3. Press **Init**. It creates the room's folder (`~/.config/slp-room`), the
   "seats" in Paseo (a seat is one role running on Claude, Codex, Pi or
   OpenCode), four profiles and the `hq-seatwork` project. Nothing needs a
   restart.

To change a choice later, change it on the same screen and press **Apply**.
A role's seat is set up when you choose a model for it.

**Remove the room** on that screen takes the seats and profiles out of Paseo
and moves the room's folder aside (`~/.config/slp-room.removed-<time>`), mail
and logs included. It waits until every agent of the room is archived.
Removing the plugin alone does not undo Init.

### From a terminal

For a machine without the app, or to work on the room's own files. It needs
`node` and `npm`:

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

It does what Init does, and is safe to run again. A first run asks two
questions: HQ on the room's default seat or on an agent CLI and model you
choose, and whether to install the watcher (a yes installs it in `shadow`
mode). Flags answer without the question: `--hq default`,
`--hq <harness>/<model>` (with `--hq-thinking <level>` when needed),
`--watcher off`, `shadow` or `on`. A room installed this way shows on the
setup screen with the choices it runs on.

### Signing Claude in

Claude seats share the sign-in of the `claude` command in your terminal.
One sign-in covers every role:

```bash
claude auth login
```

Seatwork uses no token. A seat does not carry your personal skills, plugins,
hooks or MCP servers either; it has only its role's skills. Claude Code's
own extras are off in a seat as well: memory, agent teams and their task
tools, the agent view, workflows, cloud routines and claude.ai connectors.
The switches
that keep a seat off your personal setup are part of its provider in Paseo's
config, so they hold even while the plugin is not running.

## 3. Add a project

Once per project, through HQ.

1. Add the project's directory to Paseo.
2. In the `hq-seatwork` project, open an agent with the **HQ Supervisor** profile.
3. Write: "set up project X".
4. HQ reads the README and shows you a draft **mission**: what the project
   is for and what done looks like. Approve it or correct it.
5. HQ asks whether the project uses the shared model table or its own
   (section 7).
6. HQ registers the project and opens its Supervisor to write the **law**,
   the project's own rules: how work is reviewed, what needs your yes first.
7. Write HQ "how is it going". HQ reads the questions the Supervisor could
   not answer and asks you. Answer each, or say "all recommended".
8. Write HQ once more to hear that the project is ready.

A Supervisor never reports up to HQ, so in steps 7 and 8 HQ looks only when
you write.

After the first project, Supervisors, Leads and Peers start only inside
registered projects.

## 4. Daily work

Open an agent with the **Supervisor** profile in the project's workspace and
say what you need. A complete request has three parts:

| Part | Example |
|---|---|
| The result | "Add a `notes search <word>` command" |
| How to accept it | "With tests, `python3 -m unittest` passes" |
| Authority | "Commits are fine, do not push" |

The Supervisor asks for whatever is missing. Then it works on its own:

1. The Supervisor splits the work into workstreams, one Lead each.
2. A Lead splits its workstream into tasks, one Peer each.
3. A Peer hands in its result. The Lead has a reviewer on a different model
   check it, then accepts it or sends it back.
4. The Supervisor reports to you in the same chat.

You do not have to watch. Ask "how is it going" whenever you want.

### Reading the Supervisor's report

The first line gives the state:

| First line | Meaning |
|---|---|
| `DONE` | Everything is finished, nothing is running |
| `STATUS` | Work in progress |
| `DECISION_NEEDED` | You have to decide something |
| `BLOCKED` | Stuck, cannot continue |

Two sections keep you in control:

- **Decided by the room:** what the agents chose on their own, and whether you may revisit it.
- **Overruled:** an objection some agent raised that was not followed, with its evidence.

Checks are run by the Lead, once, on the integrated result. The Supervisor reads the
room and the tree and passes the Lead's lines up under its name, `Evidence (Lead
<workstream>): <check> → <last lines>`, so you can tell what was run from what was read.

What you have to decide is in the `WAITING ON YOU:` row at the end: cost,
product scope, or an outside action such as push and deploy. Agents never
decide these for you.

While the Paseo app is open it plays a short sound when HQ, a Supervisor or
a seat you opened yourself ends a turn with `DECISION_NEEDED`, `BLOCKED`, a
`WAITING ON YOU:` row, or a failure. The Chime switch on the setup screen
turns it off.

The **Room** row at the bottom of Paseo's sidebar says how many of those
turns still wait, and opens a screen for the whole room: those turns on
top, then one line for HQ and for every project that has a seat open, with
a dot per seat (green while it works). Press a project to see its seats as
a tree, and a seat to open it. Projects with no seat open share one line at
the end. A turn stays on the list until its seat works again or is
archived; a daemon restart does not clear it.

### Steering a Peer

Tell the Supervisor. If you write to a Peer directly it still obeys, and its
next report says `DIRECT:` so the Lead knows.

## 5. When you need HQ

| You want | Write HQ |
|---|---|
| The state of every project | "how are the projects doing" |
| A new project | "set up project X" |
| An instruction sent down | "project X: stop Y", "do Z first" |

HQ sends the instruction to the Supervisor as its "Owner". The Supervisor
does not know it came from HQ.

## 6. How agents talk to each other

Agents send mail; they do not interrupt each other. Mail arrives when the
recipient has finished its current turn. A finished result (`CANDIDATE`,
`REVIEW`, `DONE`) goes up once, when its sender's own turn has ended, so
nobody acts on a seat that is still working. A mail is delivered whole,
whatever its length.

A seat does not have to be open to get mail. After the daemon restarts,
every agent is closed until something opens it, and mail opens it. Mail that
was already waiting when the daemon stopped moves once the Paseo app is open
or any agent runs. A seat whose last turn failed takes mail the same way. Mail to an archived or
deleted seat comes back to its sender as `UNDELIVERABLE`.

Some mail wakes nobody and is read with the next mail: an acknowledgement,
a `DONE` that only repeats itself, a Lead's `STATUS` after its first report,
and a `HOLD` that asks nothing of a Peer whose result is being checked. Of a
Lead's `STATUS` reports only the newest is kept; the Supervisor reads it on
its heartbeat.

| Signal | Sent by | Meaning |
|---|---|---|
| `CANDIDATE` | Peer | A result is ready to check |
| `QUESTION` | Peer | The brief lacks information |
| `REOPEN_REQUEST` | Peer | The brief is wrong somewhere, with evidence it ran |
| `DEPENDENCY_REQUEST` | Peer | It needs something outside its scope |
| `ACCEPT` / `REJECT` | Lead | Accepted, or sent back with the repair |
| `REVISED BRIEF` | Lead | The Peer was right; the brief changed |
| `HOLD` / `NOTED` | Lead | The route stands; the Peer's objection is on record |

The plugin checks who may mail whom and who may create whom. A Peer's mail
to another Peer is refused. A seat created against the rules is archived and
its creator is told; its first prompt may have started by then.

These rules guard against mistakes. They are not a security boundary: every
seat runs under your account, with your files. A Lens is told to read only;
on Claude its edit tools are off, but a shell command can still write.

## 7. A project's own configuration

Every project has a `.slp/` directory:

```text
.slp/
├── room.json        marks the project, and holds its own model table if any
├── mission.md       what the project is for
├── <name>-law.md    the project's own rules
├── status.md        progress, decisions, overruled objections
└── notebook.md      lessons learned
```

### Its own model table

HQ writes it for you the first time. After that, edit the `models` object in
`.slp/room.json` by hand. Write only what differs from the shared table. Any
role can run on any harness (`<harness>-<role>/<model>`): HQ sets up a seat
the room does not have yet when it writes the table. After a hand edit that
names a new seat, ask HQ to write the table again (from a clone:
`./install.sh --seat <harness>-<role>`):

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

This example makes the Lead and the `default` Peer tier think at medium, and
removes the `cross-family` tier.

- `null` removes an entry. Delete `models` to go back to the shared table.
- A change applies to agents created afterwards; nothing to reinstall.
- An agent on a model the table does not list is refused.
- A wrong entry stops the agent from starting, and the error names it.

## 8. Shared configuration

| Where | Decides | Takes effect |
|---|---|---|
| The setup screen (Settings, Plugins, Seatwork) | The agent CLI, model and thinking level of each role; the watcher's mode; the chime | **Apply** |
| `~/.config/slp-room/setup.json` | What the screen applied, the seats HQ added for a project, and `mailPort` when the policy's port is taken | **Apply**, or `./install.sh` |
| `slp-room/plugin/paseo/seats.json` | The seats every install gets | see below |
| `slp-room/plugin/room/models.json` | The room's own model table: where the screen starts | see below |
| `slp-room/plugin/paseo/policy.json` | Who mails whom, who creates whom, waiting times, the watcher's rules | see below |
| `slp-room/plugin/room/roles/`, `skills/` | Each role's prompt and procedures | see below |

The last four are files of the plugin. In a clone, edit them and run
`./install.sh`. A plugin installed from Paseo gets new ones with
`paseo plugin update slp-seat`; press **Apply** afterwards.

A Peer is one role with several models, each under a name in `peer.tiers`.
The shipped table has three; the setup screen adds one more (`expensive`,
say) or takes one out. The Lead picks by the task:

| Tier | Used for |
|---|---|
| `cheap` | Mechanical, fully specified work: renames, formatting, log triage, doc edits. Claude Haiku 5.5, which needs Claude Code 2.1.293 or later |
| `default` | Writing code, debugging, research |
| `cross-family` | Reviewing code another model family wrote |

A Lens is one role too, with its models listed the same way under
`lens.tiers` (the shipped ones: `default`, `high` for a hard question,
`extra` on another model family). The Lead picks by the question; when it
opens two lenses they are always two different models.

## 9. Where files live

```text
~/.config/slp-room/
├── hq-seatwork/         HQ's working directory
├── room/                the prompts, skills and model table in use
├── role-skills/         per-role skills for Claude seats
├── runtimes/            the separate environment of Codex, Pi and OpenCode seats
├── mail/                mail and the mail log
├── setup.json           this machine's choices: HQ's seat, seats added, the watcher
├── projects.json        registered projects
├── registry-log.jsonl   agents created so far
├── watch/               the watcher: its key, scan log and monthly spending
└── gc.log               the cleanup log
```

Claude seats keep their sessions in `~/.claude/projects`, next to yours.

## 10. Automatic cleanup

Every 10 minutes the plugin archives agents that have been idle too long and
have no running agent below them. An agent waiting for a permission or an
answer is left alone.

| Role | Archived after being idle for |
|---|---|
| HQ | Never |
| Supervisor | 7 days |
| Lead, Peer | 48 hours |
| Lens | 12 hours |

## 11. The watcher

The plugin reads every turn of a Lead and a Peer: the tool calls and the
final message, never the thinking. When a turn shows a sign of going wrong,
the seat above gets one mail from `room` whose subject starts with
`OBSERVATION` (a Peer's goes to its Lead, a Lead's to its Supervisor). The
watcher never stops or changes a seat, and it keeps no memory between turns.

Its mode is the Watcher choice on the setup screen (from a terminal the
installer asks once), kept in `~/.config/slp-room/setup.json`:

| Mode (Watcher on the screen, or `./install.sh --watcher <mode>`) | What happens |
|---|---|
| `off` (unless you said yes) | Nothing is read |
| `shadow` (a yes to the installer's question) | Turns are read and findings are logged; nobody is mailed |
| `on` | Findings are also mailed, at most one per turn |

Ten rules stand on what the tool calls and the brief show, at no cost:

| Rule | Told when the seat |
|---|---|
| `irreversible` | ran something that cannot be undone from inside the task (`git reset --hard`, a recursive delete outside its scope, a forced push) |
| `outside-project` | wrote outside the project |
| `outside-scope` | changed a file its brief's write scope does not cover |
| `edit-after-reopen` | mailed `REOPEN_REQUEST` and went on changing source |
| `review-without-check` | gave a `REVIEW` that accepts while no check ran |
| `same-failure` | ran the same check 4 times with the same failure |
| `repeating` | did the same thing 4 times in a row with the same result |
| `shell-wait` | waited in the shell for a minute (`sleep`, a loop that sleeps) |
| `silent` | has been in its turn with no activity past the role's stall time |
| `incomplete-brief` | is a Peer whose Lead gave it a brief that lacks `Outcome`, `Write scope`, `Acceptance evidence`, `Reopen when` or the last line `Reply with slp_mail to: owner` (a brief in free prose lacks them all). This covers the brief the Peer was created with and a brief mailed to it later (a mail whose subject says `BRIEF`); told once per brief, when the turn it opens starts |

Four rules need a reader for the seat's message. Code decides when to ask
(for example: the message closes the work, source changed, and no test
passed after the last change), a decision model reads what the message
claims, and code compares the two. The first is installed as `raise`; the
other three as `log`: they write their score to the log and mail nobody
until you set them to `raise` in `policy.json`.

| Rule | Asked when |
|---|---|
| `unverified-completion` | the message speaks of checks, and no test stands behind the last change |
| `external-action` | the seat pushed, published or deployed, and its brief has constraints |
| `decided-beyond-brief` | the message reports a decision of the seat's own |
| `reopen-condition` | the brief has a `Reopen when` line and the seat did not ask to reopen |

The decision model is Jev, reached through OpenRouter. Paste the key into
Watcher key on the setup screen; it is stored in
`~/.config/slp-room/watch/key` (mode 600) and never shown again. The
environment variable `SLP_WATCH_KEY` works too. Without a key the ten fact rules still work. What is sent:
the lines of the brief a question reads, the names of changed files, and the
seat's final message with secrets blanked (whole up to 12,000 characters; a
longer one is cut to the lines a question reads, and a question whose lines
do not fit is skipped and named in the log). Tool output is never sent.
Spending is counted from each reply; `watcher.budget` plans 6 USD a month
and stops asking at 10. The month's spending is in Paseo's Usage view, under
"Room watcher".

To switch it on: let it run in `shadow` for a while, ask HQ for the watcher
stats (it calls `slp_watch_stats`: spending, how many turns were watched and
how often they were read, and per rule how often it spoke and how many of
those turns the seat above sent back), then set Watcher to On on the setup
screen and press Apply (or run `./install.sh --watcher on`).
For `unverified-completion` a returned turn counts only when the seat above
ran a test itself and saw it fail: work also comes back for other reasons.

To try rules on recorded turns without touching a room, run in
`slp-room/plugin`:

```bash
npm run watch:replay -- --ask ../evals/results/<label>
```

## 12. Common errors

| Message | What to do |
|---|---|
| `may only be created in the hq-seatwork project` | Open HQ in the `hq-seatwork` project |
| `holds only hq seats` | Open this role in its own project |
| `is not a registered SLP project` | Ask HQ to set the project up first |
| `lists for … only …` | Use a model from the table, or edit `.slp/room.json` |
| `which the room has not enabled` | Fix `.slp/room.json`, or ask HQ to write the project's table again: it sets the seat up |
| `no room is set up on this daemon` | Open Settings, Plugins, Seatwork and press Init |
| `room seat is still open … archive them first` | Archive the room's agents, then remove the room |
| `its runtime could not be built` | Fix what the message names (often `~/.codex/config.toml`), then create the agent again |
| `is too old: the room needs 0.11.2 or later` | Update Paseo, run `paseo daemon restart`, then install again |
| An agent says it is not signed in | Run `claude auth login` |
| An agent does not know a new procedure | Open a new agent |

The plugin's log:

```bash
paseo plugin logs slp-seat
```
