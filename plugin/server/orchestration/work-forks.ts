import type { MailEngine, NewMail } from "../coordination/engine";
import { CHILD_OPEN, refIssue, type Issue, type WorkStore } from "../tasks/store";
import { routeUp } from "./escalation";
import { clip, type Asker } from "./forks";

/** The forks that read the work store: what a claimed issue lacks, and whether a new issue repeats an open one. */

const ROOM = { agentId: "room", role: "system" } as const;
const RESEARCH = "Research: ";
const READ = /\sroom\] gaps: /;
const POOL = 100;
const NEAR = 3;
const OPEN_RESEARCH_SEEN = 5;
const COMMON = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "are", "not"]);

/** What the forks need of the room: the model, the mail engine, a log. */
export interface WorkForkDeps {
  engine: Pick<MailEngine, "seat" | "parentOf" | "folderOf" | "recipientStatus" | "post">;
  forks: Asker;
  log(message: string): void;
}

/** A seat as a mail reads it: its role and title, else its id. */
const named = (deps: WorkForkDeps, id: string): string => {
  const seat = deps.engine.seat(id);
  return seat ? `${seat.role} ${seat.title ?? id}` : id;
};

/** The `Research:` child of an issue that is still open, if one is. */
function openResearch(store: WorkStore, issue: Issue): Issue | undefined {
  return store
    .blockers(issue.id)
    .filter((ref) => ref.endsWith(CHILD_OPEN))
    .slice(0, OPEN_RESEARCH_SEEN)
    .map((ref) => store.get(refIssue(ref)))
    .find((child) => child.title.startsWith(RESEARCH));
}

/** The open question about an unclear issue: a child the claimer holds, which keeps the issue from closing until its Owner closes it. */
function research(deps: WorkForkDeps, store: WorkStore, issue: Issue, seat: string): { note: string; marked: string } {
  let child = openResearch(store, issue);
  if (!child) {
    child = store.create(
      {
        title: `${RESEARCH}${clip(issue.title, 200)}`,
        description: `What ${issue.id} means and asks for is unclear. Search the room's record, the code and the docs, and write what you found as a comment here.`,
        parent: issue.id,
        issue_type: "question",
        priority: issue.priority,
      },
      ROOM.agentId,
    );
    try {
      child = store.claim(child.id, seat);
    } catch (error) {
      deps.log(`fork gaps: ${child.id} stands unassigned: ${error instanceof Error ? error.message : error}`);
    }
  }
  return {
    note: `What ${issue.id} asks for is unclear. Before you build it, search the room's record (seatwork_knowledge), the code and the docs, and write what you found as a comment on ${child.id}. ${issue.id} cannot close while ${child.id} is open; your Owner closes both.`,
    marked: `unclear; ${child.id}`,
  };
}

/** A room mail to `to` about an issue; false, said in the log, when it could not be posted. */
async function mailed(deps: WorkForkDeps, mail: Omit<NewMail, "from" | "needs"> & { needs?: NewMail["needs"] }) {
  try {
    await deps.engine.post({ from: ROOM, needs: "nothing", ...mail });
    return true;
  } catch (error) {
    deps.log(`fork gaps: the mail "${mail.subject}" was not posted: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** An issue with no acceptance criteria: its creator, a seat other than the claimer, is asked for them. */
async function askAcceptance(deps: WorkForkDeps, issue: Issue, seat: string) {
  if (issue.acceptance_criteria.trim()) return null;
  const creator = issue.created_by;
  if (creator === seat)
    return {
      note: `${issue.id} has no acceptance criteria and you made it. Write them into the issue (seatwork_work do=update acceptance_criteria=...) before you hand in.`,
      marked: "no-acceptance; its claimer made it",
    };
  if (!deps.engine.seat(creator) || (await deps.engine.recipientStatus(creator)) === "gone") return null;
  const sent = await mailed(deps, {
    to: [creator],
    priority: "action",
    subject: `ACCEPTANCE NEEDED: ${issue.id} "${clip(issue.title, 80)}"`,
    body: `${named(deps, seat)} took ${issue.id}, which has no acceptance criteria. Add them: seatwork_work do=update id=${issue.id} acceptance_criteria=<how anyone can tell it is done>. The seat goes on meanwhile.`,
    why: "an issue you made was claimed and has no acceptance criteria",
  });
  return sent
    ? {
        note: `${issue.id} has no acceptance criteria. ${named(deps, creator)}, who made it, was asked for them. Go on, and say in a comment how you will tell it is done.`,
        marked: `no-acceptance; asked ${creator}`,
      }
    : null;
}

/** An issue that needs a decision first: asked of the seat the escalation fork picks, else the claimer's Owner. */
async function askDecision(deps: WorkForkDeps, issue: Issue, seat: string) {
  const owner = deps.engine.parentOf(seat);
  if (!owner) return null;
  const draft: NewMail = {
    from: ROOM,
    to: [owner],
    priority: "action",
    subject: `ISSUE NEEDS A DECISION: ${issue.id} "${clip(issue.title, 80)}"`,
    body: `${named(deps, seat)} took ${issue.id}, which leaves a choice open that someone with the authority must make before work can start. Read it (seatwork_work do=show id=${issue.id}), decide, and answer ${seat} by mail. The seat waits.`,
    needs: "decision",
    why: "a seat under you took an issue that needs a decision first",
  };
  const routed = await routeUp(deps, seat, draft, "DECISION_NEEDED");
  const out = routed?.draft ?? draft;
  if (!(await mailed(deps, out))) return null;
  const asked = [out.to].flat()[0];
  return {
    note: `${issue.id} needs a decision before you build it. ${asked === owner ? "Your Owner" : named(deps, asked)} was asked, and you hear by mail. Wait for it.`,
    marked: `needs-decision; asked ${asked}`,
  };
}

/** An issue that is more than one seat's work: the claimer's Owner is told, in a mail read with its next. */
async function suggestSplit(deps: WorkForkDeps, issue: Issue, seat: string) {
  const owner = deps.engine.parentOf(seat);
  if (!owner) return null;
  const sent = await mailed(deps, {
    to: [owner],
    priority: "fyi",
    quiet: true,
    subject: `SPLIT SUGGESTED: ${issue.id} "${clip(issue.title, 80)}"`,
    body: `${named(deps, seat)} took ${issue.id}, which reads as more than one seat's work. Consider splitting it into issues under it (seatwork_work do=create parent=${issue.id}) and giving each its own seat.`,
    why: "an issue a seat under you took looks too big for one seat",
  });
  return sent
    ? {
        note: `${issue.id} reads as more than one seat's work. Your Owner was told, and may split it.`,
        marked: "too-big",
      }
    : null;
}

