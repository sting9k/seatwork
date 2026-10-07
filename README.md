# seatwork

A Supervisor → Lead → Peer room on Paseo: every agent is a seat with one
job. One plugin (`slp-seat`) turns a Paseo provider named `<harness>-<role>`
into a seat: its own isolated runtime, a self-contained role prompt, the
project's law, and a mail channel that never interrupts anyone.

```text
Human ⇄ HQ ⇄ N Supervisors (one per project) ⇄ N Leads (one per workstream) ⇄ N Peers
                                                                           ⇄ Lenses
```

The same mechanism repeats at every level: pin the intent, split, dispatch, end
the turn, close every loop, report. Every seat is a model, not a person on a
team; a role is a set of responsibilities and rights, not a personality.

Sources: the video "Giáo án của Quỷ Vương" (Tù Bà Khuỳm), the Quỷ Vương Codex
Room toolkit, and vhlam.com's articles on SLP and coding-agent anti-patterns.

## Layout

Everything lives under `slp-room/`.

| Path | What it is |
|---|---|
| `slp-room/paseo/seats.yml` | Which seats exist: `<role>: [harness, ...]`. Only these providers and runtimes are created. |
| `slp-room/paseo/policy.json` | What each role may touch: Paseo tool allowlist, Claude denied tools and skills, what each harness runtime shares from the user's home, mail delivery, garbage collection, mail routes, spawn rules, the knobs the prompts quote (`room.params`). |
| `slp-room/paseo/profiles.json` | The four Paseo profiles: HQ Supervisor, Supervisor, Lead, Peer. |
| `slp-room/room/models.json` | Every model id the room uses. Rendered into the role prompts as `{{placeholders}}` when a seat is created. |
| `slp-room/room/roles/` | One self-contained prompt per role: `hq`, `supervisor`, `lead`, `peer`, `lens`. |
| `slp-room/room/specs/` | Peer specializations, appended by title: `[Peer:review]`, `[Peer:research]`. |
| `slp-room/room/harness/` | One sheet per harness: how it exposes the room's tools. |
| `slp-room/room/law/project-law.md` | Template the Supervisor copies to `.slp/<project>-law.md` on its first run. |
| `slp-room/room/skills/<role>/` | Role skills, symlinked into that role's runtime and nowhere else. |
| `slp-room/plugin/` | The `slp-seat` Paseo plugin, server side only. |
| `slp-room/tools/gen-snippet.py` | Turns seats.yml, policy, profiles and models into `slp-room/paseo/config.snippet.json` (ignored) and `~/.config/slp-room/seats.json`. |
| `slp-room/install.sh` | Generates, copies the room, merges the Paseo config, installs or reloads the plugin. |

## Who knows what

Every seat knows only a faceless **Owner** above it and the seats it launches.
A Peer never hears of a Lead, a Lead never of a Supervisor, a Supervisor never
of HQ or Human. Mail from any ancestor arrives `from owner`; the seat answers
with `reply_to` or `to: owner`. The plugin enforces it: `room.routes` says which
role may write to which, the parent and child tree says which seats, and
`room.spawn` says who may create whom. A seat created outside those rules is
archived on sight and its parent gets a `SPAWN REFUSED` mail.

| Role | Launches | Mails | Never |
|---|---|---|---|
| HQ | one Supervisor per registered project | Supervisors | a Lead or Peer, an edit, a decision for Human |
| Supervisor | one Lead per workstream | Leads; a Peer only for a strong intervention, then it tells the Lead | validate, accept, edit |
| Lead | Peers, Lenses | Peers, Lenses, Owner | edit, build, test |
| Peer | nothing | Owner | other agents, accepting its own change |
| Lens | nothing | Owner, reply only | edit, read another lens |

## How a seat is built

On `before agent.create` for a `<harness>-<role>` provider the plugin:

1. refuses when the provider is not in `seats.yml`, or, with a registry
   (`~/.config/slp-room/projects.json`), when the cwd is not a registered project;
