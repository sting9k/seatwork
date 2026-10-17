Seatwork turns Paseo into a room of coding agents that work as a small organization. You talk to one seat. It splits the work, hands it to other seats, and reports back with what was done and what still needs you.

## Roles

| Role | Where | Does | Never |
|---|---|---|---|
| HQ | the `hq-seatwork` project | Knows every project, adds one, runs the room: incidents, spend, the settings it may tune | Starts Leads or Peers |
| Supervisor | one per project | Starts a Lead for each request, watches how the work goes, proposes the smallest correction, brings you the decisions that are yours | Decides for the project or writes code |
| Lead | one per request | Plans, opens Peers, integrates, accepts or sends work back | Writes code |
| Peer | one per task | One outcome in one scope. A spec in its title (`search`, `scout`, `review`, `arch`) makes it answer a question or judge a candidate, a plan or a design instead | Widens its own task |

## How it works

Each role is a Paseo provider named after the agent CLI and the role, for example `claude-lead` or `codex-peer`. When an agent is created on one, the plugin gives it the room's prompt, its role's prompt and skills, the project's mission and law, and the room's tools. Seats write to each other by mail along the tree, and mail is delivered between turns.

The room checks the work in code, not by asking seats to behave:
- a guard reads every shell command and file write and records the risky ones; it stops none;
- a hand-in check reads a Peer's diff before its Lead sees it;
- a council reads each turn for the room's laws, with a decision model when it has a key;
- tasks are leased, so work held by a seat that went quiet goes back;
- a project can have a daily spend cap.

A seat does not run on your personal agent setup. Claude seats use your sign-in with personal settings switched off. Codex, Pi and OpenCode seats each get a home of their own, built from yours with plugins, MCP servers and memory left out.

## Setup

Press Seatwork at the top of Paseo's sidebar, choose what each role runs on, and press Init. Press Apply after changing a choice. Init creates the room's folder (`~/.config/seatwork`), the seats and four profiles in Paseo, and the `hq-seatwork` project. Open HQ there to add a project: it asks for the project's mission and law, then opens its Supervisor.

- Paseo 0.11.2 or later, on macOS or Linux.
- At least one of Claude Code, Codex, Pi (0.99 or later) or OpenCode, signed in. The screen lists what it finds on the host.
- Paseo's own tools for agents must be on. This is Paseo's default.

Removing the plugin does not undo Init. Use "Remove the room" on the same screen first: it takes the seats and profiles out of Paseo and moves the room's folder aside without deleting it.

## What you can set

| What | Where |
|---|---|
| The agent CLI, model and thinking level of each role. A Peer has several models, each under a name with a line on what it is for; the Lead reads them and picks. | Models, on the Seatwork screen. A project can have its own table under Models for this project. |
| A sound when a seat waits on you | Chime, on the same screen |
| Instructions every seat reads, on every agent CLI. Your own CLAUDE.md or AGENTS.md reaches no seat unless you list it. | `~/.config/seatwork/AGENTS.md`; `room.instructions` in the policy lists more files |
| The decision model's key. Without one nothing leaves the host: the council's jurors and the read of a decision before it is kept are skipped, and the code checks still run. No cap stops a call; what each one costs is logged. | `~/.config/seatwork/jev/openrouter.key`, readable by your user only |
| A project's daily spend cap, the guard's limits, the decision model's provider | `~/.config/seatwork/policy.json`. What you change there stays through Apply and plugin updates; a key you leave alone takes the new version's value. |

## What it touches

- Paseo's daemon config: the room's providers and profiles, the switch that gives agents Paseo's tools, and three daemon-wide switches (browser tools off, terminal agent hooks off, Paseo's bundled skills kept out of agents). The last one is written into `config.json` directly, with a backup beside it.
- A local server on `127.0.0.1` for the room's tools.
- In each project, a `.seatwork/` folder: its mission and law, and the stores of its mail, work and record. The stores keep themselves out of the project's git.
- The room's folder: the room's files, logs, the mail of seats outside a project, and the copies of your agent CLI config. It is readable by your user only.

## Limits

- The room's prompts, skills and stored data are in English.
- Antigravity, Copilot and other providers cannot hold a seat.
- A seat is billed however its agent CLI is billed. Spend is capped per project only where a cap is set.
