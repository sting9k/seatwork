# Harness sheet: Pi (how this runtime exposes the room)
- Tools: the room's tools come through the `pi-mcp-adapter`. Use its `mcp` tool to search for `slp` and `paseo`, then call what it lists under the names it shows (they may carry a server prefix). The room's `slp_*` tools and the Paseo tools your role allows are there. Do not conclude they are missing.
- Skills: your role's `slp-*` skills are in this runtime's skills directory; read one when a procedure names it.
- Off in this runtime: every user extension and package except the adapter. Do not look for them.
