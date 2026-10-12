# Harness sheet: Claude Code (how this runtime exposes the room)
- Tools: the room's `slp_*` tools and the Paseo tools your role allows are loaded already, as `mcp__slp__<name>` and `mcp__paseo__<name>`.
- Skills: your role's `slp-*` skills are entries of the Skill tool; load one when a procedure names it.
- Off in this runtime: `Agent`, `Task`, Claude's own scheduling tools, and nested `claude`/`codex`/`pi`/`opencode`/`paseo` commands. A denial is the room's rule, not an error to work around.