2. builds once `~/.config/slp-room/runtimes/<harness>/<role>` and points the
   harness at it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`,
   `OPENCODE_CONFIG_DIR`). Only what `policy.json` lists is shared from the
   user's home; harness-native sub-agents, browser and computer use are off;
   the role's skills are symlinked in;
3. sets the system prompt: `roles/<role>.md` rendered from `models.json` and
   `room.params`, the spec sheet, the harness sheet, and the project block
   (root, `.slp/mission.md`, `.slp/<project>-law.md`);
4. injects the room's MCP server (`slp_mail`, `slp_inbox`) with a per-seat
   nonce; `agent.session_open` binds that nonce to the agent id.

Tool policy is one file applied in three layers: Paseo tools per seat (an
allowlist per role becomes `paseoTools.disabledTools`), harness-native tools in
the runtime (Claude `disallowedTools` plus denied bundled skills, Codex features
off, Pi packages dropped, OpenCode `task` denied), and daemon-wide switches
(browser tools, voice, bundled skills; skip with `--no-daemon-policy`).

## Mail

Seats never use `send_agent_prompt`. `slp_mail(to | reply_to, subject, body,
needs)` posts an envelope; the plugin assigns the priority (`BLOCKING`,
`ACTION`, `FYI`), checks the route, and delivers when the recipient is idle:
one digest per turn, held while it runs. Steer, Paseo's only way to reach a
running agent, cancels the running tool on Claude and Pi (verified
2026-10-07), so nothing is steered. A child's turn end, failure or permission
request becomes mail to its parent; HQ hears only Supervisors, and only when
there is something to act on. Queues live in
`~/.config/slp-room/mail/queue/<agentId>.jsonl`; `mail/log.jsonl` records every
step.

## Models and lenses

`room/models.json` holds the HQ, Supervisor and Lead seats, the Peer tiers
(cheap, default, expensive, cross-family, each with what it is for and never
for), and the lens models. A lens is a strong independent model the Lead opens
on a neutral brief that carries none of the Lead's reasoning: one lens is the
oracle, two are the pair (two different models, always), more come from the
pool, never the same model twice. Procedure: `slp-room/room/skills/lead/slp-lens`.

## Garbage collection

The plugin runs a pass every `gc.everyMinutes` and a short one whenever a
seat is archived. A room seat idle longer than its role's limit
(`gc.idleHoursBeforeArchive`, 0 means never) is archived unless something it
launched is still alive, and its parent gets an FYI mail. Heartbeats whose
seat is archived or gone are deleted (through the paseo CLI, the plugin SDK
has no schedule API). Mail still held for an archived seat bounces to its
sender. GC never kills a process and never touches an agent that is not a
room seat; every action is a line in `~/.config/slp-room/gc.log`.

## Install

```bash
cd slp-room && ./install.sh
```

Needs `jq`, `paseo`, `python3` with PyYAML. Pi seats also need
`pi-mcp-adapter`, which the installer adds.

Optional registry: copy `~/.config/slp-room/projects.json.example` to
`projects.json` and list the projects; each project gets `.slp/room.json`
(`{}` is enough) and `.slp/mission.md`. Without the registry, seats run
anywhere and the project block comes from the nearest `.slp/room.json`.

Then open an agent on the **Supervisor** profile inside a project, or **HQ
Supervisor** in the HQ workspace.

## Change the room

- Prompts, skills, specs, models: edit `slp-room/room/`, run `./install.sh --no-plugin`.
  They are read at every seat creation.
- Seats: edit `slp-room/paseo/seats.yml`, run `./install.sh`.
- Tool policy or what a runtime shares: edit `slp-room/paseo/policy.json`, run
  `./install.sh`, then bump `RUNTIME_VERSION` in `slp-room/plugin/server/runtimes.ts` or
  delete the runtime directory so it is rebuilt.
- Plugin code: `./install.sh` typechecks and reloads it.

## Verify

```bash
paseo plugin ls
paseo plugin logs slp-seat
paseo provider ls
ls ~/.config/slp-room/runtimes/*/
```

## Not here yet

- A full end-to-end run on real work; the mechanics were verified with cheap
  seats only.
