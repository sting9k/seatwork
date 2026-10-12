Seatwork turns Paseo into a room of coding agents that work as a small organization. You talk to one seat. It splits the work, hands it to other seats, and reports back with what was done and what still needs you.

There are five roles. An HQ Supervisor knows every project. A project has one Supervisor, who runs a Lead for each workstream. A Lead plans, hands bounded tasks to Peers, asks Lenses for a second opinion on hard questions, and accepts or rejects what comes back. A role never does the job of the one below it: Supervisors and Leads do not write code.

## How it works

Each role is a Paseo provider named after the agent CLI and the role, for example `claude-lead` or `codex-peer`. When an agent is created on one of them, the plugin gives it the role's prompt, the project's mission and rules, and a mail tool. Seats write to each other only along the tree, and mail is delivered between turns. What a seat can create and which Paseo tools it sees are fixed per role.

A seat does not run on your personal agent setup. Claude seats use your sign-in with personal settings switched off. Codex, Pi and OpenCode seats each get a home of their own, built from yours with plugins, MCP servers and memory left out.

## Setup

Installing the plugin creates nothing. Press Seatwork at the top of Paseo's sidebar, choose what each role runs on, and press Init. Init creates the room's folder (`~/.config/slp-room`), the seats and four profiles in Paseo, and a project named `hq-seatwork` for the HQ Supervisor. Press Apply after changing a choice.

- Paseo 0.11.2 or later, on macOS or Linux.
- At least one of Claude Code, Codex, Pi (0.99 or later) or OpenCode, signed in. The screen lists what it finds on the host.
- Paseo's own tools for agents must be on. This is Paseo's default.

Removing the plugin does not undo Init. Use "Remove the room" on the same screen first: it takes the seats and profiles out of Paseo and moves the room's folder aside without deleting it.

## What you can set

- **What each role runs on.** The agent CLI, the model and the thinking level for HQ, Supervisor, Lead, Peer and Lens. A Peer and a Lens are one role with several models, each under a name of your choice with a line on what it is for; the Lead reads them and picks. A role's seat is set up when you choose a model for it. The choice holds for every project; a project can be given models of its own on the same screen.
- **Watcher.** Off, shadow or on. It reads the turns of Leads and Peers and looks for a turn going wrong: a brief missing its parts, repeated failing commands, work outside the task. In shadow it only logs. On, it mails the seat above.
- **Watcher key.** Optional. With a key, four of the watcher's rules send a seat's final message to a decision model at the endpoint named in the room's policy. Without one nothing leaves the host. The key is stored in the room's folder, readable by your user only, and is never sent back to the app.
- **Chime.** A short sound in the open app when a seat waits on you.

## What it touches

- Paseo's daemon config: the room's providers and profiles, the switch that gives agents Paseo's tools, and three daemon-wide switches (browser tools off, terminal agent hooks off, Paseo's bundled skills kept out of agents). The last one is written into `config.json` directly, with a backup beside it.
- A local mail server on `127.0.0.1` for the seats' mail tool.
- Mail, logs and the copies of your agent CLI config live in the room's folder, readable by your user only.

## Limits

- The room's prompts and skills are written in English.
- Antigravity, Copilot and other providers cannot hold a seat.
- A seat on Codex is billed however your Codex is billed; the room adds no spending cap of its own for seats. The watcher has a monthly cap.
