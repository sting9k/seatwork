#!/usr/bin/env node
"use strict";
/**
 * Evals for the room's roles: each case opens one seat in a real room on a stand-in Paseo, runs its agent CLI, and grades what it said, called and left.
 *   node evals/run.cjs --list                                   # the runs a label would make
 *   node evals/run.cjs --harness script --label check           # every case's scripted turn, no model: proves the cases and the harness
 *   node evals/run.cjs --spend --label baseline [--harness claude|codex] [--tiers default,cheap] [--effort high] [--only <regex>] [--jobs 2] [--budget 4] [--timeout 20]
 *   node evals/run.cjs --dry --label start [--harness claude|codex] # each seat started whole, its first model call kept and refused: what it is given, for free
 *   node evals/run.cjs --regrade baseline                       # grade saved outcomes again with the graders as they are now
 */
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { grade } = require("./graders.cjs");

const EVALS = __dirname;
const MODELS = JSON.parse(fs.readFileSync(resolve(EVALS, "..", "plugin", "room", "models.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const label = String(args.regrade ?? args.label ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
const OUT = join(EVALS, "results", label);
const short = (text) => createHash("sha1").update(text).digest("hex").slice(0, 8);
// what a seat can see is named after nothing: "evals" or a case's name in a path tells it that it is graded, and on what
const WORK = join(fs.realpathSync(tmpdir()), `sw-${short(OUT)}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

/** The runs of a case: the seat's model for a role with one, each tier's model for a Peer, one scripted turn for the script harness. */
function runsFor(c) {
  const common = {
    budget: Number(args.budget ?? 4),
    timeoutMs: Number(args.timeout ?? 20) * 60_000,
    effort: args.effort ?? null,
    spend: !!args.spend,
    dry: !!args.dry,
  };
  if (args.harness === "script" || args.harness === "wrong")
    return [{ ...common, harness: args.harness, model: null, thinking: null, name: args.harness }];
  const providers =
    c.role === "peer"
      ? String(args.tiers ?? "default")
          .split(",")
          .flatMap((tier) =>
            (MODELS.peer.tiers[tier]?.providers ?? []).map((provider) => ({
              provider,
              thinking: MODELS.peer.tiers[tier].thinking,
              tier,
            })),
          )
      : [{ provider: MODELS.seats[c.role].provider, thinking: MODELS.seats[c.role].thinking }];
  return providers
    .map(({ provider, thinking, tier }) => {
      const [id, model] = provider.split("/");
      return { ...common, harness: id.split("-")[0], model, thinking, name: `${tier ? `${tier}-` : ""}${model}` };
    })
    .filter((run) => !args.harness || run.harness === args.harness)
    .filter((run) => !c.harness || run.harness === c.harness);
}

/** One run in a process of its own; its outcome, or why it has none. */
function runOne(c, run) {
  const dir = join(OUT, `${c.name}--${run.name}`);
  const work = join(WORK, short(dir));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(EVALS, "seat-run.cjs"), c.name, JSON.stringify(run), dir, work], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => {
      fs.rmSync(work, { recursive: true, force: true });
      const file = join(dir, "outcome.json");
      if (fs.existsSync(file)) done(JSON.parse(fs.readFileSync(file, "utf8")));
      else
        done({
          case: c.name,
          run,
          passed: false,
          error: fs.existsSync(join(dir, "error.txt"))
            ? fs.readFileSync(join(dir, "error.txt"), "utf8")
            : `exit ${code}`,
          grades: [],
        });
    });
  });
}

/** The report of a label: each run with what failed and why, and the totals. */
function report(results) {
  const lines = [
    `# Evals: ${label}`,
    "",
    "| case | run | result | failed | cost | seconds |",
    "|---|---|---|---|---|---|",
  ];
  for (const one of results) {
    const failed = one.error
      ? `error: ${String(one.error).split("\n")[0].slice(0, 120)}`
      : [
          ...(one.finished ? [] : ["did not finish"]),
          ...one.grades.filter((g) => !g.ok).map((g) => `${g.label}: ${g.why}`),
        ].join("; ");
    // a wrong turn is meant to fail, and a dry one to start: each result says whether it did
    const result = one.run?.dry
      ? one.init
        ? "started"
        : "NOT STARTED"
      : one.run?.harness === "wrong"
        ? one.passed || one.error
          ? "MISSED"
          : "caught"
        : one.passed
          ? "pass"
          : "FAIL";
    lines.push(
      `| ${one.case} | ${one.run?.name ?? ""} | ${result} | ${failed.replace(/\|/g, "/")} | ${one.cost ?? ""} | ${one.seconds ?? ""} |`,
    );
  }
  const passed = results.filter((one) => one.passed).length;
  lines.push("", `${passed} of ${results.length} runs passed.`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(join(OUT, "report.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    join(OUT, "summary.json"),
    JSON.stringify(
      {
        label,
        passed,
        runs: results.length,
        results: results.map(({ case: name, run, passed: ok, cost }) => ({
          case: name,
          run: run?.name,
          passed: ok,
          cost,
        })),
      },
      null,
      2,
    ),
  );
  console.log(lines.slice(4).join("\n"));
}

/** Grades a label's saved outcomes again, with the cases' graders as they are now. */
function regrade() {
  const cases = require("./cases.cjs");
  const results = fs
    .readdirSync(OUT)
    .filter((name) => fs.existsSync(join(OUT, name, "outcome.json")))
    .map((name) => {
      const outcome = JSON.parse(fs.readFileSync(join(OUT, name, "outcome.json"), "utf8"));
      const c = cases.find((one) => one.name === outcome.case);
      if (!c) return { ...outcome, passed: false, error: "the case is gone" };
      outcome.grades = grade(c.grades, outcome);
      outcome.passed = outcome.finished && outcome.grades.every((one) => one.ok);
      fs.writeFileSync(join(OUT, name, "outcome.json"), JSON.stringify(outcome, null, 2));
      return outcome;
    });
  report(results);
}

async function main() {
  if (args.regrade) return regrade();
  const cases = require("./cases.cjs").filter((c) => !args.only || new RegExp(String(args.only)).test(c.name));
  const runs = cases.flatMap((c) => runsFor(c).map((run) => ({ c, run })));
  if (args.list) {
    for (const { c, run } of runs) console.log(`${c.name}\t${run.name}`);
    return;
  }
  if (!args.spend && !args.dry && runs.some(({ run }) => run.harness !== "script" && run.harness !== "wrong"))
    throw new Error(
      `${runs.length} runs on real agent CLIs cost money: add --spend once the owner has said so, or use --harness script`,
    );
  const results = [];
  const queue = [...runs];
  const jobs = Math.max(1, Number(args.jobs ?? 2));
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) results.push(await runOne(next.c, next.run));
    }),
  );
  results.sort((a, b) => `${a.case}${a.run?.name}`.localeCompare(`${b.case}${b.run?.name}`));
  report(results);
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
