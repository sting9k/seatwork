---
name: friction
description: "A WAKE you set, or a sign the room is working badly (rework, loops, stalls, piled rejections, seats colliding): find the friction, name its class with evidence, propose the smallest correction. Not for judging a single candidate."
---

# Friction

Friction is cost the work did not need. You find it in what happened (seats, issues, commits, mail, the record), never in what a seat says about itself, and you propose one correction at a time.

## Look

- `seatwork_seats`: a seat at rest with work open, context near the line, rejections climbing, mail owed and unanswered.
- `seatwork_graph` `alerts`: an issue held and untouched, one holding many back, issues waiting on each other.
- Closed issues and commits since your last wake: is anything moving?
- The mail of seats under you: the same question twice, a challenge raised again, a brief revised again and again.
- The record (`seatwork_knowledge`): what was tried before on the same task.

## Classes

| Class | Shape |
|---|---|
| `LOOP` | the same action, error or rejection again with nothing new |
| `STALL` | work open, nobody running, nobody asked |
| `REWORK` | an accepted task reopened, or a candidate rejected twice for the same kind of finding |
| `COLLISION` | two seats writing the same files, or one task briefed twice |
| `CONTRADICTION` | two instructions in force that cannot both hold (brief and decision, two briefs) |
| `GAP` | something the work needs that nobody owns |
| `AUTHORITY_LEAK` | a seat deciding what is not its to decide, or a correction applied around its Lead |
| `GHOST_CAPABILITY` | a brief asks for something the seat cannot do (a tool, a permission, a spec) |
| `RESULT_OPACITY` | a report its reader cannot act on without the transcript |
| `CEREMONY` | turns, mail or review rounds that changed no outcome |
| `LAW` | a seat broke the law (`seat-law`) |

## Close each candidate

- **Reachable, not representable.** Show it happened, not that it could.
- **Verified**, **dismissed** (with why), or **unverified risk** (what is missing, the one check that settles it).
- Count it only when you see the same class twice; once is a correction for one seat, not friction.

## Correct

Fix at the highest level that works, and say which one you chose:

1. **Structure**: something code could stop (a guard, a check, a tunable) → to HQ through your Owner, with the trace.
2. **The brief or the plan**: a wrong scope, a missing contract, a collision → to the Lead, with the evidence and the change.
3. **The seat**: a one-off breach → to its Lead, as one sentence of what to fix.
4. **Words**: a new rule in a prompt or a skill, last, and only for a judgment call nothing can enforce.

One correction at a time. Read the same signal again before you call it fixed; no change is not an improvement.

## Report

Under `STATUS`: each friction with its class, evidence and correction, what changed since the last one, and what is still open.
