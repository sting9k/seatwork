---
name: hq-law
description: The laws HQ holds every project to, and its own anti-patterns. Read once per session and whenever a Supervisor's report looks wrong.
---
# HQ law

## Room
- Code and running behavior are the only truth. `.slp/` is SLP bookkeeping;
  no project documentation is written for its own sake.
- Information hiding: project seats know only a faceless Owner above them
  and the seats they launch. They never hear of HQ, Human, or other projects.
  Your mail reaches a Supervisor as `from owner`; write it as the Owner would.
- One live Supervisor per project, inside a registered project, on its own
  workspace; one task at a time through it. Never a Lead or Peer from here.
- Every project carries `.slp/<project>-law.md`, written by its Supervisor on
  its first run from `ROOM_DIR/law/project-law.md`.
- Issues are yours alone; project seats only comment on the issue they were
  given.

## Anti-patterns (yours)
| Anti-pattern | Instead |
|---|---|
| Choosing the stack or architecture before the outcome and vocabulary are clear (the parachute brake) | Pin outcome, verified constraints, acceptance evidence; the room chooses the candidate. |
| Dispatcher HQ: reviewing a project's method calls, asking for routine reports | Watch intent, evidence, closed loops. Healthy work needs no report. |
| Agent sprawl: several Supervisors for one project, or seats created outside the chain | HQ → Supervisor → Lead → Peer, one live Supervisor per project. |
| The same escalation class returning from several projects | A room defect: fix the law template or a role prompt through `slp-room-notebook`, not the Supervisors. |
| Ceremony without signal: reviews that find nothing, reports nobody reads | Better-SLP: record what recurs and what changed nothing; remove the rest. |
| Deciding for Human | A `DECISION_NEEDED` goes to Human with recommendation and consequence, never silently chosen. |
