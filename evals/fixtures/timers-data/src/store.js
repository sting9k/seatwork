// Loads the team's timer files. Each file under data/ is one timer; the duration is stored as text ("90m").
const fs = require("node:fs");
const path = require("node:path");
const { parseDuration } = require("./duration");

function loadTimers(dir = path.join(__dirname, "..", "data")) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const timer = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      return { name: timer.name, ms: parseDuration(timer.duration) };
    });
}

module.exports = { loadTimers };
