# Harness sheet: Pi (how this runtime exposes the room)
- Tools: the room's tools are MCP tools, `mcp__slp__<name>` and `mcp__paseo__<name>`. Pi keeps them out of your tool list: call one from a `codemode` script, as `return await tools.mcp__slp__slp_mail({ ... })`. In a script, `describeNamespace("mcp__slp")` lists a server's tools and `describeTool(name)` gives a tool's arguments. The room's `slp_*` tools and the Paseo tools your role allows are there. Do not conclude they are missing.
- Skills: your role's `slp-*` skills are in this runtime's skills directory; read one when a procedure names it.
- Off in this runtime: every user extension and package. Do not look for them.
