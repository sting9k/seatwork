---
name: slp-project-law
description: Supervisor procedure to create or revise the project's law (.slp/<project>-law.md) from the room template, by interviewing the Owner only for what the template leaves open: strictness, review lane, gates, compatibility policy, external actions, local rules. Per project, not global.
---
# Project law (Supervisor)

Every project carries `.slp/<project>-law.md`. The plugin injects it into the system prompt
of every seat of the project. The room's invariants already live in the role prompts; the law
holds only what this project decides differently or additionally, so keep it short (most
projects under 30 lines) and checkable. It adds rules; it cannot change who owns what.

1. Missing → copy `ROOM_DIR/law/project-law.md` to `.slp/<project>-law.md` and fill `## Policy`.
2. Interview the Owner, one topic per question, only for lines you cannot fill from the
   repository and the request: strictness; review lane on a candidate; when an ultra review or
   an ExecPlan is forced; hard cut or compatibility window; external actions that need the
   Owner; models to prefer or avoid; files or boundaries that need one owner; the commands that
   define acceptance here.
3. One bullet per rule, each checkable. No implementation detail, no project documentation.
4. Revise only from concrete friction recorded in `.slp/notebook.md`, with the Owner's yes;
   note version and date at the top. Never mid-workstream.
