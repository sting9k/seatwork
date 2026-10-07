# seatwork

A Supervisor → Lead → Peer room on Paseo. A seat is a Paseo provider named
`<harness>-<role>`; one plugin gives it an isolated runtime, a self-contained
role prompt, the project's law, and mail that never interrupts anyone.

```text
Human
  └─ HQ
      └─ Supervisor ─── one per project
            └─ Lead ─── one per workstream
                  ├─ Peer   writes, inside one scope
                  ├─ Peer
                  └─ Lens   reads, answers one question

   up:   reports, questions, candidates
   down: briefs, answers, decisions
   each seat sees only its Owner above and the seats below
```

Any harness (claude, codex, pi, opencode) can hold any role. Which seats
exist is `slp-room/paseo/seats.yml`; which models they use is
`slp-room/room/models.json`; what a role may touch is
`slp-room/paseo/policy.json`. The committed values are one setup, not a default.

Roles are responsibilities, not personalities. A Peer may challenge a brief
with evidence but never edit outside its scope; a Lead decides and accepts but
never edits; a Supervisor pins intent and routes decisions up but never
validates. Sources: the video "Giáo án của Quỷ Vương", the Quỷ Vương Codex Room
toolkit, vhlam.com on SLP and coding-agent anti-patterns.

## Install

```bash
cd slp-room && ./install.sh
```

Needs `jq`, `paseo`, `python3` with PyYAML. Then open an agent on the
**Supervisor** profile inside a project (give it `.slp/room.json` and
`.slp/mission.md`), or **HQ Supervisor** in the HQ workspace.

## Change

- Prompts, skills, models: edit `slp-room/room/`, run `./install.sh --no-plugin`.
- Seats or policy: edit `seats.yml` or `policy.json`, run `./install.sh`
  (policy changes also need `RUNTIME_VERSION` bumped in `plugin/server/runtimes.ts`).
- Logs: `paseo plugin logs slp-seat`, `~/.config/slp-room/mail/log.jsonl`,
  `~/.config/slp-room/gc.log`.
