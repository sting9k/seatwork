/**
 * Replays recorded turns through the watcher's gate: `npm run watch:replay -- [--ask] <eval run dir | results label dir | session.jsonl> …`
 * Prints what each turn's facts amount to; with --ask the opened questions go to the decision model (key as the plugin reads it).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { WatcherPolicy } from "../server/policy";
import { ROOM_HOME } from "../server/paths";
import { missingLines, parseBrief, type Brief } from "../server/watch/brief";
import { toEvents, turnStartOf, type TimelineInput } from "../server/watch/events";
import { turnFacts } from "../server/watch/facts";
import { JevEngine } from "../server/watch/jev";
import { inquiryFor, type Inquiry } from "../server/watch/questions";
import { gate } from "../server/watch/rules";
import { buildRequest } from "../server/watch/state";

interface Turn {
  id: string;
  entries: TimelineInput[];
  cwd: string;
  /** The project root: the repository the seat stood in, as the watcher takes it from git. */
  root: string;
  brief: Brief | null;
  changed: string[] | null;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** Claude's stream (an eval run's events.jsonl, a session's .jsonl) as the timeline entries Paseo would project from it. */
function claudeEntries(file: string): { entries: TimelineInput[]; cwds: (string | null)[] } {
  const entries: TimelineInput[] = [];
  const cwds: (string | null)[] = [];
  const calls = new Map<string, { status: string; detail: Record<string, unknown>; error?: unknown }>();
  let cwd: string | null = null;
  let turn = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let event: { type?: string; cwd?: string; timestamp?: string; message?: { content?: string | Block[] } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    cwd = event.cwd ?? cwd;
    const content = event.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const push = (item: object) => {
      entries.push({ item, turnId: `turn-${turn}`, ...(event.timestamp ? { timestamp: event.timestamp } : {}) });
      cwds.push(cwd);
    };
    if (event.type === "user") {
      const prose = typeof content === "string" ? content : blocks.some((block) => block.type === "tool_result") ? null : blocks.map((block) => block.text ?? "").join("\n");
      if (prose !== null) {
        turn += 1;
        push({ type: "user_message", text: prose });
      }
      for (const block of blocks) {
        const call = block.tool_use_id ? calls.get(block.tool_use_id) : undefined;
        if (!call) continue;
        call.status = block.is_error ? "failed" : "completed";
        const output = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: { text?: string }) => part.text ?? "").join("\n") : "";
        // as Paseo projects it: a failure's text sits beside the call, not in its detail
        if (block.is_error) call.error = { content: output };
        else if (call.detail.type === "shell") call.detail.output = output;
      }
    } else if (event.type === "assistant") {
      for (const block of blocks) {
        if (block.type === "text" && block.text?.trim()) push({ type: "assistant_message", text: block.text });
        if (block.type !== "tool_use" || !block.id) continue;
        const input = block.input ?? {};
        const detail: Record<string, unknown> =
          block.name === "Bash" ? { type: "shell", command: String(input.command ?? "") }
          : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name ?? "") ? { type: "edit", filePath: String(input.file_path ?? input.notebook_path ?? "") }
          : ["Read", "Grep", "Glob", "WebFetch", "WebSearch"].includes(block.name ?? "") ? { type: "read", filePath: String(input.file_path ?? "") }
          : { type: "unknown", input };
        const call = { type: "tool_call", name: block.name, status: "running", detail };
        calls.set(block.id, call);
        push(call);
      }
    }
  }
  return { entries, cwds };
}

