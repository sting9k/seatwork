---
name: slp-write-brief
description: Lead procedure to write a Peer brief that locks the contract and leaves implementation to the Peer: the initialPrompt shape, the no-option-menu rule, the read-only suffix, and the create_agent call.
---
# Write the brief (Lead)
1. Fill the template from your role file: Project, Outcome, Context (paths and `RECAP` lines,
   never contents), Write scope, Contract / invariants, Yours to decide, Constraints, Output, Acceptance
   evidence, Reopen when, What was tried (on any retry), and the last line
   `Reply with slp_mail to: owner`.
2. Lock only what other components depend on: what the API promises, valid inputs, what success
   means, state and data ownership, how errors show, the test that proves it. Enough when two
   Peers reading it would build parts that fit: where words could be read two ways, give one
   example input → output or the test's name. Too much when it names anything inside one scope:
   a line that says create, call, or use a variable inside the Peer's scope goes; a plan that
   names symbols before anyone opened the code is implementing in markdown. If you cannot write
   acceptance evidence, split or research first.
3. State the real need and the current candidate separately so the Peer may come back with
   evidence: "ensure the browser gets call state with these latency/order/reconnect semantics;
   WebSocket is the candidate".
4. Writable briefs forbid stopping to offer a menu of implementation options: the owner decides
   inside its scope; a genuinely cross-boundary decision may be asked as one short, concrete
   yes/no question, never as an option-selection ritual.
5. Read-only briefs say "read-only — do not modify files", use `[Peer:review]` or
   `[Peer:research]` (a lens is its own seat: `[Lens]`, see `slp-lens`), and end with the read-only suffix from your role file
   verbatim.
6. `create_agent` with `title`, `provider` from your role's table, `settings`, `initialPrompt`,
   `notifyOnFinish: false`; no `cwd`, no `background`. Then continue unrelated ready work or end
   your turn; the Peer's mail wakes you.
