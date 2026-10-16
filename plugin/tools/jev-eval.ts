/**
 * Measures what the room asks the decision model against labelled cases in evals/jev: each choice asked in its listed order and reversed, each juror asked as written and reworded, and the input variants (where a long text is cut, what else rides in the state). It calls the provider in force with the key in the room home, and writes nothing there.
 *   node --require ./test/register.cjs tools/jev-eval.ts [--only <site>] [--variants <regex>] [--questions <file>] [--label <name>] [--dry]
 * --questions names a JSON file of rewordings to try beside the shipped questions: { "<site>": { "<name>": { "question" or "nouls", "reworded"?, "with"? } } }.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import policy from "../paseo/policy.json";
import models from "../room/models.json";
import forkCatalog from "../shared/forks.json";
import knowledgeCatalog from "../shared/knowledge.json";
import councilCatalog from "../shared/safety/council.json";
import { excerpt } from "../server/excerpt";
import { call } from "../server/jev/client";
import {
  LIMITS,
  tokensOf,
  type Answer,
  type Meaning,
  type Question,
  type Questions,
  type State,
} from "../server/jev/contract";
import type { Dialect } from "../server/jev/dialects";
import { cleanState, guarded } from "../server/jev/input";
import { merged, REVERSED, withReversed } from "../server/jev/order";
import { clip } from "../server/orchestration/forks";
import { JEV_DIR } from "../server/paths";

/** One labelled case as its file holds it: an id, the answer it should get, and the raw fields its site builds a state from. */
type Case = Record<string, unknown> & { id: string; expect: string };

/** One request: a variant's state and questions, the answer each question should get, and when an answer counts as sure. */
interface Probe {
  site: string;
  cases: string[];
  variant: string;
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  expect: Record<string, string>;
  sharpAt: number;
  band?: [number, number];
  nouls?: Nouls;
}

/** A choice asked as one noul a label instead: the first label in `order` whose noul is sure is acted on, `otherwise` stands when none holds. */
interface Nouls {
  order: string[];
  otherwise: string;
  questions: Record<string, Question>;
}

/** How one answer was read: its label, how sure, whether sure enough to act on, and whether right. */
interface Read {
  label: string;
  p: number;
  sharp: boolean;
  correct: boolean;
  parted?: boolean;
}

/** A rewording to try beside a site's shipped question: the question, a juror's second reading, and case fields its state also carries. */
interface Candidate {
  question?: Question;
  reworded?: Question;
  with?: string[];
  nouls?: Nouls;
}

/** A site of the room that asks the model: its cases built into requests, one at a time or, for a batched site, all at once. */
interface Site {
  probes(one: Case): Probe[];
  batch?(all: Case[]): Probe[];
}

const CASES = join(__dirname, "..", "..", "evals", "jev");
const RESULTS = join(__dirname, "..", "..", "evals", "results");
const REWORDED = "~w";
const AT_ONCE = 6;
const INCIDENTS_AT_ONCE = 8;
const FORKS = forkCatalog.forks;
const GATE = knowledgeCatalog.gate;
const MEMBERS = councilCatalog.members;
const FILLER = [
  "Read the store module to see how rows are written and when the cache is cleared.",
  "Looked at the three call sites of parseConfig and how each one handles a missing key.",
  "Noted that the cache key holds the user id, so two tabs of one user share an entry.",
  "Traced the retry loop in the client from the first attempt to the backoff.",
  "Went through the migration script and the order in which it renames the columns.",
  "Opened the worker's logging setup and followed where an error line ends up.",
  "Compared the two branches of the export path, the streamed one and the buffered one.",
  "Followed the request from the router into the handler and back out to the response.",
];

/** A case's text: a string as it is, or a head, a stretch of neutral notes `pad` characters long, and a tail. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  const { head = "", pad = 0, tail = "" } = value as { head?: string; pad?: number; tail?: string };
  const notes: string[] = [];
  for (let at = 0, size = 0; size < pad; at += 1) {
    notes.push(FILLER[at % FILLER.length]);
    size += FILLER[at % FILLER.length].length + 1;
  }
  return [head, notes.join(" "), tail].filter(Boolean).join("\n\n");
}

/** A fork's question with `{{id}}` filled and, when given, the labels the call brings. */
function forkQuestion(name: keyof typeof FORKS, id: string, labels?: Record<string, Meaning>): Question {
  const question = FORKS[name].question as unknown as Question;
  return {
    ...question,
    instructions: String(question.instructions).replaceAll("{{id}}", id),
    ...(labels ? { criteria: labels } : {}),
  } as Question;
}

