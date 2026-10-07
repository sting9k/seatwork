# <project> law

Project-specific rules, injected into every seat of this project. Short,
checkable, one bullet per rule. The room's invariants already live in the
role prompts; this file adds only what this project decides differently or
additionally. Nothing here changes who owns what.

## Policy
- Strictness: <production | side project>
- Review lane on a candidate: <one cross-family reviewer | two lenses | three or more lenses>
- Ultra review: <plan closure only | also before <boundary>>
- Compatibility: <hard cut, one live contract (`slp-hard-cut` applies) | compatibility window until <when>>
- External actions needing the Owner: <push, merge, deploy, ...>
- Models to prefer or avoid here: <none | ...>
- Lead context limit before handoff: <~45% of its window | ...>

## Local rules
- <files or boundaries that need one owner>
- <shared machine, if any: who may run heavy jobs or benchmarks, and how a free machine is
  verified before a measurement (a message is not evidence)>
- <the commands that define acceptance here, e.g. `make check`>
- <anything the Owner decided that every seat must know>
