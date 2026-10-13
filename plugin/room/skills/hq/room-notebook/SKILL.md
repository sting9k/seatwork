---
name: room-notebook
description: "HQ procedure for the cross-workspace learning record: aggregate every project Supervisor's notebook, turn failures into patterns, and propose the narrowest protocol or skill correction. Every failure must become experience."
---
# Room notebook (HQ)

`ROOM_HOME/NOTEBOOK.md` is the durable cross-workspace learning record. Each project
Supervisor appends its own observations to `.seatwork/notebook.md` in its project; HQ aggregates.

Run when Human asks for a retrospective, when a Supervisor reports `DONE` on a workstream, or
with the weekly digest.

1. Read every registered project's `.seatwork/notebook.md` since the last aggregation (keep the date
   in the HQ notebook header).
2. `seatwork_room_stats` first, then the notebooks: many candidates and no reopen requests → the
   Peers obey, open the room for challenge; many reopen requests and no revised brief → the
   Peers perform dissent or the Leads defend plans, tie challenge to run evidence; reviews that
   never reject → the reviewer must justify its cost or go; seats sent back three times or more
   → Leads keep repairing where the round was the Owner's call. Aggregate by **pattern**, not by episode: tool calls that failed repeatedly, env or
   permission friction, quota exhaustion while a Lead waited, reviews that found nothing, the same
   escalation class recurring, lens runs that always agreed, Peers stopping to offer option menus,
   Leads pre-solving, Supervisors acting as dispatchers.
3. For each pattern record: evidence (project, date, agent id), cost (tokens, hours, wrong
   turns), and the **highest rung** that would remove it, strongest first:
   1. the room makes it impossible: a tool that refuses, a route, a tool a role does not get;
   2. the room checks it: a watcher rule, a tool's reply at the moment of the act;
   3. a project's law, or the law template;
   4. a skill, a role file or a model sheet.
   Rungs 1 and 2 hold whether or not a seat remembers; 3 and 4 hold while the text is read. A
   pattern that came back with a skill or a prompt line already in place goes up a rung: another
   sentence is the same rung again.
4. Propose, do not apply: list corrections for Human with the pattern they fix, the rung, and
   the risk of overcorrecting into the opposite anti-pattern (a Peer that always agrees vs one that always
   dissents). Changes to room files are applied only when Human says so, and evaluated on the next
   comparable workstream before being kept.
5. Append only novel or materially stronger evidence; never rewrite history. Keep the notebook
   under a few hundred lines by merging duplicates.
