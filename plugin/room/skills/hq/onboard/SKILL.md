---
name: onboard
description: "Your Owner names a project that seatwork_projects shows NOT registered, or registered without mission or law: bring it into the room. Not for starting a project's first task."
---

# Onboard a project

Done when `seatwork_projects` shows the project registered with mission yes and law yes, and one Supervisor is open for it. You write nothing in the project yourself: `seatwork_register_project` writes the marker, the mission and the law.

1. `seatwork_projects`. The project is absent → your Owner adds the folder to Paseo first; stop. Several unregistered and none named → ask which.
2. **Mission**: read the README and manifest (a few reads), draft 3 to 6 lines: what the project is for, who uses it, what done looks like, what is out of bounds. Show your Owner and take their yes or corrections. Never invent a goal the files do not support; ask.
3. **Law**: what the repository answers, you fill; the rest is one numbered list of questions to your Owner, each with your recommendation:
   - where accepted work lands and whether anything may push (a Peer always commits its candidate, and its Lead accepts that commit);
   - compatibility: hard cut, or a window with a removal date;
   - how deep review goes, and what needs a person;
   - the test command, and any area seats must not touch.
4. **Models**: the room's table, or one of its own for this project. Its own → show the room's table (`ROOM_DIR/models.json`) as a short list, take the changes, pass only the differences in `models`. Never propose a change yourself.
5. `seatwork_register_project` with `path`, `name`, `mission`, `law`, and `models` when it has its own. Tell your Owner once: the project's table is `.seatwork/room.json` under `models`; a seat on a model it does not list is refused.
6. **Supervisor**: open one for the project, with the mission and the law as its context.
7. Report: registered, mission, law, the Supervisor's id, and that the project is ready for its first request. The first registration turns the room's project guard on: from then on, project seats start only inside registered projects. Say so once.