const roots = new Map<string, string>();
function rootOf(cwd: string): string {
  if (!roots.has(cwd)) roots.set(cwd, (existsSync(cwd) && git(cwd, ["rev-parse", "--show-toplevel"]).trim()) || cwd);
  return roots.get(cwd)!;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** Files an eval run's fixture differs in from its first commit: everything the one recorded turn changed. */
function changedIn(cwd: string): string[] | null {
  const base = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n")[0];
  if (!base) return null;
  const paths = [...git(cwd, ["diff", "--name-only", base]).split("\n"), ...git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")];
  return [...new Set(paths.filter(Boolean))];
}

function turnsOf(path: string): Turn[] {
  const full = resolve(path);
  if (statSync(full).isFile()) {
    // a session: every prompt opens a turn, each judged with the history before it
    const { entries, cwds } = claudeEntries(full);
    const starts = entries.flatMap((entry, index) => ((entry.item as { type?: string }).type === "user_message" ? [index] : []));
    return starts.map((start, i) => {
      const cwd = cwds[start] ?? "/";
      return { id: `${basename(full, ".jsonl").slice(0, 8)}#${i + 1}`, entries: entries.slice(0, starts[i + 1] ?? entries.length), cwd, root: rootOf(cwd), brief: null, changed: null };
    });
  }
  if (existsSync(join(full, "events.jsonl"))) {
    const cwd = join(full, "cwd");
    const prompt = readFileSync(join(full, "prompt.md"), "utf8");
    const { entries } = claudeEntries(join(full, "events.jsonl"));
    const brief = parseBrief(prompt, cwd);
    // a review's fixture starts with the candidate's changes in the tree: git cannot tell them from the reviewer's own
    const changed = brief.readOnly ? null : changedIn(cwd);
    return [{ id: basename(full), entries: [{ item: { type: "user_message", text: prompt }, turnId: "turn-1" }, ...entries.map((entry) => ({ ...entry, turnId: "turn-1" }))], cwd, root: cwd, brief, changed }];
  }
  const runs = existsSync(join(full, "runs")) ? join(full, "runs") : full;
  return readdirSync(runs).flatMap((name) => (existsSync(join(runs, name, "events.jsonl")) ? turnsOf(join(runs, name)) : []));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ask = args.includes("--ask");
  // the repo's policy, so a tree that is not installed yet can be measured
  const policy = (JSON.parse(readFileSync(join(__dirname, "..", "..", "paseo", "policy.json"), "utf8")) as { watcher: WatcherPolicy }).watcher;
  const keyFile = join(ROOM_HOME, policy.engine.keyFile);
  const engine = new JevEngine({ ...policy.engine, deadlineMs: 15_000, apiKey: process.env[policy.engine.keyEnv]?.trim() || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined) });
  const thresholds = { ...policy.thresholds, silentMinutes: 6, inFlightMinutes: 18 };
  const tally = new Map<string, number>();
  const count = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);
  let turns = 0;
  let asked = 0;
  let tokens = 0;
  for (const turn of args.filter((arg) => !arg.startsWith("--")).flatMap(turnsOf)) {
    const events = toEvents(turn.entries, turn.cwd);
    const turnId = (turn.entries.at(-1) as TimelineInput | undefined)?.turnId ?? null;
    const facts = turnFacts({ events, turnStart: turnStartOf(turn.entries, events, turnId), cwd: turn.cwd, root: turn.root, brief: turn.brief, ended: true, changed: turn.changed });
    turns += 1;
    // an eval's Peer case is that Peer's first turn: its prompt is the brief a Lead would have created it with
    const briefGaps = turn.brief && turn.id.startsWith("peer-") ? missingLines(turn.brief) : [];
    const result = gate({ facts, brief: turn.brief, moment: "end", briefGaps, now: facts.lastActivity ?? 0, pendingPermission: false, thresholds });
    const told = result.findings.map((finding) => `${finding.rule}: ${finding.evidence}`);
    for (const finding of result.findings) count(`told ${finding.rule}`);
    for (const question of result.questions) count(`opened ${question.rule}`);
    const inquiries = result.questions.map((question) => inquiryFor(question.rule)).filter((inquiry): inquiry is Inquiry => inquiry !== undefined);
    const scores: string[] = [];
    if (ask && inquiries.length > 0) {
      const built = buildRequest(inquiries, facts, turn.brief, policy.state);
      const reply = built.whole ? await engine.ask(built.request) : null;
      if (reply?.ok) {
        asked += 1;
        tokens += reply.inputTokens;
        for (const inquiry of inquiries) {
          const score = inquiry.score(reply.answers);
          scores.push(`${inquiry.rule} ${score?.toFixed(2)}`);
          if (score !== null && score >= (policy.scores[inquiry.rule] ?? 1)) {
            count(`found ${inquiry.rule}`);
            told.push(`${inquiry.rule}: ${inquiry.finding(facts, turn.brief)}`);
          }
        }
      } else scores.push(reply ? `no answer (${reply.reason})` : "evidence too long");
    }
    const verified = facts.lastEdit ? `tests ${facts.tests}, statics ${facts.statics}` : "no source change";
    console.log(`${turn.id} | ${facts.signal ?? "-"} | ${verified} | opened: ${result.questions.map((q) => q.rule).join(", ") || "-"}${scores.length ? ` → ${scores.join("; ")}` : ""}`);
    for (const line of told) console.log(`    ${line.slice(0, 260)}`);
  }
  console.log(`\n${turns} turns${ask ? `; ${asked} calls, ${tokens} tokens, $${((tokens * policy.budget.usdPerMillionTokens) / 1e6).toFixed(5)}` : ""}`);
  for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${key}`);
}

void main();