/** What a claimed issue lacks, as the decision model reads it, and what the room does about it; null where nothing is done. */
async function readGaps(deps: WorkForkDeps, store: WorkStore, seat: string, id: string) {
  if (!deps.forks.open("gaps")) return null;
  const issue = store.get(id);
  if (READ.test(issue.notes) || issue.title.startsWith(RESEARCH)) return null;
  const said = (text: string, most: number) => clip(text.trim(), most) || "(none)";
  const label = await deps.forks.take("gaps", {
    issue: {
      title: said(issue.title, 300),
      description: said(issue.description, 1500),
      acceptance: said(issue.acceptance_criteria, 800),
      write_scope: said(issue.write_scope, 300),
    },
  });
  const done =
    label === "unclear"
      ? research(deps, store, issue, seat)
      : label === "no-acceptance"
        ? await askAcceptance(deps, issue, seat)
        : label === "needs-decision"
          ? await askDecision(deps, issue, seat)
          : label === "too-big"
            ? await suggestSplit(deps, issue, seat)
            : null;
  if (!done) return null;
  try {
    store.update(issue.id, { append_notes: `gaps: ${done.marked}` }, ROOM.agentId);
  } catch (error) {
    deps.log(`fork gaps: ${issue.id} was not marked as read: ${error instanceof Error ? error.message : error}`);
  }
  return { note: done.note };
}

/** The words of a title that tell it from another. */
const wordsOf = (title: string): Set<string> =>
  new Set((title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((word) => !COMMON.has(word)));

/** The open issues whose titles share at least two words and half the shorter title with `title`, the closest first, at most NEAR. */
function similar(title: string, pool: readonly Issue[]): Issue[] {
  const mine = wordsOf(title);
  return pool
    .map((issue) => {
      const theirs = wordsOf(issue.title);
      const shared = [...mine].filter((word) => theirs.has(word)).length;
      return { issue, shared, share: shared / Math.max(1, Math.min(mine.size, theirs.size)) };
    })
    .filter(({ shared, share }) => shared >= 2 && share >= 0.5)
    .sort((a, b) => b.share - a.share || b.shared - a.shared)
    .slice(0, NEAR)
    .map(({ issue }) => issue);
}

/** The open issue a new one repeats, as the decision model reads it, linked to it as related; never merged or closed. */
async function readDuplicates(deps: WorkForkDeps, store: WorkStore, id: string) {
  if (!deps.forks.open("duplicate")) return null;
  const made = store.get(id);
  const pool = (["open", "in_progress"] as const)
    .flatMap((status) => store.list({ status, limit: POOL }).issues)
    .filter((issue) => issue.id !== made.id);
  const near = similar(made.title, pool);
  if (near.length === 0) return null;
  const label = await deps.forks.take(
    "duplicate",
    {
      new: { title: clip(made.title, 300), description: clip(made.description.trim(), 600) || "(none)" },
      open: Object.fromEntries(
        near.map((issue) => [
          issue.id,
          { title: clip(issue.title, 200), description: clip(issue.description.trim(), 300) || "(none)" },
        ]),
      ),
    },
    {
      none: "it is a different piece of work from every open issue listed",
      ...Object.fromEntries(near.map((issue) => [issue.id, `it asks for the same work as ${issue.id}`])),
    },
  );
  const twin = near.find((issue) => issue.id === label);
  if (!twin) return null;
  store.addDependency(made.id, twin.id, "related", ROOM.agentId);
  return {
    duplicate_of: twin.id,
    note: `${twin.id} "${clip(twin.title, 100)}" is open and looks like the same work. The two are linked as related. Read it before you start, and tell your Owner if they are one.`,
  };
}

/** What the forks add to a seat's work call: after a claim, what the issue lacks; after a create, the open issue it may repeat. A fork that fails leaves the call's own answer. */
export async function afterWork(
  deps: WorkForkDeps,
  store: WorkStore,
  seat: string,
  args: Record<string, unknown>,
  answer: unknown,
): Promise<unknown> {
  const id = (answer as { id?: unknown } | null)?.id;
  const fork = args.do === "claim" ? "gaps" : args.do === "create" && !Array.isArray(args.issues) ? "duplicate" : null;
  if (!fork || typeof id !== "string") return answer;
  try {
    const found = fork === "gaps" ? await readGaps(deps, store, seat, id) : await readDuplicates(deps, store, id);
    return found ? { ...(answer as object), ...found } : answer;
  } catch (error) {
    deps.log(`fork ${fork}: nothing was done for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return answer;
  }
}
