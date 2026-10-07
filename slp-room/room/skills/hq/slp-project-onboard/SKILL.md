---
name: slp-project-onboard
description: HQ procedure to bring a project Human added to Paseo into the room: registry line, mission, law, first Supervisor. Use when Human names a project that slp_projects shows as NOT registered, or as registered without mission or law.
---
# Project onboarding (HQ)

Done means: `slp_projects` shows the project registered, mission yes, law yes,
and one idle Supervisor exists for it. You write nothing in the project
yourself; the tool writes the marker and the mission, the Supervisor writes
the law.

1. `slp_projects`. Project absent → tell Human to add the directory to Paseo,
   stop. Several unregistered and Human named none → ask which.
2. Mission. Read the project's README and manifest (at most 3 reads), draft
   3–6 lines: what the project is for, who uses it, what done looks like, what
   is out of bounds. Show the draft to Human, ask for a yes or corrections.
   Never invent a goal the files do not support; ask instead.
3. Models. Ask Human one question: the room's table, or a table of its own
   for this project. Room's table → pass no `models`. Its own → read
   `ROOM_DIR/models.json`, show it as a short list (Supervisor, Lead, each
   Peer tier, the lenses, with model and thinking), take the changes, and
   build `models` holding only the differences, same shape (`null` removes a
   tier). Only seats the room has enabled can be named; the tool refuses
   anything else and says why. Never propose a change yourself.
4. `slp_register_project(path, name, mission, models)`. Tell Human once: the
   table lives in `<project>/.slp/room.json` under `models`; later changes are
   made by hand there and apply to the next seat created, no reinstall; a
   seat on a model the table does not list is refused.
5. Law. Open the project's Supervisor as in your Loop step 2, with this task:

   ```text
   Outcome: this project's law exists and is agreed.
   Do: slp-project-law. Fill what the repository answers; send every line you
   cannot fill as ONE DECISION_NEEDED listing the questions with your
   recommendation for each. Launch nobody. No code change.
   Acceptance evidence: .slp/<project>-law.md exists, every Policy line filled.
   ```

6. Its `DECISION_NEEDED` → put the questions to Human with the
   recommendations, send the answers back with `reply_to`. Its `DONE` →
   `slp_projects` again; report to Human: registered, mission, law, the
   Supervisor's id, and that the project is ready for its first task.

The first registration turns the room's project guard on: from then on project
seats start only inside registered projects. Say so to Human once.