/** One request per cut of a long text: its head only, as the room cut it before, and its head and tail, as it cuts it now. */
const cuts = (build: (cut: (value: string, most: number) => string) => Record<string, unknown>) => [
  { variant: "head", state: build(clip) },
  { variant: "ends", state: build(excerpt) },
];

/** A fork whose state holds one text that may be long. */
function forkSite(
  name: keyof typeof FORKS,
  build: (one: Case, cut: (v: string, most: number) => string) => Record<string, unknown>,
  labels?: (one: Case) => Record<string, Meaning>,
): Site {
  return {
    probes: (one) =>
      cuts((cut) => build(one, cut)).map(({ variant, state }) => ({
        site: name,
        cases: [one.id],
        variant,
        state,
        questions: { fork: forkQuestion(name, "fork", labels?.(one)) },
        expect: { fork: one.expect },
        sharpAt: FORKS[name].sharpAt,
      })),
  };
}

/** A juror of the council: its question and its rewording in one request. */
function jurorSite(
  member: "claims" | "scope" | "gaming",
  build: (one: Case, cut: (v: string, most: number) => string) => Record<string, unknown>,
): Site {
  const shipped = MEMBERS[member];
  return {
    probes: (one) =>
      cuts((cut) => build(one, cut)).map(({ variant, state }) => ({
        site: member,
        cases: [one.id],
        variant,
        state,
        questions: {
          juror: shipped.question as unknown as Question,
          [`juror${REWORDED}`]: shipped.reworded as unknown as Question,
        },
        expect: { juror: one.expect, [`juror${REWORDED}`]: one.expect },
        sharpAt: shipped.hi,
        band: [shipped.lo, shipped.hi],
      })),
  };
}

/** The tiers of a role that list a model on this provider, each with what it is for, in the table's order. */
function tierLabels(role: "peer", provider: string): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(models[role].tiers)
      .filter(([, tier]) => tier.providers.some((entry: string) => entry.startsWith(`${provider}/`)))
      .map(([name, tier]) => [name, tier.use]),
  );
}

const said = (value: unknown, most: number) => clip(String(value ?? "").trim(), most) || "(none)";

