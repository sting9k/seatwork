# Seatwork guide

Tiếng Việt: [GUIDE.vi.md](GUIDE.vi.md)

Seatwork is a Paseo plugin that runs several coding agents as one team,
the **room**. You give the work to one agent. It splits the work, hands
the parts out, checks what comes back and reports to you.

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
| **Supervisor** | Takes your request, splits it into workstreams, starts a Lead for each, reports to you. | No |
| **Lead** | Runs one workstream: plans, briefs a Peer per task, accepts or rejects the result. | Tiny jobs only |
| **Peer** | Does one task, inside the files its brief names. | Yes |
| **Lens** | Answers one hard question or reviews, without seeing the Lead's opinion. | No |
| **HQ** | Sets projects up and passes your instructions down. | No |

- A **seat** is one role on one agent CLI, named `<harness>-<role>`:
  `claude-lead`, `codex-peer`. Each of the four CLIs (`claude`, `codex`,
  `pi`, `opencode`) can hold any role.
- A seat's **Owner** is whoever it reports to. A Supervisor's Owner is you.

Three rules:

- Daily work goes to the project's Supervisor.
- HQ is for management: the state of all projects, a new project, an
  instruction sent down.
- Nothing travels up to HQ. It looks when you ask.

## 2. Set up

You need:

- Paseo 0.11.2 or later, on macOS or Linux, with its tools for agents on
  (the default).
- At least one of Claude Code, Codex, Pi (0.99 or later) and OpenCode,
  signed in. The shipped choices use Claude Code and Codex.

1. In Paseo open **Settings → Plugins**, paste this into **Plugin source**
   and press **Install plugin**:

   ```
   git:sting9k/seatwork:plugin
   ```

2. Press **Seatwork** at the top of the sidebar. Change what each role runs
   on, or leave the shipped choices (section 6).
3. Press **Init**.

Init creates the room's folder `~/.config/seatwork`, the seats and four
profiles in Paseo (**HQ Supervisor**, **Supervisor**, **Lead**, **Peer**),
and the `hq-seatwork` project, where HQ lives. Nothing needs a restart.

A seat uses the sign-in of its agent CLI in your terminal. Seatwork stores
no token. For Claude, `claude auth login` covers every role.

### From a terminal instead

