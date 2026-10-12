---
name: slp-peer-stall
description: "Lead procedure for a Peer silent past the stall threshold in your role prompt, or asking permission to sleep, poll or loop: status check, cancel and resume, archive and relaunch, and the answer to such a permission."
---
# A Peer that stalls (Lead)

A stall is silence past the threshold in your role prompt with no pending permission and no
long command running (`get_agent_status`, then `get_agent_activity` with a small limit). A
Peer that is reading, thinking, or running a test is working.

1. Mail a status check (`slp_mail`, `needs: reply`): where it is, what the next step is. End
   your turn; the answer wakes you.
2. Still silent → `cancel_agent`, then mail "resume from <its last recorded progress>".
3. Silent again → `archive_agent`, then relaunch the scope at the same tier with a brief that
   carries `What was tried: <tier>: <approach> → stalled twice at <point>`.
4. A permission request that contains sleep, ps, pgrep, or a loop → deny with "run once and
   stop": the Peer waits by ending its turn. A destructive or external permission → deny and
   `DECISION_NEEDED`.

Record each step in `.slp/status.md` under the Peer's loop.
