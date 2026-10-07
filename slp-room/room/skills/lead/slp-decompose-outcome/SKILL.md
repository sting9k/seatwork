---
name: slp-decompose-outcome
description: Lead procedure to split an outcome into Peer tasks along real seams with one owner per write scope and the fewest intermediate states; decides the plan shape (task, ExecPlan, lenses, ultra review) from the intake lane.
---
# Decompose the outcome (Lead)
1. Restate outcome, constraints, and current candidate from your instruction; if you cannot tell
   which is which, `QUESTION` the Owner before planning. Confirm the lane
   (`slp-feature-intake`): high-risk → `slp-exec-plan` first; a contested design → `slp-lens` (three or more lenses)
   before binding it.
2. Find seams, not steps: write scopes verifiable on their own (module, layer, file batch) and the
   contracts between them (API shape, invariants, data ownership, error semantics, acceptance
   tests). Write contracts down before dispatch.
3. For every phase ask: "skip it and go straight to the end state — what breaks?" Only the plan's
   tidiness → delete the phase. Mark temporary things `TEMPORARY:` with a removal
   condition.
4. Size each task within the reading budget in your role (`wc -c`, bytes ÷ 4 ≈ tokens); over budget → split; unknown scope → one
   `[Peer:research]` first.
5. Tier per task from the provider table in your role; when unsure, lower. Parallel writers only with disjoint scopes
   and agreed contracts; otherwise sequence. Three to five live Peers is the healthy band.
6. Record the plan (tasks, tier, scope, dependencies, state) in `.slp/status.md` and your first
   report. Three or more tasks, or any expensive-tier task → one `[Lens] plan review` before launching (angle: missing or redundant tasks, write-scope overlap, tier
   misroutes, phases that only serve the plan's shape, risks; concrete changes or LGTM). Plan closure → `slp-ultra-review` when the gate says so.
