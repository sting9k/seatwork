# seatwork user guide

Vietnamese version: [GUIDE.vi.md](GUIDE.vi.md)

seatwork turns Paseo into a "room" of agents arranged in levels: you talk
to one agent (HQ), and it coordinates the agents below it, project by
project.

## Contents

1. [The model](#1-the-model)
2. [Install](#2-install)
3. [Start: open HQ](#3-start-open-hq)
4. [Add a new project](#4-add-a-new-project)
5. [Give work](#5-give-work)
6. [How agents talk to each other](#6-how-agents-talk-to-each-other)
7. [Per-project configuration](#7-per-project-configuration)
8. [Room-wide configuration](#8-room-wide-configuration)
9. [Where files live](#9-where-files-live)
10. [Automatic cleanup](#10-automatic-cleanup)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. The model

```text
                          You
                           │  chat with HQ (every project)
                           │  or with one Supervisor (one project)
                           ▼
                 ┌───────────────────┐
                 │        HQ         │   project: hq-seatwork
                 │  looks down,      │   nothing travels up to HQ
                 │  sends down       │
                 └─────────┬─────────┘
            ┌──────────────┴──────────────┐
            ▼                             ▼
   ┌─────────────────┐           ┌─────────────────┐
   │   Supervisor    │           │   Supervisor    │   one per project
   │   project A     │           │   project B     │
   └────────┬────────┘           └─────────────────┘
       ┌────┴─────┐
       ▼          ▼
   ┌───────┐  ┌───────┐
   │ Lead  │  │ Lead  │                              one per workstream
   └───┬───┘  └───────┘
   ┌───┼────────┐
   ▼   ▼        ▼
 Peer  Peer    Lens                                  Peers write, a Lens only reads
```

| Role | Does | Never does |
|---|---|---|
| **HQ** | Takes your request, splits it per project, sends instructions down to Supervisors, looks at the projects when you ask | Take part in the work, create a Lead or a Peer, edit code |
| **Supervisor** | Pins one project's goal, splits it into workstreams, keeps the Leads on course; what needs your decision goes in its end-of-turn report | Edit code, accept work, mail upward |
| **Lead** | Plans one workstream, hands tasks to Peers, inspects and accepts results; does tiny work and the first scaffold itself | Edit a Peer's scope, do large work alone |
| **Peer** | Does one concrete task inside the files it was given | Edit outside its scope |
| **Lens** | Answers one hard question or reviews, independently of the Lead | Edit anything |

Two rules to keep in mind:

- **Each level sees only the level directly above and below.** Agents
  inside a project know one "Owner" above them; they do not know HQ or you
  exist.
- **Reports go up only as far as the Supervisor.** A Supervisor cannot send
  anything to HQ; HQ looks down (the Supervisor's end-of-turn report,
  `.slp/status.md`) when you ask, then sends instructions down. Talk to HQ
  to manage every project; talk to a project's Supervisor to manage one.
- **Each role is a responsibility.** A Lead decides but does not edit code;
  a Peer edits code but does not widen its own scope.

A "seat" is a Paseo provider named `<harness>-<role>`, for example
`claude-lead` or `codex-peer`. A harness is the tool that runs the agent:
claude, codex, pi, opencode.

---

## 2. Install

**You need:** Paseo 0.10.3 or later, `jq`, `python3` with PyYAML, and at
least one harness signed in (Claude Code by default, plus Codex for Peers
and Lenses).

```bash
git clone https://github.com/sting9k/seatwork.git
```

```bash
cd seatwork/slp-room && ./install.sh
```

The installer does four things:

1. Copies the prompts, skills and model table to `~/.config/slp-room/`.
2. Writes the seats and 4 profiles (HQ Supervisor, Supervisor, Lead, Peer)
   into Paseo's configuration. The previous file is backed up next to it.
3. Installs the `slp-seat` plugin into Paseo.
4. The plugin creates the `hq-seatwork` project, the home of HQ.

Running `./install.sh` again is safe; nothing is duplicated.

---

## 3. Start: open HQ

1. Open Paseo and pick the **hq-seatwork** project.
2. Create an agent with the **HQ Supervisor** profile.
3. Talk to it the way you would talk to a manager.

HQ starts only in `hq-seatwork`, and only HQ starts in `hq-seatwork`. In
the wrong place Paseo shows an error that says why.

---

## 4. Add a new project

You do two things: add the directory to Paseo, then tell HQ.

```text
 You                    HQ                         The project's Supervisor
  │                      │                                  │
  │ 1. add the project   │                                  │
  │    to Paseo          │                                  │
  │                      │                                  │
  │ 2. "set up X"        │                                  │
  ├─────────────────────▶│ reads the README                 │
  │                      │                                  │
  │ 3. mission draft     │                                  │
  │    + model question  │                                  │
  │◀─────────────────────┤                                  │
  │ 4. "yes" / changes   │                                  │
  ├─────────────────────▶│ registers the project            │
  │                      │ 5. opens the Supervisor ────────▶│ writes the law
  │                      │                                  │
  │                      │                                  │ leaves its open
  │ 6. you write again   │                                  │ questions in its
  ├─────────────────────▶│ looks down: reads the report ···▶│ report
  │    law questions     │                                  │
  │◀─────────────────────┤                                  │
  │ 7. answers           │                                  │
  ├─────────────────────▶├─────────────────────────────────▶│ settles the law
  │                      │                                  │
  │ 8. you write again   │ looks down: reads DONE ·········▶│
  ├─────────────────────▶│                                  │
  │   "project ready"    │                                  │
  │◀─────────────────────┤                                  │
```

Dotted arrows are HQ reading; the Supervisor sends nothing up. So after
step 5, write HQ anything ("how is it going") to make it look.

What gets created:

- **Mission** (`.slp/mission.md`): a few lines on what the project is for,
  who uses it, what done looks like, what is out of bounds. HQ drafts it
  from the README and you approve it.
- **Model table**: HQ asks whether the project uses the room's table or one
  of its own. See [section 7](#7-per-project-configuration).
- **Law** (`.slp/<project-name>-law.md`): the project's own rules, such as
  strictness, how candidates are reviewed, and which actions need your yes
  first (push, deploy). The Supervisor fills what the repository answers
  and asks only for the rest. Reply "all recommended" to take every
  suggestion.

> **Note:** the first project you register turns the "registry mode" on.
> From then on Supervisors, Leads and Peers start only inside registered
> projects. Add any other project through HQ as well.

---

## 5. Give work

Tell HQ what you want in plain words. A good request has three parts:

| Part | Example |
|---|---|
| The outcome | "Add a `notes search <word>` command" |
| Acceptance evidence | "With tests, `python3 -m unittest` passes" |
| Authority | "Local commits are fine, do not push" |

HQ asks for whichever part is missing. Then:

```text
 You ──▶ HQ ──▶ Supervisor ──▶ Lead ──▶ Peer      work goes down
                                         │
                                      result
                                         ▼
          HQ ···▶ Supervisor ◀── Lead ◀── Lens/review   reports go up
 You ◀────┘ looks down when you ask                     to the Supervisor
```

1. HQ passes the work to the project's Supervisor.
2. The Supervisor splits it into workstreams, one Lead each.
3. The Lead splits a workstream into tasks, one Peer each, with a clear
   file scope.
4. A Peer hands in its result; the Lead has a reviewer from another model
   family check it, then accepts it or sends it back.
5. When everything is done, the Supervisor writes the result in its
   end-of-turn report and `.slp/status.md`.

Tiny work (a quick fix, a few files, directly verifiable) and the first
scaffold are done by the Lead itself, without a Peer.

A Supervisor's report always carries two sections that keep you in control:
**decided by the room** (what it chose on its own, and whether you may
revisit it) and **overruled** (objections a Peer raised with evidence that
were not followed). Both also live in `.slp/status.md` and are never
summarised away.

When something is yours to decide (cost, product scope, an outside action
such as push or deploy), the Supervisor puts it in the `WAITING ON YOU:` row
at the end of its report. HQ receives nothing by itself; it looks down when
you write, then asks you with a recommendation and its consequence. HQ never
decides for you.

Ask for status at any time: "how are the projects doing". HQ can also count
from the mail log (`slp_room_stats`): how many results were accepted or sent
back, how often a Peer challenged a brief and was conceded.

**Working without HQ:** open the **Supervisor** profile directly inside a
project and give it the work. You are then its "Owner" and read its reports
yourself.

**Steering a Peer:** go through the Supervisor or the Lead. If you chat with
a Peer directly it obeys, and its next report opens with `DIRECT:` so the
Lead learns that someone instructed it outside the mail.

---

## 6. How agents talk to each other

Agents do not interrupt each other. They send mail, and mail is delivered
only when the recipient has finished its current turn.

```text
   Peer working                   Lead busy
        │                              │
        │── mail: CANDIDATE ──▶ [ held ]
        │                              │  turn ends
        │                        [ delivered ]
        │                              ▼
        │◀──── mail: ACCEPT ─── Lead handles it
```

The first line of every report is a signal:

| Signal | Sent by | Meaning |
|---|---|---|
| `CANDIDATE` | Peer | A result is ready to inspect |
| `QUESTION` | Peer | The brief lacks information |
| `REOPEN_REQUEST` | Peer | A premise of the brief is wrong, with evidence |
| `DEPENDENCY_REQUEST` | Peer | Something outside its scope is needed |
| `BLOCKED` | any role | Nothing safe is left to do |
| `ACCEPT` / `REJECT` | Lead | Accepted, or sent back with the repair |
| `REVISED BRIEF` | Lead | The Peer's challenge held; the brief changed |
| `HOLD` / `NOTED` | Lead | The current route stands; the Peer's objection is on record, no further debate |
| `DECISION_NEEDED` | Lead, Supervisor | The level above has to decide |
| `DONE` | any role | Finished, nothing is running |

Who may mail whom and who may create whom is enforced by the plugin, not
left to the agents' good behaviour. A Peer cannot mail another Peer; HQ
cannot create a Lead.

---

## 7. Per-project configuration

Every project has its own `.slp/` directory:

```text
<project>/.slp/
├── room.json            marks the project + its own model table (optional)
├── mission.md           what the project is for
├── <name>-law.md        the project's own rules
├── status.md            progress, decisions the room made on its own, overruled objections
└── notebook.md          lessons learned
```

### A project's own model table

The first time, HQ asks and writes it for you. After that, edit the
`models` object in `.slp/room.json` by hand. Write only what **differs**
from the room's table (`~/.config/slp-room/room/models.json`):

```json
{
  "models": {
    "seats": {
      "lead": { "thinking": "medium" }
    },
    "peer": {
      "tiers": {
        "default": { "providers": ["claude-peer/claude-opus-5-5"] },
        "expensive": null
      }
    }
  }
}
```

This example: the Lead thinks at medium, the `default` Peer tier runs on
Opus, and the `expensive` tier is removed.

| Rule | Detail |
|---|---|
| How it overrides | Objects merge key by key; lists and values replace; `null` removes a key |
| When it applies | To seats created **after** the edit. Running seats keep the old table. No reinstall |
| What you can pick | Only seats enabled in `seats.yml` |
| Is it enforced | Yes. A seat on a model the table does not list is refused |
| If the edit is wrong | The seat is not created and the error names the faulty entry |

Delete the `models` object to go back to the room's table.

---

## 8. Room-wide configuration

These files live in the repo; after editing, run the installer again:

| File | Decides | After editing |
|---|---|---|
| `slp-room/paseo/seats.yml` | Which harness may hold which role | `./install.sh` |
| `slp-room/room/models.json` | The model of each role, the Peer tiers, the Lenses | `./install.sh --no-plugin` |
| `slp-room/paseo/policy.json` | Who mails whom, who creates whom, stall thresholds, cleanup | `./install.sh` |
| `slp-room/room/roles/`, `skills/` | Each role's prompt and procedures | `./install.sh --no-plugin` |

The Peer tiers in `models.json`:

| Tier | Used for |
|---|---|
| `cheap` | Mechanical, fully specified work |
| `default` | Implementation, debugging, multi-file changes |
| `expensive` | Architecture decisions, hard bugs, a task that failed at default |
| `cross-family` | A reviewer from a different model family than the author |

---

## 9. Where files live

```text
~/.config/slp-room/
├── hq-seatwork/         HQ's working directory
├── room/                prompts, skills, models.json (the copies in use)
├── runtimes/            an isolated environment per seat
├── mail/                mail and the mail log (log.jsonl)
├── policy.json          the room's rules (the copy in use)
├── seats.json           enabled seats
├── projects.json        registered projects (exists after the first registration)
├── registry-log.jsonl   every seat ever created
└── gc.log               the cleanup log
```

The room writes nothing to `~/.claude`, `~/.codex`, `~/.pi` or
`~/.config/opencode`. Each seat runs in its own environment and does not
inherit your personal skills, plugins or MCP servers.

---

## 10. Automatic cleanup

Every 10 minutes the plugin archives seats that have been idle too long,
unless one of their child seats is still alive:

| Role | Archived after being idle for |
|---|---|
| HQ | Never |
| Supervisor | 7 days |
| Lead, Peer | 48 hours |
| Lens | 12 hours |

The parent seat is told when a child is archived. Mail still held for an
archived seat is returned to its sender. The plugin never kills a process.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "may only be created in the hq-seatwork project" | HQ opened outside `hq-seatwork` | Open it in the `hq-seatwork` project |
| "holds only hq seats" | Another role opened in `hq-seatwork` | Open it in its own project |
| "is not a registered SLP project" | Registry mode is on and the project is not registered | Ask HQ to set that project up |
| "refused: project … lists for … only …" | The model is not in the project's table | Use a listed model, or edit `.slp/room.json` |
| "names …, which the room has not enabled" | `room.json` names a seat that is not enabled | Fix the entry, or enable the seat in `seats.yml` and reinstall |
| "is not enabled in paseo/seats.yml" | The seat is not enabled | Enable it in `seats.yml`, run `./install.sh` |
| HQ does not know a new procedure | The agent was opened before the update | Open a new HQ |
| No `hq-seatwork` project | The plugin is not loaded | `paseo plugin reload slp-seat` |

Logs:

```bash
paseo plugin logs slp-seat
```

```bash
tail -f ~/.config/slp-room/mail/log.jsonl
```

```bash
tail -f ~/.config/slp-room/gc.log
```
