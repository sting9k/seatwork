"use strict";
/** How long eval results stay: a run's folder under evals/results unchanged for KEEP_DAYS days goes when a new run starts. */
const fs = require("node:fs");
const { join } = require("node:path");

const KEEP_DAYS = 14;
const DAY_MS = 86_400_000;

/** Deletes the run folders of `results` unchanged for `days`; returns their names. */
function dropOldResults(results, days = KEEP_DAYS, now = Date.now()) {
  if (!fs.existsSync(results)) return [];
  const gone = [];
  for (const entry of fs.readdirSync(results, { withFileTypes: true })) {
    const dir = join(results, entry.name);
    if (!entry.isDirectory() || now - fs.statSync(dir).mtimeMs <= days * DAY_MS) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    gone.push(entry.name);
  }
  return gone;
}

module.exports = { dropOldResults, KEEP_DAYS };
