---
name: slp-write-brief
description: "Lead procedure to write a Peer or Lens brief that locks the contract and leaves the implementation to its owner: the template, the contract checklist, the read-only suffix, the tier and retry rules, the create_agent call, and how a REVISED BRIEF is sent. Use before every launch and every retry. The template and a filled example are in references/brief-template.md."
---
# Write the brief (Lead)
1. Fill the template in [references/brief-template.md](references/brief-template.md): Project,
   Outcome, Candidate, Context (paths and `RECAP` lines, never contents), Write scope,
   Contract / invariants, Yours to decide, Constraints, Output, Acceptance evidence, Reopen
   when, What was tried (on any retry), and the last line `Reply with slp_mail to: owner`. The
   file ends with a filled example and what it deliberately leaves out.
2. Lock only what other components depend on: what the API promises, valid inputs, what success
   means, state and data ownership, how errors show, the test that proves it. Enough when two
   Peers reading it would build parts that fit: where words could be read two ways, give one
   example input → output or the test's name. Too much when it names anything inside one scope:
   a line that says create, call, or use a variable inside the Peer's scope goes; a plan that
   names symbols before anyone opened the code is implementing in markdown. If you cannot write
   acceptance evidence, split or research first.
3. `Outcome` is the real need, never a technology; `Candidate` is the solution currently tried,
   marked changeable, so the Peer may come back with evidence: "ensure the browser gets call
   state with these latency/order/reconnect semantics" is the outcome, "WebSocket" the candidate.
   `Reopen when` names a result the Peer can observe and the briefed route does not produce: an
   acceptance check that cannot pass, a contract line that proves false, a change needed outside
   the write scope. Read it against your own plan before sending: when doing the task as briefed
   makes it true, rewrite it, and name an inherited line you rewrote in your report.
4. Writable briefs forbid stopping to offer a menu of implementation options: the owner decides
   inside its scope; a genuinely cross-boundary decision may be asked as one short, concrete
   yes/no question, never as an option-selection ritual.
5. Read-only briefs say `read-only — do not modify files` in Write scope, use `[Peer:review]` or
   `[Peer:research]` (a lens is its own seat: `[Lens]`, see `slp-lens`), and end with the
   read-only suffix from the template file, verbatim. In a `[Peer:review]` brief `Candidate:` is
   the sha or snapshot hash with its base, `Contract / invariants` and `Acceptance evidence` are
   the author's lines unchanged, and `Output:` is `REVIEW in the review specialization's shape`;
   a term the author never received goes to the author first, as a `REVISED BRIEF`.
6. Tier from the provider table in your role; unsure → the lower tier, and size alone keeps
   the tier. Up one tier only after a same-tier retry with a sharper brief failed for a
   capability reason (wrong reasoning, broken invariants, lost the thread). Missing context,
   vague acceptance, too big, or a permission block → fix the brief or split, same tier. An
   expensive-tier capability failure, or three non-capability failures at one tier →
   `slp-lens` with three or more lenses. Every retry carries `What was tried`.
7. `create_agent` with `title`, `provider` from your role's table, `settings.modeId`,
   `settings.thinkingOptionId`, `initialPrompt`, `notifyOnFinish: false`; `workspaceId` only
   when two writers must run at once (a worktree each, `create_workspace`); leave `cwd` and
   `background` unset. Then continue unrelated ready work or end your turn; the Peer's report
   wakes you.
8. A `REVISED BRIEF` is the whole brief again with the changed lines marked, sent as one mail
   (`reply_to` the Peer's signal, or `to` its id): the Peer reads one document, not a thread
   of patches.
