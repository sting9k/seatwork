---
name: evidence-report
description: "Use before you write a REVIEW or a research answer when your prompt carries no specialization sheet (a scout, a plain read-only Peer): the report's shape, what counts as proof of behavior, and the conditions a measured number needs. Peer skill."
---
# Evidence report (Peer)
1. Four lists, each under its own heading: **verified** (`path:line`, command with its last
   lines, or document) · **untested** (what you did not run and why) · **failed** (exact
   output, last lines) · **unknown** (what would have to be true, and what would settle it).
2. Proof of behavior is behavior observed: a transport send, an ACK, a log line, or a green
   suite proves the mechanism it touched, not the application behavior the claim is about.
3. A before/after number is evidence only with its conditions beside it: measured the same
   way, with the same workload, on a machine you checked was idle (a message that it is free
   is not a check).
4. Where the brief names a solution, say whether the evidence supports it, without optimizing
   it.
5. Stay within the brief's budget (default ~2k tokens).
