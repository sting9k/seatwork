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

You need Paseo 0.10.3 or later, `jq`, `python3` with PyYAML, Claude Code and Codex
(plus Pi or OpenCode if you put a role on one of them).

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

The installer adds to Paseo the "seats" (a seat is one role running on
Claude, Codex, Pi or OpenCode), four profiles, the `slp-seat` plugin and the `hq-seatwork`
project. It is safe to run again.

### Signing Claude in

Claude seats share the sign-in of the `claude` command in your terminal.
One sign-in covers every role:

```bash
claude auth login
```

Seatwork uses no token. A seat does not carry your personal skills, plugins,
hooks or MCP servers either; it has only its role's skills.

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
nobody acts on a seat that is still working. An acknowledgement, or a
`DONE` that only repeats itself, wakes nobody: it is read with the next
mail.

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
`.slp/room.json` by hand. Write only what differs from the shared table:

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

Edit in the repo, then run the installer again.

| File | Decides | Run again |
|---|---|---|
| `slp-room/paseo/seats.yml` | Which harnesses (Claude, Codex, Pi, OpenCode) are enabled for each role; which one a role runs on is `models.json` | `./install.sh` |
| `slp-room/room/models.json` | Which model each role uses | `./install.sh --no-plugin` |
| `slp-room/paseo/policy.json` | Who mails whom, who creates whom, waiting times | `./install.sh` |
| `slp-room/room/roles/`, `skills/` | Each role's prompt and procedures | `./install.sh --no-plugin` |

A Peer's model tiers. The shipped table has two; a `cheap` or an `expensive`
tier is added the same way, as one more entry under `peer.tiers`:

| Tier | Used for |
|---|---|
| `default` | Writing code, debugging, research |
| `cross-family` | Reviewing code another model family wrote |

A Lens table has `oracle` (one lens), `hard` (the one lens for a hard
question), `pair` (two lenses, two different models) and `pool` (a third).

## 9. Where files live

```text
~/.config/slp-room/
├── hq-seatwork/         HQ's working directory
├── room/                the prompts, skills and model table in use
├── role-skills/         per-role skills for Claude seats
├── runtimes/            the separate environment of Codex, Pi and OpenCode seats
├── mail/                mail and the mail log
├── projects.json        registered projects
├── registry-log.jsonl   agents created so far
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

## 11. Common errors

| Message | What to do |
|---|---|
| `may only be created in the hq-seatwork project` | Open HQ in the `hq-seatwork` project |
| `holds only hq seats` | Open this role in its own project |
| `is not a registered SLP project` | Ask HQ to set the project up first |
| `lists for … only …` | Use a model from the table, or edit `.slp/room.json` |
| `which the room has not enabled` | Fix `.slp/room.json`, or enable that seat in `seats.yml` |
| `its runtime could not be built` | Fix what the message names (often `~/.codex/config.toml`), then create the agent again |
| An agent says it is not signed in | Run `claude auth login` |
| An agent does not know a new procedure | Open a new agent |

The plugin's log:

```bash
paseo plugin logs slp-seat
```
