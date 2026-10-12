import type { Brief } from "./brief";
import type { TurnFacts } from "./facts";
import { DECISION_WORDS, VERIFICATION_WORDS } from "./questions";

/** The gate: each rule reads a turn's facts and gives nothing, a finding, or a question about the message. */

export type RuleId =
  | "irreversible"
  | "outside-project"
  | "outside-scope"
  | "edit-after-reopen"
  | "unverified-completion"
  | "review-without-check"
  | "same-failure"
  | "repeating"
  | "shell-wait"
  | "silent"
  | "incomplete-brief"
  | "external-action"
  | "decided-beyond-brief"
  | "reopen-condition";

/** When the turn starts, while it is going, or when it has ended. */
export type Moment = "start" | "live" | "end";

export interface Thresholds {
  sleepSeconds: number;
  repeatRun: number;
  cycleRepeats: number;
  sameFailure: number;
  silentMinutes: number;
  inFlightMinutes: number;
}

export interface Situation {
  facts: TurnFacts;
  brief: Brief | null;
  moment: Moment;
  briefGap: BriefGap | null;
  now: number;
  pendingPermission: boolean;
  thresholds: Thresholds;
}

export interface BriefGap {
  lines: readonly string[];
  mail?: { id: string; subject: string };
}

/** The key of the gap in the brief a Peer was created with; a mailed brief's is its mail. */
export const CREATED_WITH = "created";

/** A finding: `evidence` is written for a reader who has not seen the turn; one `key` is told once per turn. */
export interface Finding {
  rule: RuleId;
  evidence: string;
  key: string;
}

/** `rule` names the finding a yes would produce. */
export interface Question {
  rule: RuleId;
  key: string;
}

export interface GateResult {
  findings: Finding[];
  questions: Question[];
}

type Verdict = { finding: string; key?: string } | { ask: true; key?: string } | null;

interface Rule {
  id: RuleId;
  moments: readonly Moment[];
  read(situation: Situation): Verdict;
}

