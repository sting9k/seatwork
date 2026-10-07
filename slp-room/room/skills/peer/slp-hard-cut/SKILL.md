---
name: slp-hard-cut
description: Peer discipline for contract or schema changes in a project whose law declares hard-cut policy (no backward compatibility, one live contract). Also the test discipline that goes with it.
---
# Hard cut and test discipline (Peer)

Apply when the project law (in your system prompt) or your brief declares a hard-cut
policy. Otherwise the project's own compatibility rules govern; ask with `QUESTION` if unclear.

## Hard cut rules
- Keep exactly one live contract and implementation path. Breaking changes are mandatory when
  the current design changes; legacy versions are unsupported.
- Do not add dual-read, dual-write, version branches, shims, facades, adapters for old shapes,
  legacy parsers, read-time upgrades, migration behavior, or fallback implementations. Reset or
  rebuild development state instead of migrating it.
- Keep the protocol/schema version at `1` until first public shipment; replace its content
  instead of introducing v2/v3.
- Fail fast and fail closed: a failed current path does not activate alternate semantics.
- **Sync or die**: update every current shipping producer, consumer, and generated artifact that
  the product or toolchain consumes, in the same change. Reports, snapshots, mocks, and proof
  output are not synchronization peers merely because the repository owns them.
- Compare the least-painful patch with the long-lived owner-clean route; reject the patch unless
  a bounded constraint and a removal condition are recorded in-repo (`TEMPORARY:` marker).

## Test discipline
- Tests protect a settled production contract; they do not choose architecture, invent owners,
  or justify a production seam. Test-first RED/GREEN only for deterministic behavior whose
  contract and owner are already decided.
- Do not add or retain production APIs, state, lifecycle branches, dependency features, or
  instrumentation whose only consumer is a test or proof harness.
- After every schema or protocol cut, audit every added or modified test and fixture. Negative
  cases derive invalid inputs from current constants and boundaries (`WIDTH - 1`, `WIDTH + 1`),
  never from deleted fields, tags, widths, values, or versions.
- Use the diff to discover removed identifiers and literals, then search current code, tests,
  and fixtures for them. Never commit a legacy blacklist, tombstone registry, or
  source-substring gate. A cut cannot close while historical names or literals remain.
- Ask whether each test remains meaningful without Git history; delete or rewrite one that only
  proves a dead contract is rejected, and remove any production surface that exists only to
  make that observable.
- Prefer outcome-level tests at the owning boundary. A fixture that constructs a parallel
  runtime model proves only the fixture and must not gate the production implementation.

Report every deleted test with one line of reason in your `CANDIDATE`.
