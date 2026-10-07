---
name: slp-portfolio-digest
description: HQ procedure for the cross-project digest Human asks for: one page per project from files first, then issues, then live agents; proposes the three most urgent lines.
---
# Portfolio digest (HQ)
1. `slp_projects` lists the projects; only the registered ones exist for you.
2. Per project read `.slp/mission.md`, `.slp/status.md` (`## Intent`, `## Room`, `## Health`),
   `.slp/notebook.md` tail, then `gh issue list --state open --limit 30` (or
   `issues/<project>.md` without a remote).
3. `~/.config/slp-room/registry-log.jsonl` and `list_agents` filtered by cwd: which Supervisor is
   alive, idle, running, or waiting on a permission.
4. Write `reports/<yyyy-mm-dd>-digest.md`: per project **usable now** · **open decisions** (who
   waits on Human) · **blocked** (why, owner) · **next step** · **health** (recurring patterns
   from the notebook). Then the three most urgent lines for Human.
5. Files first; mail a Supervisor only for a gap the files cannot answer.
