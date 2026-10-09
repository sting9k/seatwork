// Parses a human-written duration ("90s", "5m", "2h") into milliseconds. Anything else throws.
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };

function parseDuration(text) {
  const match = /^(\d+)([smh])$/.exec(String(text).trim());
  if (!match) throw new Error(`cannot parse duration: ${text}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

module.exports = { parseDuration };
