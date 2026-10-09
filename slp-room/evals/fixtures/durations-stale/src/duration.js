// Parses a human-written duration ("90s", "5m") into milliseconds. Anything else throws.
function parseDuration(text) {
  const match = /^(\d+)([sm])$/.exec(String(text).trim());
  if (!match) throw new Error(`cannot parse duration: ${text}`);
  const count = Number(match[1]);
  return match[2] === "s" ? count * 1000 : count * 60_000;
}

module.exports = { parseDuration };
