---
name: project-law
description: "Supervisor procedure to create or revise the project's law (.seatwork/<project>-law.md) from the room template, by interviewing the Owner only for what the template leaves open: strictness, review lane, gates, compatibility policy, external actions, local rules. Per project, not global."
---
# Project law (Supervisor)

Every project carries `.seatwork/<project>-law.md`. The plugin injects it into the system prompt
of every seat of the project. The room's invariants already live in the role prompts; the law
holds only what this project decides differently or additionally, so keep it short (most
projects under 30 lines) and checkable. It adds rules; it cannot change who owns what.

1. Missing → copy [references/project-law.md](references/project-law.md) to `.seatwork/<project>-law.md` and fill `## Policy`.
2. Interview the Owner, one topic per question, only for lines you cannot fill from the
   repository and the request: strictness; review lane on a candidate; when an ultra review or
   an ExecPlan is forced; hard cut or compatibility window; external actions that need the
   Owner; models to prefer or avoid; files or boundaries that need one owner; the commands that
   define acceptance here; how the running product is checked and with which tool already on
   the machine.
3. One bullet per rule, each checkable. No implementation detail, no project documentation.
4. Revise only from concrete friction recorded in `.seatwork/notebook.md`, with the Owner's yes;
   note version and date at the top. Never mid-workstream.
