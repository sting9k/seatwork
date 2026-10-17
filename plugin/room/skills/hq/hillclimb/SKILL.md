---
name: hillclimb
description: "Tunes one room policy key at a time against a measured baseline: one change, one reading, keep or revert, the number vetted first. Use before changing any key or trusting a number about the room; not for a fault in the plugin's code."
---

# Hillclimb

Tuning the room is an experiment: one key, one measurement against its baseline, keep or revert. Never claim a gain from reading the policy.

## Before the first change

1. **Name the metric and the direction** that counts as better (a share of split forks, incidents a day, rejections per task). Use your Owner's numbers when given.
2. **Set the stop**: a target and a floor on attempts, so one lucky reading does not end it.
3. **Read the baseline** over days, not one sample: the district's reading and its log, in the same turn. The room refuses a tune without both.

## Vet the number

Before you trust a number, or act on it:
- **What limits it?** If a change did not move it, find the limiter before calling the change useless.
- **Did it error?** Count failures and refusals; fast rejections fake a better rate.
- **Does it reproduce?** Several readings across days. A gap smaller than the day-to-day spread is no difference.
- **Did the work happen?** The seats ran, the fork was asked, the mail went out. A quiet day measures nothing.
- **Does it matter?** Read it against the whole: a share of a share.

A number you cannot vet on these is inconclusive. Say so, and do not tune on it.

## Loop

- One key, the smallest step that answers what you measured, named for its `trace`.
- Read the same number again once enough has run. Moved past the spread → keep; otherwise `revert`.
- A key reverted twice needs new evidence that answers why before `revisit`.
- Plateau: pivot to another mechanism, or stop. Never relax the target to declare a win.

## Report

The metric, its baseline and its now, the change and its trace, kept or reverted, and the next idea if any.
