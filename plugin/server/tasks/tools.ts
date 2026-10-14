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

/** The room's work policy with the project's own policy.json on top, checked. */
export function projectPolicy(root: string, room: WorkPolicy): WorkPolicy {
  const file = join(root, WORK_DIR, "policy.json");
  if (!existsSync(file)) return room;
  let own: Partial<WorkPolicy>;
  try {
    own = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkPolicy>;
  } catch {
    throw new WorkError("VALIDATION_FAILED", `${file} is not JSON: fix it or remove it`);
  }
  const merged = { ...room, ...own, close: { ...room.close, ...own.close } };
  const kinds = [
    typeof merged.busyTimeoutMs,
    typeof merged.flushAfterMs,
    typeof merged.staleClaimMinutes,
    typeof merged.close.minReasonChars,
  ];
  if (kinds.some((kind) => kind !== "number") || typeof merged.close.forbidSelfClose !== "boolean")
    throw new WorkError(
      "VALIDATION_FAILED",
      `${file} sets a key of the wrong kind: numbers, and forbidSelfClose true or false`,
    );
  return merged;
}

/** The seat a call comes from; an Owner is a seat that launches others. */
export interface Caller {
  id: string;
  owner: boolean;
}

type Args = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const need = (args: Args, field: string): string => {
  const value = text(args[field])?.trim();
  if (!value) throw new WorkError("VALIDATION_FAILED", `give \`${field}\``);
  return value;
};
const limitOf = (args: Args, fallback: number) =>
  Number(args.limit) >= 1 ? Math.min(Math.trunc(Number(args.limit)), 1000) : fallback;
/** A whole number from a number or its text; refused when it is anything else. */
function whole(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number))
    throw new WorkError("VALIDATION_FAILED", `\`${field}\` is a whole number`);
  return number;
}
/** A time as ISO text; null clears it. */
function when(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(at))
    throw new WorkError("VALIDATION_FAILED", "`defer_until` is a time, such as 2026-10-20T09:00:00Z");
  return new Date(at).toISOString();
}

function newIssue(from: Args): NewIssue & { key?: string } {
  if (!from || typeof from !== "object" || Array.isArray(from))
    throw new WorkError("VALIDATION_FAILED", "each of `issues` is an object with a title");
  return {
    title: text(from.title) ?? "",
    description: text(from.description),
    design: text(from.design),
    acceptance_criteria: text(from.acceptance_criteria),
    write_scope: text(from.write_scope),
    priority: whole(from.priority, "priority"),
    issue_type: text(from.issue_type) as IssueType | undefined,
    labels: Array.isArray(from.labels) ? from.labels.map(String) : undefined,
    parent: text(from.parent),
    deps: Array.isArray(from.deps)
      ? from.deps.map((dep) => {
          if (typeof dep === "string") return { id: dep };
          if (!dep || typeof dep !== "object" || typeof (dep as Args).id !== "string")
            throw new WorkError("VALIDATION_FAILED", "each of `deps` is an id, a key, or {id, type}");
          return { id: (dep as Args).id as string, type: text((dep as Args).type) as DependencyType | undefined };
        })
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
export function work(store: WorkStore, policy: WorkPolicy, caller: Caller, args: Args): unknown {
  const actor = caller.id;
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
            priority: whole(args.priority, "priority"),
            issue_type: text(args.issue_type) as IssueType | undefined,
            labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
            status: text(args.status) as Exclude<Status, "closed"> | undefined,
            assignee: args.assignee === null ? null : args.assignee === "me" ? actor : text(args.assignee),
            defer_until: when(args.defer_until),
            if_revision: whole(args.if_revision, "if_revision"),
          },
          actor,
          caller.owner,
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
      store.removeDependency(need(args, "id"), need(args, "on"), actor, text(args.type) as DependencyType | undefined);
      return { id: store.get(need(args, "id")).id, blocked_by: store.blockers(need(args, "id")) };
    case "close": {
      if (!caller.owner)
        throw new WorkError(
          "POLICY_VIOLATION",
          "closing is your Owner's: report CANDIDATE or DONE, and it closes the issue",
        );
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