const SITES: Record<string, Site> = {
  report: forkSite("report", (one, cut) => ({ report: cut(text(one.report), 2000), woke_by: one.woke_by })),
  wake: forkSite("wake", (one, cut) => ({ subject: one.subject, body: cut(text(one.body), 1500) })),
  failure: forkSite("failure", (one) => ({ error: clip(String(one.error), 300) })),
  answers: forkSite(
    "answers",
    (one, cut) => {
      const reply = one.reply as { subject: string; body: unknown };
      const asks = one.asks as { subject: string; body: string }[];
      return {
        reply: { subject: reply.subject, body: cut(text(reply.body), 1500) },
        asks: Object.fromEntries(
          asks.map((ask, at) => [`m${at + 1}`, { subject: ask.subject, body: clip(ask.body, 600) }]),
        ),
      };
    },
    (one) => ({
      ...Object.fromEntries((one.asks as unknown[]).map((_, at) => [`m${at + 1}`, `it answers asks.m${at + 1}`])),
      none: "it answers none of them",
    }),
  ),
  tier: forkSite(
    "tier",
    (one) => ({
      title: clip(String(one.title), 300),
      ...(one.spec ? { spec: one.spec } : {}),
      brief: clip(String(one.brief), 1500),
    }),
    () => tierLabels("peer", "claude-peer"),
  ),
  gaps: forkSite("gaps", (one) => {
    const issue = one.issue as Record<string, string>;
    return {
      issue: {
        title: said(issue.title, 300),
        description: said(issue.description, 1500),
        acceptance: said(issue.acceptance, 800),
        write_scope: said(issue.write_scope, 300),
      },
    };
  }),
  escalate: forkSite(
    "escalate",
    (one, cut) => {
      const seat = (value: unknown) => {
        const given = value as { role: string; title: string } | undefined;
        return given ? { role: given.role, title: clip(given.title, 120) } : null;
      };
      return {
        message: { signal: one.signal, subject: clip(String(one.subject), 200), body: cut(String(one.body), 1500) },
        sender: seat(one.sender),
        owner: seat(one.owner),
        above: seat(one.above),
      };
    },
    (one) => {
      const words = FORKS.escalate.question.criteria as Record<string, Meaning>;
      const targets = (one.targets as string[] | undefined) ?? Object.keys(words);
      return Object.fromEntries(targets.map((label) => [label, words[label]]));
    },
  ),
  incident: {
    probes: () => [],
    batch: (all) => {
      const line = (one: Case) => ({ district: one.district, line: clip(String(one.line), 300), seen: one.seen });
      const batches: Case[][] = [];
      for (let at = 0; at < all.length; at += INCIDENTS_AT_ONCE) batches.push(all.slice(at, at + INCIDENTS_AT_ONCE));
      return [
        ...batches.map((some) => {
          const ids = some.map((_, at) => `i${at + 1}`);
          return {
            site: "incident",
            cases: some.map((one) => one.id),
            variant: "batch",
            state: { incidents: Object.fromEntries(some.map((one, at) => [ids[at], line(one)])) },
            questions: Object.fromEntries(ids.map((id) => [id, forkQuestion("incident", id)])),
            expect: Object.fromEntries(ids.map((id, at) => [id, some[at].expect])),
            sharpAt: FORKS.incident.sharpAt,
          };
        }),
        ...all.map((one) => ({
          site: "incident",
          cases: [one.id],
          variant: "solo",
          state: { incidents: { i1: line(one) } },
          questions: { i1: forkQuestion("incident", "i1") },
          expect: { i1: one.expect },
          sharpAt: FORKS.incident.sharpAt,
        })),
      ];
    },
  },
  overlap: {
    probes: () => [],
    batch: (all) => {
      const ids = all.map((_, at) => `p${at + 1}`);
      const pair = (one: Case) => ({ a: clip(String(one.a), 400), b: clip(String(one.b), 400) });
      return [
        {
          site: "overlap",
          cases: all.map((one) => one.id),
          variant: "batch",
          state: { pairs: Object.fromEntries(all.map((one, at) => [ids[at], pair(one)])) },
          questions: Object.fromEntries(ids.map((id) => [id, forkQuestion("overlap", id)])),
          expect: Object.fromEntries(ids.map((id, at) => [id, all[at].expect])),
          sharpAt: FORKS.overlap.sharpAt,
        },
        ...all.map((one) => ({
          site: "overlap",
          cases: [one.id],
          variant: "solo",
          state: { pairs: { p1: pair(one) } },
          questions: { p1: forkQuestion("overlap", "p1") },
          expect: { p1: one.expect },
          sharpAt: FORKS.overlap.sharpAt,
        })),
      ];
    },
  },
  duplicate: {
    probes: (one) => {
      const made = one.new as { id: string; title: string; description: string };
      const near = one.near as { id: string; title: string; description: string }[];
      const others = (one.others as typeof near | undefined) ?? [];
      const listed = (issues: typeof near) =>
        Object.fromEntries(issues.map((issue) => [issue.id, `it asks for the same work as ${issue.id}`]));
      const state = {
        new: {
          [made.id]: { title: clip(made.title, 300), description: clip(made.description.trim(), 600) || "(none)" },
        },
        open: Object.fromEntries(
          [...near, ...others].map((issue) => [
            issue.id,
            { title: clip(issue.title, 200), description: clip(issue.description.trim(), 300) || "(none)" },
          ]),
        ),
      };
      const none = { none: "it is a different piece of work from every open issue listed" };
      return [
        { variant: "all", labels: { ...none, ...listed([...near, ...others]) } },
        { variant: "own", labels: { ...none, ...listed(near) } },
      ].map(({ variant, labels }) => ({
        site: "duplicate",
        cases: [one.id],
        variant,
        state,
        questions: { [made.id]: forkQuestion("duplicate", made.id, labels) },
        expect: { [made.id]: one.expect },
        sharpAt: FORKS.duplicate.sharpAt,
      }));
    },
  },
  claims: jurorSite("claims", (one, cut) => ({ report: cut(text(one.report), 6000) })),
  scope: jurorSite("scope", (one, cut) => ({
    nonGoals: one.nonGoals,
    changed: (one.changed as string[]).slice(0, 50),
    report: cut(text(one.report), 6000),
  })),
  gaming: jurorSite("gaming", (one) => ({
    excerpt: one.excerpt,
    sourceFiles: one.sourceFiles,
    outcome: one.outcome ? clip(String(one.outcome), 600) : null,
  })),
  keep: {
    probes: (one) => {
      const olds = (one.olds as string[] | undefined) ?? [];
      const base = { scope: one.scope, new: one.new };
      return [
        {
          variant: "with-olds",
          state: olds.length ? { ...base, old: Object.fromEntries(olds.map((old, at) => [`d${at + 1}`, old])) } : base,
        },
        { variant: "alone", state: base },
      ].map(({ variant, state }) => ({
        site: "keep",
        cases: [one.id],
        variant,
        state,
        questions: { keep: GATE.question as unknown as Question },
        expect: { keep: one.expect },
        sharpAt: GATE.at,
      }));
    },
  },
  same: {
    probes: (one) => {
      const others = (one.others as string[] | undefined) ?? [];
      const question = {
        ...GATE.same,
        instructions: GATE.same.instructions.replaceAll("{{id}}", "d1"),
      } as unknown as Question;
      return [
        {
          variant: "shared",
          state: {
            ...(one.scope ? { scope: one.scope } : {}),
            new: one.new,
            old: Object.fromEntries([one.old, ...others].map((old, at) => [`d${at + 1}`, old])),
          },
        },
        { variant: "solo", state: { new: one.new, old: { d1: one.old } } },
      ].map(({ variant, state }) => ({
        site: "same",
        cases: [one.id],
        variant,
        state,
        questions: { d1: question },
        expect: { d1: one.expect },
        sharpAt: GATE.at,
      }));
    },
  },
};

