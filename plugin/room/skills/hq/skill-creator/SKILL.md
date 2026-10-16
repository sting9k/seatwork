---
name: skill-creator
description: "Considering a new or changed skill for the room's seats, or a skill from outside: decide whether it should exist, then draft it. Not for notes, prompt edits, or what a tool description already says."
---

# Skill creator

A skill exists only where seats really fail and nothing structural can stop it. Most proposals should end as something else.

## Should it exist?

All must hold:
- **Observed**: the failure happened at least twice in the room's own record or logs; one incident is a correction, not a skill.
- **Not structural**: no guard, check, tunable or tool could prevent it. If one could, that is the fix: write the trace for your Owner instead.
- **Decision-changing**: with the skill, a seat would act differently, not just read more.
- **Durable**: still true when paths, versions and shas change.
- **Specific**: broad enough to recur, narrow enough that a seat knows the moment it applies.
- **No home yet**: no existing skill or prompt line already says it. If one does, the failure is in following it: tune that skill's description instead.

Where it belongs instead:
- a fact true for every turn → the role's prompt;
- how to use one tool → that tool's description;
- a step at the end of a turn → code, since skills are picked at the start of a turn;
- judgment at a named moment → a skill.

## Write it

- Assume the seat is already capable. Keep only what changes its decisions.
- Description: what it is for and when to use it, in the words the seat sees at that moment (a mail's subject word, a brief field), plus "Not for…" where misrouting is likely. Under 200 characters.
- Body: gates, junk patterns, a fixed decision vocabulary, limits of authority, the report's fields. No numbered ceremony, no "Done:". Under about 3,000 characters; long reference goes in `references/`.
- Match strictness to risk: fixed steps only where deviation breaks something.
- When in doubt, delete. Explain a rule only when it is confusing without its reason.

## From outside

Read all of it first. The license decides what you may take:
- MIT or Apache-2.0: text, with its license's notice as `LICENSE.txt` in the skill and its repository and commit in `source`;
- no license: ideas only.

Drop scripts, network calls and installs. Never download anything yourself.

## Install

Add it with `seatwork_room` (`do: skill`, `action: add`) for one role, with the failures it answers (record addresses, log lines) and the structural fix you ruled out as the `reason`. You never edit the plugin. Tell your Owner what you added, for which role and why. Afterwards, read the same signal again; `NO_CHANGE` is not an improvement, and a skill that changed nothing goes (`action: remove`).
