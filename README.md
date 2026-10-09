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

Any harness (claude, codex, pi, opencode) can hold any role. Which seats
exist is `slp-room/paseo/seats.yml`; which models they use is
`slp-room/room/models.json`; what a role may touch is
`slp-room/paseo/policy.json`. The committed values are one setup, not a default.

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

```bash
cd slp-room && ./install.sh
```

Needs `jq`, `paseo`, `python3` with PyYAML. Claude seats use the sign-in of `claude` in your
terminal (`claude auth login`), shared by every role; no token. Then open **HQ Supervisor** in
the `hq-seatwork` project (the plugin creates it at
`~/.config/slp-room/hq-seatwork`; HQ starts nowhere else) once, to add your
project; from then on open the **Supervisor** profile inside that project
for the work itself.

To bring a new project in: add it to Paseo, then tell HQ. It drafts the
mission for your yes, asks whether the project uses the room's model table or
its own, registers the project, and has the project's Supervisor write the
law, asking you only what the repository cannot answer. A project's own table
is the `models` object of `<project>/.slp/room.json`: only the differences
from `slp-room/room/models.json`, edited by hand afterwards, applied to the
next seat created and enforced (a seat on a model the table does not list is
refused). The first
registration turns the project guard on: project seats then start only inside
registered projects (`~/.config/slp-room/projects.json`).

## Change

- Prompts, skills, models: edit `slp-room/room/`, run `./install.sh --no-plugin`.
- Seats or policy: edit `seats.yml` or `policy.json`, run `./install.sh`.
  Runtimes rebuild on their own when the policy or your own harness config changed.
- Plugin code: edit `slp-room/plugin/`, run `npm test` there (Node 22.15 or later), then `./install.sh`.
- A prompt change: run `node evals/run.cjs --label <name>` in `slp-room/` before and after (real `claude -p` sessions, costs tokens; see `slp-room/evals/README.md`).
- Logs: `paseo plugin logs slp-seat`, `~/.config/slp-room/mail/log.jsonl`,
  `~/.config/slp-room/gc.log`.