/** A probe asked another way: each question replaced by the candidate's, a choice keeping the probe's labels unless the candidate words them, and the candidate's case fields added to the state. */
function tryOn(probe: Probe, name: string, candidate: Candidate, cases: Map<string, Case>): Probe {
  const one = probe.cases.length === 1 ? cases.get(`${probe.site}\u0000${probe.cases[0]}`) : undefined;
  const added = Object.fromEntries((candidate.with ?? []).map((field) => [field, one?.[field] ?? null]));
  const variant = `${probe.variant}+${name}`;
  if (candidate.nouls) {
    const [qid] = Object.keys(probe.expect);
    const questions = Object.fromEntries(
      Object.entries(candidate.nouls.questions).map(([label, question]) => [`${qid}.${label}`, question]),
    );
    return { ...probe, variant, state: { ...probe.state, ...added }, questions, nouls: candidate.nouls };
  }
  const questions: Record<string, Question> = {};
  for (const [qid, shipped] of Object.entries(probe.questions)) {
    if (qid.endsWith(REWORDED)) {
      if (candidate.reworded) questions[qid] = candidate.reworded;
      continue;
    }
    const { instructions } = candidate.question!;
    const asked = {
      ...candidate.question!,
      instructions: typeof instructions === "string" ? instructions.replaceAll("{{id}}", qid) : instructions,
    } as Question;
    const worded = asked.type === "choice" ? (asked.criteria as Record<string, unknown>) : {};
    questions[qid] =
      shipped.type === "choice" && asked.type === "choice"
        ? ({
            ...asked,
            criteria: Object.fromEntries(
              Object.entries(shipped.criteria).map(([key, was]) => [key, worded[key] ?? was]),
            ),
          } as Question)
        : asked;
  }
  const expect = Object.fromEntries(
    Object.entries(probe.expect).filter(([qid]) => !qid.endsWith(REWORDED) || candidate.reworded),
  );
  return { ...probe, variant, state: { ...probe.state, ...added }, questions, expect };
}

