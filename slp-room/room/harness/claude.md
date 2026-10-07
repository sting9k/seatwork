# Harness: Claude Code
- The room's tools are loaded already: `mcp__slp__slp_mail`, `mcp__slp__slp_inbox`, and the allowed Paseo tools as `mcp__paseo__<name>`. Call them by those names.
- Role skills are the `slp-*` entries of your Skill tool; load one when a procedure names it.
- `Agent`, `Task`, scheduling tools, and nested `claude`/`codex`/`pi`/`opencode`/`paseo` commands are denied in this runtime; a denial is the room's rule, not an error to work around.
