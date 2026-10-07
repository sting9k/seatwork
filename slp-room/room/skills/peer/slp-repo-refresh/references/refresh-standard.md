# Repository Refresh Standard

This standard takes the strongest useful lessons from the NOVA cleanup and makes
them the default baseline for every refreshed repository.

## Current Truth

- Current documents describe the current system. Git owns narrative history.
- One contract has one canonical owner. Other documents link to it rather than
  restating it.
- Use one documentation index. Avoid indexes of indexes.
- Keep folders only when they express a durable ownership boundary with multiple
  current documents.
- Do not keep `archive/`, `completed/`, `review/`, `packet/`, `old/`, or
  `postmortem/` collections by default. Retain a postmortem only when it remains
  an active operational control or legally required record.
- Merge current facts before deleting their stale containers.
- A document modified before a user-supplied date is presumed suspect, not
  presumed disposable.

## Default Documentation Shape

Prefer the smallest subset that fits:

- `docs/architecture/`: stable system owners and boundaries;
- `docs/product/`: externally observable product contracts;
- `docs/process/`: current development, evidence, release, and operating law;
- `docs/plans/`: active decision or execution authority only;
- `docs/issues/`: the configured local tracker, if one exists;
- `docs/templates/`: templates that a current tool or workflow consumes.

Do not force these names over an equally coherent existing structure. Do remove
parallel doctrine, contract, observability, project, agent, and miscellaneous
trees when their content belongs to the canonical owners above.

## Plans And Trackers

- Plans are temporary execution authority, not permanent historical records.
- Delete completed and superseded plans after durable current decisions reach
  their owner docs.
- Nonterminal issues must have a current premise, owner, consumer, and completion
  condition.
- Terminal issues retain stable identity and dependency fields plus a compact
  closeout or not-pursuing reason. Delete diaries, review transcripts, stale
  artifact paths, and deleted-plan references.
- Generated roadmaps are views, never independent truth.

## Tests And Proof

A retained mandatory proof route must name:

1. the current risk;
2. the production behavior or machine contract;
3. the current consumer;
4. an observation capable of failing when the behavior disappears;
5. an oracle independent enough not to reproduce the implementation;
6. the reason cheaper ordinary testing is insufficient.

Delete, replace, or demote machinery that:

- checks source text, metadata, filenames, or artifact presence as a proxy for
  runtime behavior;
- pins retired values solely to prove their retirement;
- reproduces production logic in a mock, simulator, or validator and proves only
  the replica;
- runs broad expensive workflows for a narrow local risk;
- exists because an earlier issue demanded evidence, but protects no current
  contract;
- duplicates compiler, type-system, linter, framework, or ordinary unit-test
  guarantees;
- cannot fail under a credible removal of the claimed behavior;
- produces large retained reports that no current release or operator consumes.

Keep historical compatibility vectors only when the old value remains a current
public, security, wire, storage, migration, or machine contract.

## Strong Cleanup Rules

- Prefer deletion over deprecation inside a single-owner repository.
- Do not leave forwarding documents for renamed internal paths; update callers.
- Do not create a debt register to excuse debt that can be removed now.
- Do not retain a mechanism because deleting it would make an old proof fail.
- Do not create new abstractions merely to preserve a stale interface.
- Empty folders, obsolete taxonomy, dead commands, and reproducible reports are
  cleanup failures, not harmless residue.
- When uncertain, preserve unique current truth but delete redundant narrative.

## Evidence For The Refresh

The refresh itself needs only proportionate verification:

- references resolve;
- canonical owners are unique;
- retained tracker and plan schemas are valid;
- changed tooling tests pass;
- generated material matches its producer where tracking is intentional;
- official acceptance still exercises the contracts affected by cleanup.

Line-count reduction is useful reporting, not proof of correctness. A smaller
repository is successful only when it retains every current product, operational,
compatibility, security, and contributor contract.