/** The label an answer gives and its weight: a choice's most likely option, a noul's side of a half. */
function labelOf(answer: { type: string; noul?: number; probabilities?: Record<string, number> }): {
  label: string;
  p: number;
  yes?: number;
} {
  if (answer.type === "noul") {
    const yes = answer.noul ?? 0;
    return { label: yes >= 0.5 ? "true" : "false", p: Math.max(yes, 1 - yes), yes };
  }
  const [label, p] = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
  return { label, p };
}

/** Whether a reading is sure enough to act on: past the band for a juror, at the threshold for the rest. */
const sureOf = (probe: Probe, p: number, yes?: number) =>
  probe.band && yes !== undefined ? yes >= probe.band[1] || yes <= probe.band[0] : p >= probe.sharpAt;

/** The ways one probe's answers are read: as asked, reversed, the two averaged; or a juror as written, reworded, and both. */
function readings(probe: Probe, answers: Record<string, any>): { qid: string; mode: string; read: Read }[] {
  const out: { qid: string; mode: string; read: Read }[] = [];
  if (probe.nouls) {
    const [qid, expect] = Object.entries(probe.expect)[0];
    const yes = (label: string) => (answers[`${qid}.${label}`] as { noul: number }).noul;
    const held = probe.nouls.order.find((label) => yes(label) >= 0.5);
    const acted = probe.nouls.order.find((label) => yes(label) >= probe.sharpAt);
    const clear = probe.nouls.order.every((label) => yes(label) <= 1 - probe.sharpAt);
    const label = held ?? probe.nouls.otherwise;
    const p = held ? yes(held) : Math.min(...probe.nouls.order.map((one) => 1 - yes(one)));
    const read = {
      label: acted ?? label,
      p: acted ? yes(acted) : p,
      sharp: !!acted || clear,
      correct: (acted ?? label) === expect,
    };
    for (const mode of ["asked", "both"]) out.push({ qid, mode, read });
    return out;
  }
  for (const [qid, expect] of Object.entries(probe.expect)) {
    if (qid.endsWith(REWORDED)) continue;
    const first = labelOf(answers[qid]);
    const one = (mode: string, read: { label: string; p: number; yes?: number }, parted = false) =>
      out.push({
        qid,
        mode,
        read: {
          label: read.label,
          p: read.p,
          sharp: !parted && sureOf(probe, read.p, read.yes),
          correct: read.label === expect,
          ...(parted ? { parted } : {}),
        },
      });
    one("asked", first);
    const twin = answers[`${qid}${REVERSED}`];
    if (twin) {
      one("reversed", labelOf(twin));
      // the two orders read as the room reads them
      const room = merged(answers as Record<string, Answer>);
      one("both", labelOf(room.answers[qid]), room.parted.includes(qid));
    }
    const again = answers[`${qid}${REWORDED}`];
    if (again) {
      const second = labelOf(again);
      one("reworded", second);
      const yes = ((first.yes ?? 0) + (second.yes ?? 0)) / 2;
      one(
        "both",
        { label: yes >= 0.5 ? "true" : "false", p: Math.max(yes, 1 - yes), yes },
        first.label !== second.label,
      );
    }
  }
  return out;
}

/** The provider in force and its key from the room home, read and never written. */
function wire(): { dialect: Dialect; url: string; model: string; key: string; usdPerMillion: number } {
  const name = policy.jev.provider as keyof typeof policy.jev.providers;
  const settings = policy.jev.providers[name];
  const key = (settings.keyEnv && process.env[settings.keyEnv]) || readFileSync(join(JEV_DIR, `${name}.key`), "utf8");
  return {
    dialect: settings.dialect as Dialect,
    url: settings.url,
    model: settings.model,
    key: key.trim(),
    usdPerMillion: settings.usdPerMillionInput,
  };
}

