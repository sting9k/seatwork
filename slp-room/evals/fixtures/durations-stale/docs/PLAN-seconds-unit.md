# Plan: seconds unit

Status: DONE, merged 2025-03-14.

## Day 1
- Tried a tokenizer, dropped it. Went with one regular expression.
- Wrote `test/duration.test.js`.

## Day 2
- Review round with K.: renamed `parse` to `parseDuration`.
- Benchmarked with `scripts/bench-legacy.sh`: 1.9M ops/s on the old laptop.

## Closeout
Everything above is in `src/duration.js` now.
