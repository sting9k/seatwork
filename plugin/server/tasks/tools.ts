import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alerts, blockerChain, next, plan, triage } from "./graph";
import {
  WorkError,
  WorkStore,
  type DependencyType,
  type Issue,
  type IssueType,
  type NewIssue,
  type Status,
  type WorkPolicy,
} from "./store";

/** What a seat does with its project's work store through the room's two tools. */

export const WORK_DIR = join(".seatwork", ".work");

/** The room's work policy with a project's own .seatwork/.work/policy.json on top. */
export function projectPolicy(root: string, room: WorkPolicy): WorkPolicy {
  const file = join(root, WORK_DIR, "policy.json");
  if (!existsSync(file)) return room;
  const own = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkPolicy>;
  return { ...room, ...own, close: { ...room.close, ...own.close } };
}

type Args = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const need = (args: Args, field: string): string => {
  const value = text(args[field])?.trim();
  if (!value) throw new WorkError("VALIDATION_FAILED", `give \`${field}\``);
  return value;
};
const limitOf = (args: Args, fallback: number) => (Number(args.limit) > 0 ? Math.trunc(Number(args.limit)) : fallback);

function newIssue(from: Args): NewIssue & { key?: string } {
  return {
    title: text(from.title) ?? "",
    description: text(from.description),
    design: text(from.design),
    acceptance_criteria: text(from.acceptance_criteria),
    write_scope: text(from.write_scope),
    priority: typeof from.priority === "number" ? from.priority : undefined,
    issue_type: text(from.issue_type) as IssueType | undefined,
    labels: Array.isArray(from.labels) ? from.labels.map(String) : undefined,
    parent: text(from.parent),
    deps: Array.isArray(from.deps)
      ? from.deps.map((dep) =>
          typeof dep === "string"
            ? { id: dep }
            : { id: String((dep as Args).id ?? ""), type: text((dep as Args).type) as DependencyType | undefined },
        )
      : undefined,
    key: text(from.key),
  };
}

/** The short form of an issue in a list; `show` gives the whole of one. */
const brief = (issue: Issue) => ({
  id: issue.id,
  title: issue.title,
  status: issue.status,
  priority: issue.priority,
  issue_type: issue.issue_type,
  assignee: issue.assignee,
});

/** One thing done to the store, named by `do`. */
export function work(store: WorkStore, policy: WorkPolicy, actor: string, args: Args): unknown {
  const action = need(args, "do");
  switch (action) {
    case "create":
      return Array.isArray(args.issues)
        ? store
            .createMany(
              args.issues.map((one) => newIssue(one as Args)),
              actor,
            )
            .map(brief)
        : brief(store.create(newIssue(args), actor));
    case "show": {
      const issue = store.get(need(args, "id"));
      return {
        ...issue,
        blocked_by: store.blockers(issue.id),
        comments: store.comments(issue.id),
        events: store.events(issue.id, limitOf(args, 10)),
      };
    }
    case "list": {
      const found = store.list({
        status: text(args.status) as Status | undefined,
        assignee: args.assignee === "me" ? actor : text(args.assignee),
        type: text(args.issue_type) as IssueType | undefined,
        limit: limitOf(args, 50),
      });
      return { issues: found.issues.map(brief), total: found.total };
    }
    case "ready":
      return store
        .ready({ limit: limitOf(args, 20), parent: text(args.parent), unassigned: args.unassigned === true })
        .map(brief);
    case "claim":
      return brief(store.claim(need(args, "id"), actor));
    case "update":
      return brief(
        store.update(
          need(args, "id"),
          {
            title: text(args.title),
            description: text(args.description),
            design: text(args.design),
            acceptance_criteria: text(args.acceptance_criteria),
            write_scope: text(args.write_scope),
            priority: typeof args.priority === "number" ? args.priority : undefined,
            issue_type: text(args.issue_type) as IssueType | undefined,
            labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
            status: text(args.status) as Exclude<Status, "closed"> | undefined,
            assignee: args.assignee === null ? null : args.assignee === "me" ? actor : text(args.assignee),
            defer_until: args.defer_until === null ? null : text(args.defer_until),
            if_revision: typeof args.if_revision === "number" ? args.if_revision : undefined,
          },
          actor,
        ),
      );
    case "note":
      return brief(store.update(need(args, "id"), { append_notes: need(args, "text") }, actor));
    case "comment":
      store.comment(need(args, "id"), actor, need(args, "text"));
      return { commented: store.get(need(args, "id")).id };
    case "depend":
      store.addDependency(
        need(args, "id"),
        need(args, "on"),
        (text(args.type) as DependencyType | undefined) ?? "blocks",
        actor,
      );
      return { id: store.get(need(args, "id")).id, blocked_by: store.blockers(need(args, "id")) };
    case "undepend":
      store.removeDependency(need(args, "id"), need(args, "on"), actor);
      return { id: store.get(need(args, "id")).id, blocked_by: store.blockers(need(args, "id")) };
    case "close": {
      const closed = store.closeIssue(need(args, "id"), need(args, "reason"), actor, policy.close, args.force === true);
      return {
        ...brief(closed.issue),
        close_reason: closed.issue.close_reason,
        unblocked: closed.unblocked.map(brief),
      };
    }
    case "reopen":
      return brief(store.reopen(need(args, "id"), actor));
    default:
      throw new WorkError(
        "VALIDATION_FAILED",
        `\`do\` is one of create, show, list, ready, claim, update, note, comment, depend, undepend, close, reopen`,
      );
  }
}

/** One reading of the open issues as a graph, named by `view`. */
export function graph(store: WorkStore, policy: WorkPolicy, args: Args, now: Date): unknown {
  const view = need(args, "view");
  const open = store.openWork();
  switch (view) {
    case "triage":
      return triage(open, now, limitOf(args, 10));
    case "next":
      return next(open, now) ?? { claimable: false, message: "nothing is ready and unassigned" };
    case "plan":
      return plan(open, now);
    case "blockers":
      return { id: store.get(need(args, "id")).id, chain: blockerChain(open, store.get(need(args, "id")).id) };
    case "alerts":
      return alerts(open, now, policy.staleClaimMinutes);
    default:
      throw new WorkError("VALIDATION_FAILED", "`view` is one of triage, next, plan, blockers, alerts");
  }
}

/** A refusal as a seat reads it: code, sentence, and whether a retry may pass. */
export const refusal = (error: WorkError) =>
  JSON.stringify({ error: { code: error.code, message: error.message, retryable: error.retryable } });
