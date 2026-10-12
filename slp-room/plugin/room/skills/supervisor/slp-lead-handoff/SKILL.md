---
name: slp-lead-handoff
description: "Supervisor procedure for a Lead that stalls, degrades, runs long, or has an unauthorized action in flight: the status check and resume, the emergency stop, and the handoff to a successor Lead with adoption of its Peers. Also the self-improvement loop between consecutive Leads."
---
# Lead handoff (Supervisor)

## Stall or emergency, before any handoff

A Lead silent past the threshold in your role prompt, with no running Peer and no pending
permission: mail it a status check (`needs: reply`) and end your turn. Still silent →
`cancel_agent`, then mail "resume from <its last recorded progress>". Silent again, or its
context past the law's limit → the handoff below. An unauthorized external or destructive
action in flight: mail its Lead now, `cancel_agent` the actor if it is still going, and tell
the Owner in your final message. A stalled Peer belongs to its Lead.

## Handoff

Trigger: the Lead's context is past the project law's limit (default ~45% of its window), it
loses the thread after compaction, it stalls twice, or the Owner asks.

1. Mail the current Lead (`needs: reply`): finish the step in flight, start no new dispatch, and
   produce a **handoff**: accepted candidates, open loops with owners and return checkpoints,
   owned scopes and their Peers (ids), the current plan and what changed and why, decisions and
   dissent recorded, lessons learned ("which mistakes would you avoid next time"), and usable
   downstream inputs.
2. Create the successor: `create_agent` with the Lead provider and settings from your role,
   `notifyOnFinish: false`, `initialPrompt` = the workstream's intent record + the handoff +
   "adopt these Peers with `slp_adopt`, then re-prompt each with its brief and your disposition of its last signal, or
   archive and relaunch its scope".
3. Verify adoption: the successor's first report lists every adopted Peer with a disposition.
   Until then, results from those Peers reach no one.
4. Archive the old Lead only after the successor's first report is in. Record both ids and the
   handoff location in `.slp/status.md`.
5. Lessons: copy the old Lead's lessons into `.slp/notebook.md`. Do not patch the law or role
   files on the spot; adjusting immediately makes the next run unpredictable. Let a few sessions
   accumulate, then propose corrections.
