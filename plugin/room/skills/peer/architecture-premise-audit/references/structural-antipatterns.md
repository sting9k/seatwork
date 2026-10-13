# Structural Misfit And Avoidable-Tax Catalog

Use this catalog as search lenses, not a checklist that every design must satisfy.
Report only patterns supported by the bounded checkpoint.

## Causal mechanism

- **Wrong product category:** every module may be strong while the whole object
  behaves like a different class of product than the goal, workload, scale, latency,
  cost, or operating model calls for.
- **Imported realism or completeness:** the design perfects a capability mature
  systems deliberately omit, constrain, approximate, precompute, or move offline.
  The machinery proves that it can exist, not that the product should pay for it.
- **Mechanism-free claim:** the name promises an outcome but the required state or
  causal process does not exist. Examples include prediction without simulation or
  history, reconciliation without authoritative correction, lifecycle without an
  owning state machine, idempotency without identity/binding, and durability without
  a durable commit mechanism.
- **Homemade proxy for a mature mechanism:** a snap, timer, counter, retry, direct
  interpolation, or partial state copy is presented as prediction, navigation,
  admission, reconciliation, backpressure, or transactionality.
- **Information insufficiency:** the owner cannot compute its claimed output from
  the data it receives; callers or downstream consumers guess the missing facts.
- **Wrong archetype:** exact transactional work is modeled as latest state, rapidly
  supersedable state is journaled as exact work, keyed current state is stored as an
  append-only event queue, or eventual snapshots enforce a transition needing total
  ordering.

## Weak foundation accommodation

- A wrapper, adapter, cache, fallback, retry loop, ordering rule, or feature flag
  owns cancellation, invalidation, reset, synchronization, failure, or lifecycle
  semantics that the dependency should own.
- Feature code carries duplicate state or a parallel implementation solely to keep
  a dependency usable.
- A neighboring module exposes insufficient identity, admission, capacity,
  cancellation, typed output, or terminal semantics, forcing callers to reach into
  internals or reconstruct truth.
- A raw escape hatch, legacy path, test constructor, manual bootstrap, or fabricated
  accepted state remains the only complete route while the claimed production route
  is disconnected.
- A local workaround survives after the owning foundation can be repaired, so the
  accommodation becomes permanent architecture.

## Bent code shape

- Repeated special cases, mode flags, lossy translations, synthetic states treated
  as physical facts, collapsed error taxonomies, duplicated counters, or impossible
  state combinations exist to bridge incompatible owners.
- One module must know another module's private queue, timing, allocation, or reset
  behavior to remain correct.
- Cleanup, retry, polling, or timeout logic grows at callers because no owner exposes
  a complete terminal transition.
- A compatibility facade preserves an obsolete authority or lets callers bypass the
  new contract.
- Multiple layers convert the same semantic fact without adding information,
  isolation, ownership, or policy.
- An interface is nearly as complex as the implementation it hides, or deleting a
  pass-through layer removes complexity without forcing the responsibility into a
  real owner.
- A custom parallel pipeline fights a framework-native owner or toolchain, and later
  code pays synchronization or artifact-parity tax to keep both coherent.

## Avoidable taxes

- **Latency and ordering:** head-of-line blocking, global ordering for independent
  work, extra round trips, synchronous coordination, or reliable delivery for state
  whose older values are already obsolete.
- **Bandwidth and amplification:** duplicate carriers, catch-up bursts, redundant
  snapshots, full-state publication where bounded deltas/current state suffice, or
  per-client products that could be shared safely.
- **Hot-path cost:** per-tick allocation, repeated encoding/decoding, avoidable
  copies, scans proportional to total entities, locks across independent owners, or
  pathfinding/reconstruction at the wrong frequency. Performance work that mainly
  recovers overhead introduced by the abstraction is itself evidence of tax.
- **Buffering and failure:** unbounded queues, retry without terminal classification,
  overflow converted into session death, fallback with different semantics, or
  recovery that revives stale work.
- **Ownership and operations:** shadow authority, cross-module lifecycle coupling,
  deployment/process multiplication, hidden recovery state, hard-to-observe
  partial failure, or a larger blast radius than the product claim requires.
- **Migration and proof:** permanent dual paths, compatibility branches without an
  external constraint, tests that must duplicate implementation, evidence that
  cannot cross the production route, or validation cost inflated by abstraction.
- **Cognitive maintenance:** generic vocabulary hiding domain rules, many impossible
  states, configuration combinations with no product meaning, or a framework whose
  extension surface exceeds real use cases.

## Overengineering

- Generic framework, projection bank, plugin system, compatibility layer, or public
  abstraction exists before a real second use case requires it.
- A full state machine or schema advertises states the production runtime cannot
  produce or consume.
- Temporary scaffolding, parallel owners, or later-cleanup phases are planned where
  one coherent final-state change is available.
- Multiple services, queues, review artifacts, or coordination layers replace a
  direct owner call without adding a required isolation or scaling boundary.
- Exhaustive future-proofing, speculative failure taxonomies, or configurable
  policies obscure the one current product mechanism.
- The design models a capability perfectly where a hard constraint, authored table,
  bounded approximation, precomputation, or explicit product-scope omission would
  satisfy the real outcome.

## Local-excellence trap

Passing tests, polished modules, internal coherence, strong benchmarks, realism,
repo precedent, and a small diff do not establish archetype fit. Ask whether the
whole would still look strange if every local detail were excellent, which impressive
parts exist only to support the unusual macro choice, and what machinery disappears
under the boring route. Existing precedent may be accumulated drift rather than
evidence that the category is correct.

## Boundary and proof laundering

- Transport send, ACK, queue drain, connection state, timestamp adjacency, or log
  presence is treated as application acceptance, authoritative mutation, command
  completion, or player-visible outcome.
- Downstream code parses payloads, timing, logs, or counters to infer a typed semantic
  product the owner should publish directly.
- A mock, replica, fixture, source scan, compile success, or isolated green suite is
  cited for a production causal chain it never reaches.
- Components are individually green but no production entry connects them, or the
  real output bypasses the named authority/replication owner.

## Domain examples

- Client-side prediction normally needs local input application plus retained input
  or deterministic state needed for correction/resimulation. One position step at
  submit time is not the same mechanism.
- Reconciliation needs authoritative state/progress and a rule for correcting or
  replaying local prediction. Fabricating a partial authoritative record from an ACK
  is not equivalent.
- Server-authoritative click-to-move needs an owned navigation mechanism: validated
  destination plus path/corridor/support facts or another explicit authoritative
  route. Direct movement toward a target does not acquire those semantics by name.
- High-frequency supersedable movement usually benefits from sequenced latest-state
  delivery; exact commands usually require durable identity and typed outcomes.
  Departures may be valid, but their ordering, latency, bandwidth, and failure taxes
  must be named.
- Large multiplayer worlds normally predict the locally controlled actor and use
  authoritative snapshots with interpolation/extrapolation and interest management
  for remote actors. Full rollback or exact journals for every remote entity require
  a specific product justification.

## Exoneration

Return `BORING_STANDARD` or `JUSTIFIED_DEVIATION` when the production mechanism has
the required information and owner, the counterexample is handled, and any deviation
serves a named constraint at proportionate cost. Custom does not mean wrong, and
visible complexity is not overengineering when the domain itself requires it.
