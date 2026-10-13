# Prompt evals

Each case opens one real `claude -p` session the way a seat opens: the prompt the plugin assembles from the room files (the room's system prompt for that agent CLI, role, specialization sheet, project block), the role's skills, and two stand-in MCP servers (`seatwork` with the room's tools, `paseo` with the Paseo tools the role may use). The stand-ins answer every call plausibly and record it; nothing runs for real. The transcript is graded: the final message's first and last lines, which tools were called with what, and which were not.

```bash
node evals/run.cjs --label baseline
```

Options: `--only <regex>` picks cases by name, `--jobs 3` runs that many at once, `--budget 4` caps each run in dollars, `--timeout 20` in minutes, `--list` prints the runs without starting them.

Models come from `room/models.json`: a Peer case runs on the default, cheap and cross-family tiers, a lens case on the two lens tiers a pair is made of (`high` and `extra`), the other roles on their seat's model. A Claude seat runs through `claude -p` with the prompt appended to the `claude_code` preset, as Paseo does. A Codex seat runs through `codex exec` on the runtime the plugin builds (`CODEX_HOME`, the user's config with its MCP servers and sub-agents stripped), the prompt as `developer_instructions`, the stand-in servers added with `-c mcp_servers.*` and pre-approved; its sandbox is `workspace-write` for a writable brief and `read-only` otherwise, where a real seat runs with full access. `--harness claude|codex` picks one side, `--tiers default,cheap` picks the Peer tiers, and `--effort high` runs every seat at that thinking level.

Results land in `evals/results/<label>/`: `report.md`, `summary.json`, and one folder per run with the system prompt, the prompt, every event, the stub's call log, the final message and `cwd/`, what the seat left in its directory. The folder is ignored by git. `--regrade <label>` grades a label's saved transcripts again with the graders as they are now, for free.

The seat itself works somewhere else: every path it can see (its directory, its skills, the room home) is under the system's temporary directory with a name that says nothing, `sw-<hash>/work-<hash>`. A seat that reads "evals" or the case's name in a path knows it is being graded, and on what.

What a run leaves out, compared with a real seat: the user's shared `CLAUDE.md`, Paseo's own permission flow (a case that may edit runs in the real seat's permission mode, `modes.claude` in `room/models.json`, so the room's procedures can write through the shell as they do in a room; every other case is held to read-only shell commands), and real mail. A case fails when one of its graders fails; read the run's `final.md` and `calls.jsonl` before trusting a failure.

Cases live in `cases.cjs`; fixtures in `fixtures/`. A case may hand the stand-ins a state (`state`): agents that already exist, a project registry, or the model table in force when it is newer than the seat's prompt (`state.table`), in which case `create_agent` refuses a model the table does not list, in the plugin's words. A case may refuse its seat some tools (`deny`, added to the role's denied tools) and may name the one harness it means anything on (`harness`). Add a case when a rule in a role prompt or skill has no run that would catch its loss.

## Before a case or an edit is trusted

- **Red first.** A new case is run once against a room without the rule it guards (`--room-from <a copy of the room before the edit>`). A case that passes there cannot fail, and proves nothing.
- **Same cases, before and after.** A prompt or skill edit is one group of changes, run on the cases that touch it, more than once: a seat that passes three in four passes three in a row less than half the time.
- **Read a transcript.** A pass says the graders were satisfied. Open `final.md` and `calls.jsonl` of a few runs before believing the number.