`install.sh` replaces the three steps above. Use it on a machine without
the app, or when you work on the room's own files. It needs `node`, `npm`
and `paseo`.

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork && ./install.sh
```

A first run asks what HQ runs on and whether to turn the watcher on. Flags
answer in advance:

| Flag | Meaning |
|---|---|
| `--hq default` | HQ on the room's own choice |
| `--hq <harness>/<model>` | HQ on that model; add `--hq-thinking <level>` when needed |
| `--watcher off\|shadow\|on` | The watcher's mode (section 8) |
| `--seat <harness>-<role>` | One more seat; may be repeated |
| `--mail-port <port>` | The port of the room's mail server, when the default is taken |

Three things to know:

- The script and Init are alternatives. Over a plugin installed from
  Settings the script refuses and changes nothing. Run
  `paseo plugin remove seatwork` first; the room's folder, mail and choices
  are kept.
- The script also turns Paseo's Dictation and Voice mode off and its tools
  for agents on. If it ends with Paseo's note that changes require a
  restart, run `paseo daemon restart`.
- A room set up this way shows on the Seatwork screen and can be changed
  there.

## 3. First project

Once per project, through HQ:

1. Add the project's folder to Paseo.
2. In the `hq-seatwork` project open an agent on the **HQ Supervisor**
   profile and write "set up project X".
3. HQ drafts the **mission**: what the project is for and what done looks
   like. Confirm or correct it.
4. HQ asks whether the project uses the room's models or its own
   (section 6). It then registers the project and opens its Supervisor to
   write the **law**: the project's own rules.
5. Write HQ again ("how is it going"). It passes on what the Supervisor
   could not answer from the repository, each with a recommendation. Answer,
   or say "all recommended". Write once more to hear that the project is
   ready.

HQ looks only when you write. Once a project is registered, Supervisors,
Leads, Peers and Lenses start only inside registered projects.

The room keeps its files for a project in `.seatwork/`. It writes nothing
else there besides the work you ask for.

```text
.seatwork/
├── room.json        marks the project; holds its own model table, if any
├── mission.md       what the project is for
├── <name>-law.md    the project's own rules
├── status.md        the intent, decisions, overruled objections, progress
├── notebook.md      lessons learned
├── plans/           a Lead's plan for risky or long work
└── reviews/         the report of a Lead's deep review
```

## 4. Daily work

Open an agent on the **Supervisor** profile in the project and say what you
need. A complete request has three parts; the Supervisor asks for what is
missing.

| Part | Example |
|---|---|
| The result | "Add a `notes search <word>` command" |
| How to accept it | "With tests; `python3 -m unittest` passes" |
| Authority | "Commits are fine, do not push" |

Then the room works on its own:

1. The Supervisor splits the work into workstreams, with a Lead for each.
2. A Lead writes a brief per task and starts a Peer on it.
3. The Lead inspects each result, has a Peer from another model family
   review it, then accepts it or sends it back.
4. When every task is accepted, the Lead runs the acceptance checks on
   everything together, and the Supervisor reports to you.

High-risk work (sign-in and permissions, data loss, money, migrations) gets
a written plan before any code and a deeper review at the end.

Ask "how is it going" whenever you want. To steer, tell the Supervisor. A
Peer you write to directly obeys, and opens its next report with `DIRECT:`
so its Lead knows.

### The report

The first line is the state:

| First line | Meaning |
|---|---|
| `DONE` | Everything is accepted and nothing is running |
| `STATUS` | Work in progress |
| `DECISION_NEEDED` | You have to decide something |
| `BLOCKED` | Stuck; it cannot continue |

Below it:

- **Evidence (Lead `<workstream>`)**: the checks the Lead ran, with their
  last lines. The Supervisor runs none itself.
- **Decided by the room**: what the agents chose on their own, and whether
  you may revisit it.
- **Overruled**: an objection that was not followed, with its evidence.
- The last rows say what happens next: `DONE: …`, `WAITING ON YOU: …`, or
  `WORKING` with one line per Lead.

Agents never decide these for you; they ask: cost, product scope, anything
that cannot be undone, and outside actions such as push, merge and deploy.

### When you are needed

- **The chime.** While the app is open, a short sound plays when HQ, a
  Supervisor or a seat you opened ends a turn with `DECISION_NEEDED`,
  `BLOCKED`, a `WAITING ON YOU:` row, or a failure.
- **The Room row**, at the bottom of the sidebar, counts the turns that
  wait on you. It opens a screen of the whole room: those turns, then HQ
  and each project with its seats. Press a seat to open it.

## 5. HQ

| You want | Write HQ |
|---|---|
| The state of every project | "how are the projects doing" |
| A new project | "set up project X" |
| An instruction sent down | "project X: stop Y", "do Z first" |
| What the room did lately | "room stats for the last 7 days" |
| What the watcher found and cost | "watcher stats" |

HQ creates Supervisors and nothing else. A Supervisor does not know that an
instruction came from HQ.

## 6. Models

### The shipped table

It is one author's setup, not a recommendation.

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

- For a Peer the Lead starts on the lower model when unsure. It moves up
  only after a retry with a sharper brief has failed.
- Two lenses are always two different models.
- The Lead's procedures name the Peer models `cheap`, `default` and
  `cross-family`. Keep those names and change the models under them. Add
  other names freely.

### Change the room's table

On the Seatwork screen, **Settings** tab: press a role, choose the agent
CLI, the model and the thinking level, then press **Apply changes**.

- HQ, Supervisor and Lead run on one model each.
- Peer and Lens are one role with several named models. Each has a "Use
  for" line the Lead reads. Change one, remove it, or press **Add a model**.
- A seat is set up when a choice needs it: put the Lead on Codex, apply,
  and `codex-lead` exists.
- **Back to the shipped table** drops your choices.

HQ runs on this table, and so does every project without models of its own.

### A project's own table

**Projects** tab: press the project, change a role, press **Save**. That
role is now the project's own; the rest still follows the room. **Same as
the room's table** gives one role back. HQ can also write the table when it
registers the project.

The choices live in the project, in the `models` object of
`.seatwork/room.json`. It holds only what differs from the room's table,
and you can edit it by hand:

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
- A model is written `<harness>-<role>/<model>`. A seat the table names
  that the room lacks is set up when you press Save.
- A wrong entry stops the project's agents from starting. The error names
  the entry, and the screen marks the project "Needs you".

### When a change takes effect

- It reaches every seat opened after you apply or save. A seat already open
  keeps its model until it is archived.
- You do not have to replace an open Supervisor or Lead. The plugin holds
  each seat they open to the new table.
- A Peer or a Lens asked for on a model the table no longer lists is
  refused, and its Lead picks again.

## 7. The Seatwork screen

Press **Seatwork** at the top of the sidebar. The row says "Set up" while
no room exists and "Needs you" when a check of this machine fails.

| Part | What it is for |
|---|---|
| The room's state | Whether the room runs. **Init** before a room exists; **Apply changes** and **Discard** when choices wait. |
| Models | What each role runs on (section 6) |
| **Projects** tab | One line per project: **Room table**, or **Own**. Press one for its own models. |
| Watcher | Its mode, its model key and this month's cost (section 8) |
| Chime | The sound when a seat waits on you |
| This host | Checks of this machine, and the agent CLIs ready here |
| Remove the room | Section 10 |

Your choices are saved as you make them. The room changes only when you
apply them.

**This host** warns in these cases:

| Check | Warns when |
|---|---|
| Paseo's tools for agents | They are off. Seats cannot create or reach each other without them. |
| Room files | The plugin and the room's files are from different versions. Apply. |
| Pi | A Pi seat is set up and Pi is missing or older than 0.99. |
| Dictation, Voice mode | One is on, for every agent on this machine. Turn it off in Paseo's settings. |
| Two copies of this plugin | `slp-seat`, the plugin's id until 0.18.0, is still installed. Run `paseo plugin remove slp-seat`. |

## 8. The watcher

The watcher reads every turn of a Lead and a Peer: the tool calls and the
final message, never the thinking. When a turn shows a sign of going wrong,
the seat above gets one mail from `room` whose subject starts with
`OBSERVATION`. The watcher never stops or changes a seat.

| Mode | What happens |
|---|---|
| Off | Nothing is read |
| Shadow | Turns are read and findings are logged; nobody is mailed |
| On | Findings are also mailed, at most one per turn |

To switch it on, run it in Shadow for a while, ask HQ for the watcher
stats, then set **Mode** to On and apply.

Thirteen rules read the tool calls, git and the brief. They cost nothing:

| Rule | It speaks when the seat |
|---|---|
| `irreversible` | ran something that cannot be undone from inside the task: `git reset --hard`, a recursive delete outside its scope, a forced push |
| `outside-project` | wrote outside the project |
| `outside-scope` | changed a file its brief's write scope does not cover |
| `software-install` | put a tool or a browser on the machine that its brief does not grant: `brew install`, `npm install -g`, `playwright install`, an archive or a script fetched with `curl`. A project's own dependencies are not that |
| `edit-after-reopen` | mailed `REOPEN_REQUEST` and went on changing source |
| `unreported-test-change` | sent a `CANDIDATE` that changed tests that were already there and does not name them |
| `review-without-check` | gave an accepting `REVIEW` while no check ran |
| `same-failure` | ran the same check 4 times with the same failure |
| `repeating` | did the same thing 4 times in a row with the same result |
| `shell-wait` | waited in the shell for a minute (`sleep`, a loop that sleeps) |
| `silent` | has been in its turn with no activity past its role's stall time |
| `incomplete-brief` | is a Peer whose brief lacks `Outcome`, `Write scope`, `Acceptance evidence`, `Reopen when` or the last line `Reply with seatwork_mail to: owner` |
| `skill-skipped` | is a Peer that writes code and reports `CANDIDATE` without having loaded `candidate-handoff`, or edits under a law that names one of its skills without having loaded it. Logs only, until you set it to `raise` |

Three rules need a decision model to read the seat's final message. The
first one mails. The other two only log until you set them to `raise` in
`policy.json`.

| Rule | It asks when |
|---|---|
| `unverified-completion` | the message speaks of checks, and no test stands behind the last change |
| `external-action` | the seat pushed, published or deployed, and its brief has constraints |
| `reopen-condition` | the brief has a `Reopen when` line and the seat did not ask to reopen |

These three need a key. Without one, the thirteen rules still work and nothing
leaves the machine.

- The model is Jev, reached through OpenRouter. Paste the key into **Model
  key** on the Seatwork screen, or set `SEATWORK_WATCH_KEY`. It is stored
  in `~/.config/seatwork/watch/key`, readable by your user only, and never
  shown again.
- What is sent: the lines of the brief a question reads, the names of
  changed files, and the seat's final message with secrets blanked. Tool
  output is never sent.
- The plan is 6 USD a month, and asking stops at 10. Paseo's Usage view
  shows the spending under "Room watcher".

## 9. What holds the room together

### Mail

Seats talk by mail. Mail never interrupts: it arrives when the recipient's
turn ends. A finished result goes up once, when its sender's own turn has
ended. A closed seat still gets mail, because mail opens it. Mail to an
archived seat comes back to its sender as `UNDELIVERABLE`.

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

The plugin checks who may create whom and who may mail whom:

| Seat | May create | May mail |
|---|---|---|
| HQ | Supervisor | Supervisor |
| Supervisor | Lead, a research Peer | Lead, Peer |
| Lead | Peer, Lens | Supervisor, Peer, Lens |
| Peer | nobody | Lead, Supervisor |
| Lens | nobody | Lead |

Mail off this table is refused. A seat created off it is archived, and its
creator is told.

### What a seat is given

A seat gets its role's prompt and skills, the project's mission and law,
the mail tool, and the Paseo tools its role may use. It does not get your
personal agent setup:

- **Claude seats** use your sign-in with your personal settings off: no
  personal skills, plugins, hooks or MCP servers, and none of Claude Code's
  own extras, such as memory, agent teams, workflows and claude.ai
  connectors. Your `~/.claude/CLAUDE.md` is still added to the prompt.
- **Codex, Pi and OpenCode seats** each get a home of their own under
  `~/.config/seatwork/runtimes/`: your sign-in, without plugins, MCP
  servers, hooks and memory.
- Each CLI's own sub-agents are off. A seat gets help only by creating
  another seat.

Two limits:

- **The rules guard against mistakes. They are not a security boundary.**
  Every seat runs under your account, with your files. A Lens is told to
  read only, but a shell command can still write.
- **Init changes three switches for every agent on this machine**, not only
  for seats: Paseo's browser tools off, terminal agent hooks off, and
  Paseo's bundled skills kept out of agents. It also turns on the switch
  that gives agents Paseo's tools.

## 10. Upkeep

### Update

```bash
paseo plugin update seatwork
```

Then press **Apply** on the Seatwork screen. Until you do, the room refuses
new seats. A room set up from a clone is updated in the clone: `git pull`,
then `./install.sh`.

### Automatic cleanup

| What | When it goes |
|---|---|
| An idle Lens | After 12 hours |
| An idle Lead or Peer | After 48 hours |
| An idle Supervisor | After 7 days |
| HQ | Never |
| Lines of the mail log and the cleanup log | After 7 days |
| The room's backups of Paseo's `config.json` | After 7 days; the newest always stays |
| A folder set aside by Remove or by Init | After 30 days |
| What Codex makes again by itself in a seat's home: its temporary folders, its log database | As soon as no seat of that home is open |
| Session records in the home of a Codex or Pi seat | After 7 days without a write, once no seat of that home is open |

- An idle seat is archived, not deleted. A seat that waits for a permission
  or an answer, or still has an open seat below it, is left alone.
- A mail older than 7 days can no longer be answered by its id, and room
  stats cover 7 days at most.
- Kept whole: `registry-log.jsonl`, the watcher's scan log, and the ACCEPT,
  REJECT and REVISED BRIEF lines of the mail log. The watcher's statistics
  are made from them.
- A session record that is cleared takes the transcript of its archived
  seat with it. What is cleared in a seat's home is listed per agent CLI
  under `gc.runtimes` in `policy.json`. Claude seats keep their sessions in
  your own `~/.claude`, and OpenCode in its own storage: the room clears
  neither.
- Cleanup runs only while the plugin is installed. If you remove the
  plugin, delete `~/.config/seatwork.removed-<time>` yourself.

### Remove the room

The link under the right column of the Seatwork screen. It refuses while a
seat of the room is open: archive those agents first. Then it:

- takes the seats, the profiles and the `hq-seatwork` project out of Paseo;
- moves the room's folder to `~/.config/seatwork.removed-<time>`, mail and
  logs included;
- moves the room's files out of `.seatwork/` in every project it worked in,
  into that same folder.

Your projects stay in Paseo. In a `.seatwork/` the room takes only the
names section 3 lists; a file of yours stays there. Remove the room before
you remove the plugin: removing the plugin alone does not undo Init.

### From a version before 0.19.0

Version 0.19.0 renamed everything that was called `slp`, and moved the
install source to `git:sting9k/seatwork:plugin`. An older install is not
carried over:

1. Remove the plugin: `paseo plugin remove seatwork`, or
   `paseo plugin remove slp-seat` for an install from before 0.18.0.
2. Install it again (section 2) and press **Init**.
3. Set each project up again through HQ.

Init clears the old room by itself. Its folder goes to
`~/.config/slp-room.removed-<time>`, with each project's mission and law
under `projects/`. The watcher's key is carried over.

### Files and logs

```text
~/.config/seatwork/
├── hq-seatwork/         HQ's working folder
├── room/                the prompts, skills and model table in use
├── role-skills/         per-role skills for Claude seats
├── runtimes/            the homes of Codex, Pi and OpenCode seats
├── mail/                mail and the mail log (log.jsonl)
├── watch/               the watcher: its key, scan log and spending
├── setup.json           this machine's choices
├── policy.json          the rules in use
├── seats.json           the seats set up on this machine
├── projects.json        registered projects
├── registry-log.jsonl   every seat created so far
└── gc.log               the cleanup log
```

Claude seats keep their sessions in `~/.claude/projects`, next to yours.
The plugin's own log:

```bash
paseo plugin logs seatwork
```

## 11. Errors

| Message | What to do |
|---|---|
| `is a room seat and no room is set up on this daemon` | Open the Seatwork screen and press Init |
| `the room's files were set up by version …` | Press Apply on the Seatwork screen |
| `is not a seat the room has set up` | Choose that agent CLI for the role on the Seatwork screen, then Apply |
| `may only be created in the hq-seatwork project` | Open HQ in the `hq-seatwork` project |
| `it holds only hq seats` | Open this role in its own project |
| `is not a registered Seatwork project` | Ask HQ to set the project up first |
| `lists for … only …` | The seat was asked for on a model its table does not list. Use one it lists, or change the table |
| `which the room has not enabled` | Open the project on the Seatwork screen and press Save, or fix `.seatwork/room.json` |
| `its runtime could not be built` | Fix what the message names (often `~/.codex/config.toml`), then create the agent again |
| `still open … archive them first` | Archive the room's agents, then remove the room |
| `is too old: the room needs 0.11.2 or later` | Update Paseo, run `paseo daemon restart`, then install again |
| `already runs from …, not from this clone` | `install.sh` met a plugin installed from elsewhere. Run the `paseo plugin remove` command the message gives, then the script |
| An agent says it is not signed in | Sign its agent CLI in, in your terminal |
| An agent does not know a new procedure | Open a new agent: a seat gets its prompt when it is created |
