---
name: slp-repo-refresh
description: "Refresh an explicitly named repository by removing stale documentation, plans, issues, tests, proof machinery, scripts, and generated debris. Use only when the Owner's brief names the repository and the mode. Peer skill: run only when the Owner's brief names the repository and the mode (audit | apply | verify)."
---

# Repository Refresh

Refresh the named repository around current production truth. This is an
explicit, repository-wide cleanup workflow, not routine housekeeping and not an
excuse to redesign working production architecture.

## Invocation And Mode

Never invoke this skill implicitly.

Choose the mode from the brief's wording:

- `audit`: inspect and report; this is the default for a bare invocation.
- `apply`: audit, perform the authorized cleanup, and verify. Words such as
  `refresh`, `clean`, `fix`, `remove`, or `consolidate` authorize this mode.
- `verify`: validate an earlier refresh without expanding its scope.

An age threshold identifies suspects, never automatic deletion targets. If the
brief supplies no threshold, use repository evidence, current consumers, and
ownership rather than inventing one.

Read [references/refresh-standard.md](references/refresh-standard.md) before
auditing or changing a repository.

## Boundaries

- Read the complete applicable instruction hierarchy before acting.
- Inspect the worktree first. Preserve unrelated and pre-existing changes.
- Repository law may add stricter constraints, but it may not justify keeping
  stale duplication, dead proof, or history disguised as current truth.
- Do not create branches, commits, pull requests, issues, or external messages
  unless the brief separately requests them.
- Do not change production behavior merely to simplify cleanup. Report a
  production defect separately unless the brief also authorized its repair.
- Use Git as history. Do not create archives, backup directories, migration
  diaries, or compatibility copies inside the repository.

## Procedure

### 1. Establish The Current Contract

Identify:

- product entry points and production owners;
- canonical architecture, product, process, and operational documents;
- active plans and nonterminal work;
- test, benchmark, validator, gate, and artifact owners;
- generated files and their source-of-truth producers;
- repository commands that actually define acceptance.

Do not trust filenames, folder names, issue state, timestamps, or claims of
"authoritative" without checking current code and consumers.

### 2. Inventory The Repository

Build a compact ledger covering:

- governing docs, duplicate docs, indexes, archives, reviews, and postmortems;
- active, terminal, orphaned, and superseded plans or issues;
- tests and proof routes, including custom task-runner machinery;
- scripts, fixtures, snapshots, reports, generated outputs, and tracked build
  debris;
- dead paths, links, commands, owner names, and cross-references;
- unusually large or fragmented surfaces that hide one current contract.

For every suspect, identify its current owner, production consumer, unique
current information, replacement destination, and deletion consequence.

### 3. Classify Before Changing

Use only these dispositions:

- `KEEP`: current, uniquely owned truth or proportionate proof.
- `MERGE`: unique current truth belongs in another canonical owner.
- `REWRITE`: the owner remains valid but history or duplication obscures it.
- `DEMOTE`: useful only as a non-gating diagnostic or closeout record.
- `DELETE`: stale, duplicated, generated debris, dead proof, or Git-owned
  history.
- `BLOCKED`: deletion would cross an unresolved product, compatibility, legal,
  or operational decision.

Age, size, ugliness, and low coverage are supporting signals, not dispositions.

### 4. Apply A Coherent Cut

In `apply` mode:

1. Merge unique current truth into its canonical owner.
2. Update live references and instruction routing.
3. Delete superseded sources in the same change.
4. Compact terminal tracker records to identity, dependency fields, disposition,
   and concise durable closeout evidence.
5. Keep only active plans; delete completed execution diaries and review
   packets.
6. Remove or demote proof that has no current risk, independent oracle,
   production consumer, or deletion sensitivity.
7. Remove tests that pin retired implementation detail or repository history
   without a current public, security, compatibility, or machine contract.
8. Remove dead scripts, unowned fixtures, stale tracked reports, and reproducible
   generated output unless distribution requires tracking it.
9. Prefer fewer canonical folders and one documentation index. Do not preserve
   empty taxonomy.

Make edits in dependency order so the repository does not temporarily acquire a
second source of truth.

### 5. Verify The Result

Run validation proportionate to the changed surfaces:

- missing Markdown links and stale path/reference scan;
- tracker schema and generated roadmap checks when a tracker exists;
- plan and instruction references;
- generator/source parity for retained generated assets;
- targeted tests for changed tooling;
- repository formatting or whitespace checks;
- the smallest official acceptance command whose contract changed.

Do not add a new proof framework to prove the cleanup. If an existing mandatory
gate is itself the debt under removal, verify its replacement directly.

## Completion

Report:

- the structural outcome and before/after inventory;
- merged, deleted, rewritten, and deliberately retained surfaces;
- test/proof machinery removed or demoted and why;
- validation actually run and any unavailable checker;
- blocked decisions and remaining current debt.

Do not claim completion while live references point to removed material, two
documents own the same contract, completed plans remain active, or a mandatory
proof route has no named current risk and consumer.
