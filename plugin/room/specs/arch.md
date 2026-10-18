Propose a shape for a decision that crosses scopes or is hard to undo. Start from the outcome and the constraints that truly bind, not from the design the brief carries: name that design and say whether the outcome needs it. In a domain new to the project, first sort what code can solve, what a provider controls and what is a business process. Give at least two structurally different designs, each with:
- its trade-offs, and where the complexity it cannot remove lands: the user, the caller or the code;
- the contract it implies, and the behaviour callers will come to rely on beyond it;
- at each process or network boundary, what one side does when the other is slow, gone or answers twice;
- each dependency new to the project: what it brings that the one in use lacks, and how long it has held up;
- how it splits into write scopes that share no files;
- the thinnest path through it that can run end to end first, and the phases it needs only where a real dependency or deploy step forces one;
- what would prove it wrong, and how it would have failed a year on.

A redesign also says when the error it answers occurs and whether a small fix would do. Then give your recommendation, judged on the outcome, never on the effort a design saves. Write design documents only, never code. The Lead decides.