/** Every case of every site asked, a few requests at a time; a report and the raw answers under evals/results. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const only = option("--only");
  const variants = option("--variants");
  const tried = option("--questions");
  const candidates: Record<string, Record<string, Candidate>> = tried ? JSON.parse(readFileSync(tried, "utf8")) : {};
  const cases = new Map<string, Case>();
  const label = option("--label") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const probes: Probe[] = [];
  for (const file of readdirSync(CASES)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const name = file.replace(/\.json$/, "");
    const site = SITES[name];
    if (!site) throw new Error(`no site ${name} for ${file}`);
    if (only && !new RegExp(only).test(name)) continue;
    const read = (JSON.parse(readFileSync(join(CASES, file), "utf8")) as { cases: Case[] }).cases;
    for (const one of read) cases.set(`${name}\u0000${one.id}`, one);
    const built = (site.batch ? site.batch(read) : read.flatMap((one) => site.probes(one))).filter(
      (probe) => !variants || new RegExp(variants).test(probe.variant),
    );
    probes.push(
      ...built,
      ...Object.entries(candidates[name] ?? {}).flatMap(([tag, candidate]) =>
        built.map((probe) => tryOn(probe, tag, candidate, cases)),
      ),
    );
  }
  // a choice is asked in its listed order and reversed in the same request, as the room asks it
  for (const probe of probes) probe.questions = withReversed(probe.questions as Questions, LIMITS.questions);
  const unique = new Map<string, Probe>();
  for (const probe of probes)
    unique.set(JSON.stringify([probe.site, probe.cases, probe.state, probe.questions]), probe);
  const tokens = probes.reduce((sum, probe) => sum + tokensOf(probe.state as State, probe.questions as Questions), 0);
  console.log(`${probes.length} probes (${unique.size} distinct requests), about ${tokens} tokens`);
  if (args.includes("--dry")) {
    console.log(JSON.stringify(probes[0], null, 2));
    return;
  }
  const { dialect, url, model, key, usdPerMillion } = wire();
  const answered = new Map<string, Record<string, any>>();
  let usd = 0;
  const queue = [...unique.entries()];
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [hash, probe] = next;
        const { state: sent } = cleanState(probe.state as State);
        try {
          const reply = await call(dialect, { url, model, key }, sent, guarded(probe.questions as Questions), {
            attemptMs: 15_000,
            retries: 2,
            deadlineMs: 45_000,
          });
          usd += reply.costUsd ?? (reply.inputTokens * usdPerMillion) / 1e6;
          answered.set(hash, reply.answers);
        } catch (error) {
          failures.push(
            `${probe.site} ${probe.cases.join(",")} ${probe.variant}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }),
  );
  const rows = probes.flatMap((probe) => {
    const answers = answered.get(JSON.stringify([probe.site, probe.cases, probe.state, probe.questions]));
    if (!answers) return [];
    return readings(probe, answers).map(({ qid, mode, read }) => ({
      site: probe.site,
      case: probe.cases[probe.cases.length === 1 ? 0 : Number(qid.replace(/^\D+/, "")) - 1],
      variant: probe.variant,
      mode,
      expect: probe.expect[qid],
      ...read,
    }));
  });
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.site}\u0000${row.variant}\u0000${row.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = [
    `# Jev eval ${label}`,
    "",
    `Model ${model} via ${policy.jev.provider}; ${unique.size} requests; ${usd.toFixed(4)} USD; ${failures.length} failed.`,
    "",
    "| site | variant | mode | n | right | sure | sure and right | sure and wrong | split |",
    "|---|---|---|---|---|---|---|---|---|",
    ...[...groups.entries()].map(([group, all]) => {
      const [site, variant, mode] = group.split("\u0000");
      const count = (test: (row: (typeof rows)[number]) => boolean) => all.filter(test).length;
      return `| ${site} | ${variant} | ${mode} | ${all.length} | ${count((r) => r.correct)} | ${count((r) => r.sharp)} | ${count((r) => r.sharp && r.correct)} | ${count((r) => r.sharp && !r.correct)} | ${count((r) => r.parted === true)} |`;
    }),
    "",
    ...(failures.length ? ["## Failed", "", ...failures.map((line) => `- ${line}`), ""] : []),
    "## Wrong answers",
    "",
    ...rows
      .filter((row) => !row.correct)
      .map(
        (row) =>
          `- ${row.site} ${row.case} ${row.variant}/${row.mode}: ${row.label} (${row.p.toFixed(2)}), wanted ${row.expect}`,
      ),
  ];
  const dir = join(RESULTS, `jev-${label}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "rows.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(lines.slice(0, 6 + groups.size).join("\n"));
  console.log(`\n${dir}`);
}

main().catch((error) => {
  console.error(`jev eval: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
