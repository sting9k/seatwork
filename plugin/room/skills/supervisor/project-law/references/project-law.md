# <project> law

Project-specific rules, injected into every seat of this project. Short,
checkable, one bullet per rule. The room's invariants already live in the
role prompts; this file adds only what this project decides differently or
additionally. Nothing here changes who owns what.

## Policy
- Strictness: <production | side project>
- Review lane on a candidate: <one cross-family reviewer | two lenses | three or more lenses>
- Ultra review: <plan closure only | also before <boundary>>
- Compatibility: <hard cut, one live contract (`hard-cut` applies) | compatibility window until <when>>
- External actions needing the Owner: <push, merge, deploy, installing a tool or a browser, ...>
- Models to prefer or avoid here: <none | ...>
- Lead context limit before handoff: <~60% of its window | ...>
- Points the request leaves open: <the room decides the reversible ones by the Owner's stated
  principles and lists each in its reports | every one comes to the Owner before it is built>

## Local rules
- <files or boundaries that need one owner>
- <shared machine, if any: who may run heavy jobs or benchmarks, and how a free machine is
  verified before a measurement (a message is not evidence)>
- <the commands that define acceptance here, e.g. `make check`>
- <how the running product is checked here: the command, or the tool already on this machine
  (a headless browser, a simulator); none means a rendered check is reported `not checked`>
- <anything the Owner decided that every seat must know>