const list = (items: readonly string[], max = 4) => (items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`);
const quote = (command: string) => `\`${command.replace(/\s+/g, " ").trim().slice(0, 200)}\``;
const minutes = (ms: number) => Math.floor(ms / 60_000);

/** In order of weight; the first block stands on facts alone, the second opens a question. */
const RULES: readonly Rule[] = [
  {
    id: "irreversible",
    moments: ["live", "end"],
    read: ({ facts }) => {
      const deed = facts.destroyed[0];
      return deed ? { finding: `ran a command that cannot be undone from inside the task (${deed.what}): ${quote(deed.command)}`, key: deed.what } : null;
    },
  },
  {
    id: "outside-project",
    moments: ["live", "end"],
    read: ({ facts }) => (facts.outsideProject.length > 0 ? { finding: `wrote outside the project: ${list(facts.outsideProject)}`, key: facts.outsideProject.join("|") } : null),
  },
  {
    id: "outside-scope",
    moments: ["live", "end"],
    read: ({ facts, brief }) => {
      if (facts.outsideScope.length === 0 || !brief?.scope) return null;
      const scope = brief.scope.readOnly ? "its brief is read-only" : `its write scope is ${list(brief.scope.patterns, 6)}${brief.scope.except.length > 0 ? ` except ${list(brief.scope.except, 3)}` : ""}`;
      return { finding: `changed ${list(facts.outsideScope)}; ${scope}`, key: facts.outsideScope.join("|") };
    },
  },
  {
    id: "edit-after-reopen",
    moments: ["live", "end"],
    read: ({ facts }) => (facts.editedAfterReopen ? { finding: `mailed REOPEN_REQUEST and then changed ${facts.editedAfterReopen.path} in the same turn, before any answer` } : null),
  },
  {
    id: "review-without-check",
    moments: ["end"],
    read: ({ facts }) => (facts.signal === "REVIEW" && facts.verdict === "acceptable" && facts.checksThisTurn.length === 0 ? { finding: "gave a REVIEW that says ACCEPTABLE while no check ran in its turn: the verdict rests on reading" } : null),
  },
  {
    id: "same-failure",
    moments: ["live", "end"],
    read: ({ facts, thresholds }) => {
      const stuck = facts.sameFailure;
      return stuck && stuck.count >= thresholds.sameFailure ? { finding: `has run ${stuck.label} ${stuck.count} times in a row with the same failure`, key: stuck.label } : null;
    },
  },
  {
    id: "repeating",
    moments: ["live", "end"],
    read: ({ facts, thresholds }) => {
      if (facts.repeat && facts.repeat.count >= thresholds.repeatRun) return { finding: `did the same thing ${facts.repeat.count} times in a row with the same result: ${quote(facts.repeat.what)}`, key: facts.repeat.what };
      if (facts.cycle && facts.cycle.repeats >= thresholds.cycleRepeats) return { finding: `is repeating the same ${facts.cycle.period} actions, ${facts.cycle.repeats} rounds so far`, key: `cycle${facts.cycle.period}` };
      return null;
    },
  },
  {
    id: "shell-wait",
    moments: ["live", "end"],
    read: ({ facts, thresholds }) => {
      if (facts.waited < thresholds.sleepSeconds) return null;
      const span = Number.isFinite(facts.waited) ? `${Math.round(facts.waited)} s` : "for a time the timeline does not show";
      if (facts.waitLoop) return { finding: `${facts.ended ? "waited" : "is waiting"} inside the shell (${facts.waitLoop.what}, ${span}): ${quote(facts.waitLoop.command)}`, key: "loop" };
      return { finding: `has slept ${span} in the shell this turn; a seat waits by ending its turn`, key: "sleep" };
    },
  },
  {
    id: "silent",
    moments: ["live"],
    read: ({ facts, now, pendingPermission, thresholds }) => {
      if (pendingPermission || facts.lastActivity === undefined) return null;
      const quiet = minutes(now - facts.lastActivity);
      if (facts.inFlight) {
        return quiet >= thresholds.inFlightMinutes ? { finding: `has had one command running for ${quiet} min with nothing after it: ${quote(facts.inFlight.what)}`, key: "in-flight" } : null;
      }
      return quiet >= thresholds.silentMinutes ? { finding: `has been in its turn for ${quiet} min without any activity, with no command running and no permission pending`, key: "idle" } : null;
    },
  },
  {
    id: "incomplete-brief",
    moments: ["start", "live", "end"],
    read: ({ briefGap }) => {
      if (!briefGap) return null;
      const lines = briefGap.lines.join("; ");
      if (!briefGap.mail) return { finding: `was briefed without these template lines: ${lines}`, key: CREATED_WITH };
      return { finding: `was mailed a brief ("${briefGap.mail.subject.slice(0, 80)}") without these template lines: ${lines}`, key: briefGap.mail.id };
    },
  },
  {
    // whether unverified work is a defect depends on what the message claims
    id: "unverified-completion",
    moments: ["end"],
    read: ({ facts, brief }) => {
      if (!facts.closesWork || facts.signal === "REVIEW" || brief?.readOnly || !facts.lastEdit || facts.tests === "passed") return null;
      // a message with no word about checks claims nothing about them
      return VERIFICATION_WORDS.test(facts.message) ? { ask: true } : null;
    },
  },
  {
    id: "external-action",
    moments: ["live", "end"],
    read: ({ facts, brief }) => (facts.external.length > 0 && brief ? { ask: true, key: facts.external.map((deed) => deed.what).join("|") } : null),
  },
  {
    id: "decided-beyond-brief",
    moments: ["end"],
    read: ({ facts, brief }) => (facts.closesWork && brief && Object.keys(brief.fields).length > 0 && DECISION_WORDS.test(facts.message) ? { ask: true } : null),
  },
  {
    id: "reopen-condition",
    moments: ["end"],
    read: ({ facts, brief }) => (facts.closesWork && facts.signal !== "REVIEW" && brief?.fields.reopenWhen && !facts.mailed.includes("REOPEN_REQUEST") ? { ask: true } : null),
  },
];

export const RULE_ORDER: readonly RuleId[] = RULES.map((rule) => rule.id);

export function gate(situation: Situation): GateResult {
  const result: GateResult = { findings: [], questions: [] };
  for (const rule of RULES) {
    if (!rule.moments.includes(situation.moment)) continue;
    const verdict = rule.read(situation);
    if (!verdict) continue;
    const key = `${rule.id}:${verdict.key ?? ""}`;
    if ("finding" in verdict) result.findings.push({ rule: rule.id, evidence: verdict.finding, key });
    else result.questions.push({ rule: rule.id, key });
  }
  return result;
}

/** What the facts alone say when a question cannot be put to the model. */
export function unqualified(rule: RuleId, facts: TurnFacts): string | null {
  if (rule === "unverified-completion" && facts.lastEdit) {
    const evidence = facts.tests === "none" ? "no test ran after it" : facts.tests === "failed" ? `the last run of ${facts.checksSince.filter((run) => run.result === "failed").map((run) => run.label).pop() ?? "its tests"} after it failed` : "the tests that ran after it gave no readable result";
    return `reports ${facts.signal}; its last change was to ${facts.lastEdit.path} and ${evidence}`;
  }
  if (rule === "external-action" && facts.external[0]) return `acted outside this machine (${facts.external[0].what}): ${quote(facts.external[0].command)}`;
  return null;
}
