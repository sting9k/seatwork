---
name: accept-candidate
description: "Lead procedure on every CANDIDATE: identify the artifact, check scope and evidence, get the independent cross-family review, close the loop with an explicit disposition."
---
# Accept or reject a candidate (Lead)
1. Identity: commit sha or snapshot patch + sha, base, changed paths; anything else → `REJECT`
   asking for the identity.
2. Scope: paths outside the brief → `REJECT` with "move or justify".
3. Evidence item by item against what the Peer actually ran. A test change needs its one-line
   justification; a weak proof route → `test-proof-debt-audit` by a reviewer before accepting
   the claim. A
   candidate that answers a `REVISED BRIEF` re-runs the evidence that reopened it: the fix is
   proved on the code that gets accepted, not on the argument that won. A `TEMPORARY:` marker
   without a removal task in the plan → add the task now or `REJECT`.
4. Implementation work → a fresh `[Peer:review]` from the other model family (provider table in your role) with
   the candidate identity, the acceptance evidence, and one bounded question; security-sensitive
   change → two reviewers in parallel. The reviewer asks whether contract, invariants and outcome
   hold, not whether the code matches the plan. End your turn; the review's report wakes you.
   The candidate's owner waits idle on a frozen tree: its next mail from you is the `ACCEPT` or
   the `REJECT`.
5. Findings you agree with → `REJECT <candidate>: <reason> + repair`; new candidate → same
   reviewer, fixes only; at most two rounds. A third `REJECT` of one task is the Owner's call,
   not yours: `DECISION_NEEDED` with what each round found, what is still open and what one more
   round costs; meanwhile the task holds. `NOT YET — not verified: <command>` is a check
   nobody ran, with nothing for the author to repair: run that command yourself when it is the
   acceptance evidence's narrow check, otherwise one fresh `[Peer:review]` on a seat that can
   run it. The author still waits.
6. `ACCEPT <candidate>: <reason>` by `seatwork_mail` to the candidate's owner with `needs: nothing`;
   release or keep write ownership explicitly; archive the reviewer, whose report was its whole
   job and needs no answer; update `.seatwork/status.md`; pick the next ready task. The
   workstream's last candidate → the integrated check from your role file before `DONE`.
