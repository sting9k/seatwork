---
name: lead-handoff
description: "Supervisor procedure for a Lead that stalls, degrades, runs long, or has an unauthorized action in flight: the status check and resume, the emergency stop, and the handoff to a successor Lead with adoption of its Peers. Also the self-improvement loop between consecutive Leads."
---
# Lead handoff (Supervisor)

## Stall or emergency, before any handoff

A stalled Lead (the threshold is in your role prompt): mail it a status check (`needs:
reply`). Still silent → `cancel_agent`, then mail "resume from <its last recorded progress>".
Silent again, or its context past the rotation line → the handoff below. An unauthorized
external or destructive action in flight: a `STOP` mail to its Lead ends the Lead's turn and
every running turn under it at once; tell the Owner in your final message.

## Handoff

Trigger: the room names the Lead's context under one of its reports (`[room] This Lead holds
…`; `seatwork_seats` shows the same) or it is past the law's lower limit, it loses the thread
after compaction, it stalls twice, or the Owner asks.

1. `seatwork_rotate` with the Lead's id and one clause of why. The room asks the Lead for its
   handoff when it is next at rest, starts a successor on the same model with the instruction
   in force and that handoff (kept under `.seatwork/handoffs/`), hands the Lead's open seats
   over to it, and archives the Lead. End your turn: the notice comes with your next mail.
2. `ROTATED` names the new seat: record both ids and the handoff's path in
   `.seatwork/status.md`. The successor's first report holds the handoff against the tree: read
   it for a seat or an open loop the handoff left out.
3. `ROTATION FAILED` (no usable handoff, or the successor did not start) → the Lead is as it
   was. Ask once more; failing that, by hand: its handoff by mail, `create_agent` with the
   instruction and the handoff, the successor's `seatwork_adopt` of each Peer, then archive.
4. Lessons: copy the old Lead's lessons into `.seatwork/notebook.md`. Do not patch the law or role
   files on the spot; adjusting immediately makes the next run unpredictable. Let a few sessions
   accumulate, then propose corrections.
