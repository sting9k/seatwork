# Prompt evals

Each case opens one real `claude -p` session the way a seat opens: the prompt the plugin assembles from the room files (role, specialization sheet, harness sheet, project block), the role's skills, and two stand-in MCP servers (`slp` with the room's tools, `paseo` with the Paseo tools the role may use). The stand-ins answer every call plausibly and record it; nothing runs for real. The transcript is graded: the final message's first and last lines, which tools were called with what, and which were not.

```bash
node evals/run.cjs --label baseline
```

Options: `--only <regex>` picks cases by name, `--jobs 3` runs that many at once, `--budget 4` caps each run in dollars, `--timeout 20` in minutes, `--list` prints the runs without starting them.

Models come from `room/models.json`: a Peer case runs on the default, cheap and cross-family tiers, a lens case on the lens pair, the other roles on their seat's model. A Claude seat runs through `claude -p` with the prompt appended to the `claude_code` preset, as Paseo does. A Codex seat runs through `codex exec` on the runtime the plugin builds (`CODEX_HOME`, the user's config with its MCP servers and sub-agents stripped), the prompt as `developer_instructions`, the stand-in servers added with `-c mcp_servers.*` and pre-approved; its sandbox is `workspace-write` for a writable brief and `read-only` otherwise, where a real seat runs with full access. `--harness claude|codex` picks one side.

Results land in `evals/results/<label>/`: `report.md`, `summary.json`, and one folder per run with the system prompt, the prompt, every event, the stub's call log and the final message. The folder is ignored by git. `--regrade <label>` grades a label's saved transcripts again with the graders as they are now, for free.

What a run leaves out, compared with a real seat: the user's shared `CLAUDE.md`, Paseo's own permission flow (the run allows read-only shell commands and, where the case says so, edits), and real mail. A case fails when one of its graders fails; read the run's `final.md` and `calls.jsonl` before trusting a failure.

Cases live in `cases.cjs`; fixtures in `fixtures/`. Add a case when a rule in a role prompt or skill has no run that would catch its loss.
