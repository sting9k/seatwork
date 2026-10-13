---
name: candidate-handoff
description: "Use as your last step before every CANDIDATE for work you wrote: it freezes the work as a commit or a patch with its sha and gives the fields the Owner checks before accepting (base, changed paths, what you ran and its result, what you did not run, residual risk, write ownership). A CANDIDATE without them comes back."
---
# Candidate handoff (Peer)
1. Freeze it: commit if the brief allows; otherwise `git diff --binary <base> -- <paths> >
   "$TMPDIR"/<slug>-<base>.patch` and `shasum` it.
2. First line `CANDIDATE: <one line of what is usable>`. Then: identity (sha), original base,
   complete changed paths, verification (environment, exact commands, actual results, last lines
   only), durable evidence locations, residual risk, untested scope, `write ownership: retained |
   relinquished`.
3. Every test you changed or deleted: one line each, why. Every `TEMPORARY:` marker: its removal
   condition.
4. Anything outside your scope → `Suggestions`, not the diff.
5. Keep it under 3,000 characters: results are last lines, a file is named by its path. End
   with `RECAP: <what you did> → <artifact>`; end your turn. Do not accept your own
   difficult change: the Owner decides.
