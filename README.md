# seatwork

A Supervisor → Lead → Peer room on Paseo. A seat is a Paseo provider named
`<harness>-<role>`; one plugin keeps it apart from your personal setup, gives it a self-contained
role prompt, the project's law, and mail that never interrupts anyone.

```text
Human
  └─ HQ
      └─ Supervisor ─── one per project
            └─ Lead ─── one per workstream
                  ├─ Peer   writes, inside one scope
                  ├─ Peer
                  └─ Lens   reads, answers one question

   up:   reports, questions, candidates — as far as the Supervisor
   down: briefs, answers, decisions
   HQ sends down and looks; nothing travels up to it
   each seat sees only its Owner above and the seats below
```

Any harness (claude, codex, pi, opencode) can hold any role. Which agent CLI
and model each role runs on is chosen on the plugin's setup screen in Paseo;
a role's seat is set up when a model is chosen for it, or when HQ registers a
project whose own table names it. The screen starts from
`slp-room/plugin/room/models.json`; what a role may touch is
`slp-room/plugin/paseo/policy.json`. The committed values are one setup, not a default.

Roles are responsibilities, not personalities. A Peer may challenge a brief
with evidence but never edit outside its scope; a Lead decides and accepts,
and edits only tiny work itself; a Supervisor pins intent and leaves decisions
for its Owner to read but never validates; HQ watches from above and sends
instructions down. Daily work goes straight to a project's Supervisor; HQ is
for management only: the state of every project, adding one, an instruction
sent down. Projects do not know HQ exists and send nothing up to it. Sources: the video "Giáo án của Quỷ Vương", the Quỷ Vương Codex Room
toolkit, vhlam.com on SLP and coding-agent anti-patterns.

Full guide: [English](docs/GUIDE.en.md) · [Tiếng Việt](docs/GUIDE.vi.md).

## Install

Needs Paseo 0.11.2 or later. In Paseo open Settings, Plugins, paste this into
"Plugin source" and press Install plugin:

```
git:sting9k/seatwork:slp-room/plugin
```

Installing creates nothing. On the plugin's "…" menu choose **Seatwork**:
the screen has one line for each role (HQ, Supervisor, Lead, Peer, Lens) to
choose what it runs on, from the agent CLIs and models this machine has. A
Peer and a Lens are one role with several named models (`cheap`, `high`, …);
the Lead reads the names and picks. Below are the watcher's mode and the chime. **Init** then creates the room's folder
(`~/.config/slp-room`), the seats and four profiles in Paseo, and the
`hq-seatwork` project, with no restart. **Apply** on the same screen applies a
later change; **Remove the room** takes it out again and keeps its folder.

From a terminal instead, for a machine without the app or to work on the
room's own files (needs `node` and `npm`):

```bash
cd slp-room && ./install.sh
```

It does what Init does and asks two questions on a first run: HQ on the
room's default seat or on an agent CLI and model you choose
(`--hq <harness>/<model>` or `--hq default` answers without the question), and
whether to install the watcher, which reads Lead and Peer turns and tells the
seat above when one goes off (`--watcher off`, `shadow` or `on`; a yes starts
it in `shadow`, where it only logs).

Claude seats use the sign-in of `claude` in your terminal
(`claude auth login`), shared by every role; no token. Open **HQ Supervisor**
in the `hq-seatwork` project (`~/.config/slp-room/hq-seatwork`; HQ starts
nowhere else) once, to add your project; from then on open the **Supervisor**
profile inside that project for the work itself.

To bring a new project in: add it to Paseo, then tell HQ. It drafts the
mission for your yes, asks whether the project uses the room's model table or
its own, registers the project, and has the project's Supervisor write the
law, asking you only what the repository cannot answer. A project's own table
is the `models` object of `<project>/.slp/room.json`: only the differences
from the room's table, edited by hand afterwards, applied to the
next seat created and enforced (a seat on a model the table does not list is
refused). The table may put a role on any harness: HQ sets up a seat the room
does not have yet when it registers the table (from a clone, by hand:
`./install.sh --seat <harness>-<role>`). The first
registration turns the project guard on: project seats then start only inside
registered projects (`~/.config/slp-room/projects.json`).

## Change

- What a role runs on, the watcher's mode, the chime: the setup screen, then Apply.
- Prompts, skills, the room's own model table, seats every install gets, policy: edit
  `slp-room/plugin/room/` or `slp-room/plugin/paseo/` in a clone, run `./install.sh`.
  A plugin installed from Paseo gets them with `paseo plugin update slp-seat`, then Apply.
  Runtimes rebuild on their own when the policy or your own harness config changed.
- This machine's own choices are kept in `~/.config/slp-room/setup.json` (the screen's
  choices, the seats HQ added for a project, `mailPort` when the policy's port is taken).
- Plugin code: edit `slp-room/plugin/`, run `npm test` there (Node 22.15 or later), then `./install.sh`.
- A prompt change: run `node evals/run.cjs --label <name>` in `slp-room/` before and after (real `claude -p` sessions, costs tokens; see `slp-room/evals/README.md`).
- Logs: `paseo plugin logs slp-seat`, `~/.config/slp-room/mail/log.jsonl`,
  `~/.config/slp-room/gc.log`.
