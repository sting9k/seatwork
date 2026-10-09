---
name: slp-feature-intake
description: "Intake lane decision for any requested work: tiny | normal | high-risk, with the hard gates that force high-risk and the design gate before implementation. HQ uses it when opening an issue; a Supervisor uses it when building the intent record."
---
# Feature intake

Choose the smallest lane that honestly covers blast radius, reversibility, uncertainty, and proof
weakness.

## Lanes
- **Tiny**: local, low-risk, reversible, directly verifiable. One Peer, patch directly, keep
  affected truth current.
- **Normal**: bounded owner and contract, local rollback, an honest validation route. The task or
  issue carries acceptance; no repository artifact unless truth or progress must survive the task.
- **High-risk**: material security, authorization, data, public-contract, migration,
  external-side-effect, runtime-boundary, cross-platform, or performance impact; irreversible
  state; broad uncertainty; weak proof; restart/handoff. Requires an active ExecPlan
  (`slp-exec-plan`) before implementation, and usually a multi-lens run or ultra review at closure.

## Hard gates (any one forces high-risk)
- material authentication, authorization, privacy, audit, or secret-handling change;
- data loss, irreversible migration, deletion, retention, replay, or recovery behavior;
- money, credentials, user-visible delivery, or non-idempotent external side effects;
- coordinated current-contract replacement or development-state reset/rebuild;
- a request to add backward compatibility, fallback, dual-read/write, shim, facade, legacy
  parser, read-time upgrade, migration path, or version branch in a hard-cut project → stop and
  surface it as `DECISION_NEEDED`; policy forbids it;
- material runtime owner-boundary, concurrency, lifecycle, or ordering change;
- weakening proof that protects a real security, data, contract, or external-system claim.

A label alone does not force the lane; material impact, irreversibility, uncertainty, or weak
proof does.

## Design gate
Before implementation, resolve any choice that materially changes ownership, public behavior,
safety, compatibility, data consequences, or another expensive-to-reverse direction. Record
constraints, meaningful alternatives, the decision, and likely failure modes. Do not prescribe
files, symbols, pseudocode, or private control flow. Human confirmation is required when the
requested behavior, destructive scope, or proof weakening remains materially ambiguous.

## Intake result (state it in the issue, the intent record, or the plan)
```text
Lane: tiny | normal | high-risk
Reason: [material reason]
Owners: [canonical docs/contracts]
Plan: [active plan or none]
Validation: [claim-shaped evidence]
```
