---
name: seat-law
description: "Laws a model breaks by habit, at the decision each bites and where it stops holding; how to judge a breach. Use before an edit or a hand-in, a split or launch, a room change; not for style."
---

# Seat law

The room's 14 laws in your prompt are the floor, and the room checks them; nothing here repeats them. This page holds the trade's laws a model breaks by habit, at the decision where each bites. They are lenses, not rules: at a decision, name the few that bear on it and the ones that do not, and look for where the one you lean on stops holding. None widens your grant, and a check the code runs outranks judgment.

They bite a model for a model's reasons:
- the seat that reads your work next has none of your context;
- an API you recall is from training, not the version installed;
- a whole system comes out in one pass and runs once at the end;
- you copy the code around you, its hacks included;
- the cause you were told to look for is the one you find;
- whatever the room measures becomes what you optimize.

## Before you change code

| Law | Do | It stops holding when |
|---|---|---|
| The map is not the territory; leaky abstractions | Read and run the code before you change it or lock a contract on it. Take an API's behaviour from its source or a run at the pinned version: a brief, a doc and your memory only describe it | the file is one your change creates |
| Gall's law | Grow new work from the thinnest path that runs end to end, and run it before you widen it | the change is one function and its test |

## While you write

| Law | Do | It stops holding when |
|---|---|---|
| DRY | Search for the project's own helper, constant or format before you write one; each rule has one home | two pieces only look alike and answer to different rules |
| Least astonishment | Name, fail, log and default the way the project already does; a function does what its name says and nothing more | the project's way is the defect your brief fixes |
| Broken windows | A workaround, a hardcoded value or a skipped test you meet is debt, not a pattern: copy none of it | the brief asks for a throwaway spike |
| Murphy's law, fallacies of distributed computing | A call across a process or network boundary has a timeout and a failure its caller sees; retry only what a second try can pass, and bound it. Input from outside is checked where it enters | the call stays in one process and fails only on a bug |
| Knuth's optimization principle | Correct first; make fast only what a measurement or the brief shows is slow | the brief sets a speed target: design for it from the start |

## When you debug

| Law | Do | It stops holding when |
|---|---|---|
| Occam's razor | Rule out the plain causes first: config, path, version, a stale build, a typo, a missing label | each plain cause was read and ruled out: widen, testing the premise as law 5 says |

## Before you hand in

| Law | Do | It stops holding when |
|---|---|---|
| Ninety-ninety rule | The main path running is half the work; the edges, the failure paths and the integration are the rest: run them | the brief limits the work to the main path, and your report says so |
| Pesticide paradox | Tests you wrote pass because they share your understanding: try the inputs they lack (empty, huge, malformed, the boundary) | it is a regression suite guarding old faults: green there is good news, not a blind spot |

## When you run seats

| Law | Do | It stops holding when |
|---|---|---|
| Gall's law | Make the first issue the thinnest path that runs end to end toward the end state; the other scopes grow from what it proves. It is an order of work, not a smaller first version | the work changes one part of a system that already runs end to end |
| Conway's law | The split becomes the code's shape: cut write scopes along the seams the code should keep, never one module across two scopes | a throwaway spike whose shape nobody keeps |
| Amdahl's law, Little's law, Ringelmann effect | You are the serial part: every candidate waits on your judgment and every report costs your context. Run no more seats than you can judge as they return and read whole; past that, ask your Owner for a second team | read-only seats whose findings you sort together rather than judge one by one |
| Brooks's law | A late or stuck scope gets no second seat: the newcomer needs your briefing and collides with the first. Replace the seat or cut the scope; spend capacity to spare on an independent check | what is left splits into scopes that share no files |
| Linus's law | More reviewers find more only when they look differently: split the ground between them (the contract and its callers; the edges and the failure paths) rather than give two the same read | one careful read covers the change |
| Pareto principle | Spend review depth where the risk is: the scope others build on, the choice that is hard to undo | the risk is even, as in a mechanical rename |
| Goodhart's law, Gilb's law | Whatever you judge seats by becomes their target: write acceptance evidence that only the outcome passes, one a stub, a hardcoded answer or a narrowed case fails. A goal like faster, smaller or steadier goes in as a number with how it is measured, beside what must not change | the check is the outcome itself: the user's path, run |

## When you measure or change the room

| Law | Do | It stops holding when |
|---|---|---|
| Goodhart's law, cobra effect | A number you steer by stops measuring the outcome: ask what gaming it looks like, and whether that leaves things worse than no change | the number is the outcome itself |
| Law of unintended consequences | A rule against one act gets the next act in its place: before a change holds, name what seats will do instead, and what that costs | the breach is one seat's, once: that is a correction to the seat |
| Gall's law, Lehman's laws, KISS | One change at a time, measured against its baseline, and said in one sentence; a new rule, label, check or round names the one it replaces, or the turns it saves | the change removes a rule |

## Judge

1. Name the law and quote the tell from the evidence (`path:line`, a command and its exit code, a mail id). For the room's 14 laws, the tells, the innocent readings, the severity and what already checks each are in [references/room-law.md](references/room-law.md).
2. Rule out the innocent reading first, with evidence, not with the seat's word: a misread brief explains more breaches than gaming does (Hanlon's razor), and a room that makes the wrong act the easy one is the room's fault, not the seat's.
3. Close it as one of: **verified** (the evidence shows the breach and its effect) · **dismissed** (innocent, unreachable, or immaterial) · **unverified risk** (what is known, what is missing, the one check that would settle it).
4. A verified breach goes to the seat as one sentence of what to fix, through its Owner; if code could have caught it, say which check would have.

Judge the turn, not the model: one breach is a correction, a pattern across seats is friction for the room.
