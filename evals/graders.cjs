"use strict";
/** How a run is graded: each grader reads the run's outcome (the seat's final message, its calls, the room after the turn, the project after the turn) and says whether its rule held. */

const SHELL = new Set(["Bash", "shell", "exec_command"]);

/** The value under a dotted path of an object; undefined where a step is missing. */
const at = (value, path) => path.split(".").reduce((one, key) => (one == null ? undefined : one[key]), value);

/** Whether a call's input holds every entry of `where`: a RegExp is matched against the text of the value, anything else compared as JSON. */
function holds(input, where = {}) {
  return Object.entries(where).every(([path, wanted]) => {
    const value = at(input, path);
    if (wanted instanceof RegExp)
      return value !== undefined && wanted.test(typeof value === "string" ? value : JSON.stringify(value));
    return JSON.stringify(value) === JSON.stringify(wanted);
  });
}

/** A tool's calls in a run: `tool` is the room's or Paseo's name, as the seat's harness spelled it or bare. */
const callsOf = (outcome, tool) =>
  outcome.calls.filter(
    (call) => call.name === tool || call.name.endsWith(`__${tool}`) || call.name.endsWith(`.${tool}`),
  );

/** The shell commands a run made. */
const commands = (outcome) =>
  outcome.calls
    .filter((call) => SHELL.has(call.name))
    .map((call) => String(call.input?.command ?? call.input?.cmd ?? ""));

const firstLine = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")[0] ?? "";

/** The graders a case may list; each returns `{ ok, why }`. */
const GRADERS = {
  first: (g, o) => ({ ok: g.re.test(firstLine(o.final)), why: `first line: ${firstLine(o.final).slice(0, 160)}` }),
  says: (g, o) => ({
    ok: g.re.test(o.final),
    why: g.re.test(o.final) ? "said" : `the final message does not match ${g.re}`,
  }),
  silent: (g, o) => ({
    ok: !g.re.test(o.final),
    why: g.re.test(o.final) ? `the final message matches ${g.re}` : "not said",
  }),
  called: (g, o) => {
    const found = callsOf(o, g.tool).filter((call) => holds(call.input, g.where));
    return { ok: found.length >= (g.times ?? 1), why: `${found.length} matching call(s) of ${g.tool}` };
  },
  notCalled: (g, o) => {
    const found = callsOf(o, g.tool).filter((call) => holds(call.input, g.where));
    return {
      ok: found.length === 0,
      why: found.length ? `called: ${JSON.stringify(found[0].input).slice(0, 200)}` : "not called",
    };
  },
  ran: (g, o) => {
    const found = commands(o).filter((command) => g.re.test(command));
    return {
      ok: found.length > 0,
      why: found.length ? `ran: ${found[0].slice(0, 160)}` : `no command matches ${g.re}`,
    };
  },
  notRan: (g, o) => {
    const found = commands(o).filter((command) => g.re.test(command));
    return { ok: found.length === 0, why: found.length ? `ran: ${found[0].slice(0, 160)}` : "not run" };
  },
  before: (g, o) => {
    const index = (step) =>
      o.calls.findIndex((call) =>
        step.tool
          ? callsOf({ calls: [call] }, step.tool).length > 0 && holds(call.input, step.where)
          : SHELL.has(call.name) && step.re.test(String(call.input?.command ?? "")),
      );
    const [a, b] = [index(g.first), index(g.then)];
    return { ok: a >= 0 && (b < 0 || a < b), why: `first at ${a}, then at ${b}` };
  },
  room: (g, o) => {
    const ok = Boolean(g.check(o.room));
    return { ok, why: ok ? g.says : `not so: ${g.says}` };
  },
  project: (g, o) => {
    const ok = Boolean(g.check(o.project));
    return { ok, why: ok ? g.says : `not so: ${g.says}` };
  },
  outcome: (g, o) => {
    const ok = Boolean(g.check(o));
    return { ok, why: ok ? g.says : `not so: ${g.says}` };
  },
};

/** Grades one run: each grader of its case, a grader that throws being a failure that says why. */
function grade(graders, outcome) {
  return graders.map((g) => {
    try {
      const { ok, why } = GRADERS[g.kind](g, outcome);
      return { kind: g.kind, label: g.label ?? g.kind, ok, why };
    } catch (error) {
      return { kind: g.kind, label: g.label ?? g.kind, ok: false, why: `the grader failed: ${error.message}` };
    }
  });
}

/** Grader builders, so a case reads as its rules. */
const g = {
  first: (re, label) => ({ kind: "first", re, label }),
  says: (re, label) => ({ kind: "says", re, label }),
  silent: (re, label) => ({ kind: "silent", re, label }),
  called: (tool, where, label, times) => ({ kind: "called", tool, where, label, times }),
  notCalled: (tool, where, label) => ({ kind: "notCalled", tool, where, label }),
  ran: (re, label) => ({ kind: "ran", re, label }),
  notRan: (re, label) => ({ kind: "notRan", re, label }),
  before: (first, then, label) => ({ kind: "before", first, then, label }),
  room: (says, check) => ({ kind: "room", says, check, label: says }),
  project: (says, check) => ({ kind: "project", says, check, label: says }),
  outcome: (says, check) => ({ kind: "outcome", says, check, label: says }),
};

module.exports = { grade, g, commands, callsOf, holds };
