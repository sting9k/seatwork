import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import config from "../../shared/work.json";
import { SQL_DIR } from "../paths";
import { Sqlite, keptOutOfGit, type Param, type Row } from "../sqlite";

/** A project's work store in SQLite: issues, dependencies, comments, an audit trail. */

export type Status = "open" | "in_progress" | "deferred" | "closed";
export type IssueType = "task" | "bug" | "feature" | "epic" | "chore" | "docs" | "question";
export type DependencyType = "blocks" | "parent-child" | "discovered-from" | "related";
export const STATUSES = config.statuses as readonly Status[];
export const ISSUE_TYPES = config.issueTypes as readonly IssueType[];
export const DEPENDENCY_TYPES = Object.keys(config.dependencyTypes) as DependencyType[];
const ORDERING = Object.entries(config.dependencyTypes as Record<string, { orders?: boolean }>)
  .filter(([, rule]) => rule.orders)
  .map(([type]) => type);

export interface Issue {
  id: string;
  title: string;
  description: string;
  design: string;
  acceptance_criteria: string;
  notes: string;
  write_scope: string;
  status: Status;
  priority: number;
  issue_type: IssueType;
  assignee: string | null;
  labels: string[];
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
  closed_by: string | null;
  defer_until: string | null;
}

export interface Dependency {
  issue_id: string;
  depends_on_id: string;
  type: DependencyType;
}

export interface Comment {
  author: string;
  text: string;
  created_at: string;
}

export interface NewIssue {
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  write_scope?: string;
  priority?: number;
  issue_type?: IssueType;
  labels?: string[];
  parent?: string;
  deps?: { type?: DependencyType; id: string }[];
}

export interface ClosePolicy {
  minReasonChars: number;
  forbidSelfClose: boolean;
}

export interface WorkPolicy {
  busyTimeoutMs: number;
  flushAfterMs: number;
  staleClaimMinutes: number;
  close: ClosePolicy;
}

export type WorkErrorCode =
  | "ISSUE_NOT_FOUND"
  | "AMBIGUOUS_ID"
  | "VALIDATION_FAILED"
  | "CYCLE_DETECTED"
  | "ALREADY_ASSIGNED"
  | "BLOCKED"
  | "CLOSE_INCOMPLETE"
  | "POLICY_VIOLATION"
  | "UPDATE_PRECONDITION_FAILED"
  | "DATABASE_LOCKED"
  | "MIGRATION_INVALID"
  | "SCHEMA_TOO_NEW";

/** A refusal of the store; `retryable` says the same call may go through a moment later. */
export class WorkError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: WorkErrorCode,
    message: string,
  ) {
    super(message);
    this.retryable = code === "DATABASE_LOCKED";
  }
}

const EDITABLE = [
  "title",
  "description",
  "design",
  "acceptance_criteria",
  "write_scope",
  "priority",
  "issue_type",
  "defer_until",
  "assignee",
  "status",
] as const;
type Editable = (typeof EDITABLE)[number];
const NAMED_EVENT: Partial<Record<Editable, string>> = {
  status: "status_changed",
  priority: "priority_changed",
  assignee: "assignee_changed",
};
const ORDERED = "priority, created_at, id";
/** Held: a blocker of the issue or of a parent is open, or it has open children. */
/** A blocked parent holds its children back from `ready`, never from being started or closed (br #355, #357). */
export const PARENT_BLOCKED = ":parent-blocked";
/** An open child keeps its parent from closing, never from being started (br #315). */
export const CHILD_OPEN = ":child-open";
/** The issue a blocker ref names. */
export const refIssue = (ref: string): string => ref.replace(/:(parent-blocked|child-open)$/, "");
const HELD = `
WITH RECURSIVE
  held (id) AS (
    SELECT d.issue_id FROM dependencies d JOIN issues b ON b.id = d.depends_on_id
    WHERE d.type = 'blocks' AND b.status != 'closed'
    UNION
    SELECT d.issue_id FROM held JOIN dependencies d INDEXED BY dependencies_by_target
      ON d.depends_on_id = held.id AND d.type = 'parent-child'
  ),
  parents (id) AS (
    SELECT d.depends_on_id FROM dependencies d JOIN issues c ON c.id = d.issue_id
    WHERE d.type = 'parent-child' AND c.status != 'closed'
  )`;
/** What stands in each issue's way, as br writes it: a blocker of its own, its parent when that is blocked, an open child. */
const IN_THE_WAY = `
WITH RECURSIVE
  hard (id, ref) AS (
    SELECT d.issue_id, d.depends_on_id FROM dependencies d JOIN issues b ON b.id = d.depends_on_id
    WHERE d.type = 'blocks' AND b.status != 'closed'
  ),
  under (id, ref) AS (
    SELECT d.issue_id, d.depends_on_id FROM dependencies d INDEXED BY dependencies_by_target
    WHERE d.type = 'parent-child' AND d.depends_on_id IN (SELECT id FROM hard)
    UNION
    SELECT d.issue_id, d.depends_on_id FROM under CROSS JOIN dependencies d INDEXED BY dependencies_by_target
      ON d.depends_on_id = under.id AND d.type = 'parent-child'
  ),
  way (id, ref) AS (
    SELECT id, ref FROM hard
    UNION SELECT id, ref || '${PARENT_BLOCKED}' FROM under
    UNION SELECT d.depends_on_id, d.issue_id || '${CHILD_OPEN}' FROM dependencies d JOIN issues c ON c.id = d.issue_id
      WHERE d.type = 'parent-child' AND c.status != 'closed'
  )`;
const INSERT_ISSUE =
  "INSERT INTO issues (id, title, description, design, acceptance_criteria, notes, write_scope, status, priority, issue_type, assignee, labels, revision, created_at, created_by, updated_at, closed_at, close_reason, closed_by, defer_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const toIssue = (row: Row): Issue => ({
  ...(row as unknown as Issue),
  labels: JSON.parse(String(row.labels)) as string[],
});

function databaseIn(dir: string): string {
  return join(keptOutOfGit(dir), "work.db");
}

export class WorkStore extends Sqlite {
  private readonly jsonl: string;
  private pending: NodeJS.Timeout | undefined;

  constructor(
    dir: string,
    private readonly policy: Pick<WorkPolicy, "busyTimeoutMs" | "flushAfterMs">,
    private readonly now: () => Date = () => new Date(),
    scripts: string = join(SQL_DIR, "work"),
  ) {
    super(databaseIn(dir), {
      busyTimeoutMs: policy.busyTimeoutMs,
      scripts,
      fail: (code, message) => new WorkError(code, message),
      name: "the work store",
      now,
    });
    this.jsonl = join(dir, "issues.jsonl");
    // a new database gets its issues back from the text copy
    try {
      if (this.count() === 0 && existsSync(this.jsonl)) this.restore();
    } catch (error) {
      super.close();
      throw error;
    }
  }

  override close(): void {
    this.flush();
    super.close();
  }

  private write<T>(work: () => T): T {
    const done = this.transaction("write", work);
    // the text copy follows a moment later, once for a burst of writes
    this.pending ??= setTimeout(() => {
      try {
        this.flush();
      } catch (error) {
        this.pending = undefined;
        console.error(`seatwork: the text copy of the work store was not written: ${(error as Error).message}`);
      }
    }, this.policy.flushAfterMs).unref();
    return done;
  }

  /** Writes the store as text, an issue a line: what a person reads and a restore needs. */
  flush(): void {
    clearTimeout(this.pending);
    this.pending = undefined;
    const lines = this.transaction("read", () => {
      const deps = new Map<string, Dependency[]>();
      for (const dep of this.dependencies()) deps.set(dep.issue_id, [...(deps.get(dep.issue_id) ?? []), dep]);
      const said = new Map<string, Comment[]>();
      for (const one of this.rows<Comment & { issue_id: string }>(
        "SELECT issue_id, author, text, created_at FROM comments ORDER BY id",
      ))
        said.set(one.issue_id, [
          ...(said.get(one.issue_id) ?? []),
          { author: one.author, text: one.text, created_at: one.created_at },
        ]);
      return this.all().map((issue) =>
        JSON.stringify({ ...issue, dependencies: deps.get(issue.id) ?? [], comments: said.get(issue.id) ?? [] }),
      );
    });
    // a name of its own: two processes that flush at once each rename a whole file
    const scratch = `${this.jsonl}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(scratch, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    renameSync(scratch, this.jsonl);
  }

  /** Reads the text copy into an empty database: issues first, then what joins them. */
  private restore(): void {
    const read = readFileSync(this.jsonl, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line) as Issue & { dependencies?: Dependency[]; comments?: Comment[] }] : [];
        } catch {
          return [];
        }
      });
    this.transaction("write", () => {
      if (this.count() > 0) return;
      const kept = new Set<string>();
      for (const one of read) {
        if (!one || typeof one.id !== "string" || typeof one.title !== "string" || !STATUSES.includes(one.status))
          continue;
        this.run(
          INSERT_ISSUE,
          one.id,
          one.title,
          one.description ?? "",
          one.design ?? "",
          one.acceptance_criteria ?? "",
          one.notes ?? "",
          one.write_scope ?? "",
          one.status,
          one.priority,
          one.issue_type,
          one.assignee ?? null,
          JSON.stringify(one.labels ?? []),
          one.revision ?? 1,
          one.created_at,
          one.created_by,
          one.updated_at,
          one.closed_at ?? null,
          one.close_reason ?? null,
          one.closed_by ?? null,
          one.defer_until ?? null,
        );
        this.event(one.id, "restored", "room", null, null);
        kept.add(one.id);
      }
      if (kept.size < read.length)
        console.error(`seatwork: ${read.length - kept.size} lines of ${this.jsonl} could not be read back`);
      for (const one of read.filter((line) => kept.has(line?.id))) {
        for (const dep of (one.dependencies ?? []).filter((dep) => kept.has(dep.depends_on_id)))
          this.run(
            "INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, ?, ?, 'room')",
            one.id,
            dep.depends_on_id,
            dep.type,
            this.stamp(),
          );
        for (const said of one.comments ?? [])
          this.run(
            "INSERT INTO comments (issue_id, author, text, created_at) VALUES (?, ?, ?, ?)",
            one.id,
            said.author,
            said.text,
            said.created_at,
          );
      }
    });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private event(id: string, type: string, actor: string, from: string | null, to: string | null): void {
    this.run(
      "INSERT INTO events (issue_id, event_type, actor, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      type,
      actor,
      from,
      to,
      this.stamp(),
    );
  }

  private find(id: string): Issue | null {
    const found = this.row("SELECT * FROM issues WHERE id = ?", id);
    return found ? toIssue(found) : null;
  }

  /** The next child id under a parent, else the shortest free hash of the title. */
  private newId(title: string, parent: string | null): string {
    if (parent) {
      const top = this.row<{ n: number | null }>(
        "SELECT max(CAST(substr(id, ?2) AS INTEGER)) AS n FROM issues WHERE id > ?1 AND id < ?3 AND instr(substr(id, ?2), '.') = 0",
        `${parent}.`,
        parent.length + 2,
        `${parent}/`,
      );
      return `${parent}.${(top?.n ?? 0) + 1}`;
    }
    const digest = BigInt(
      `0x${createHash("sha256").update(title).update(randomBytes(8)).digest("hex").slice(0, 16)}`,
    ).toString(36);
    for (let length = 3; length <= 8; length += 1) {
      const id = `${config.idPrefix}-${digest.slice(0, length)}`;
      if (!this.find(id)) return id;
    }
    return `${config.idPrefix}-${digest}`;
  }

  /** The issue an id names; a unique start of it after the prefix is enough. */
  get(id: string): Issue {
    const asked = id.trim();
    if (asked.replace(new RegExp(`^${config.idPrefix}-?`), "") === "")
      throw new WorkError("VALIDATION_FAILED", "give an issue id");
    const start = asked.startsWith(`${config.idPrefix}-`) ? asked : `${config.idPrefix}-${asked}`;
    const exact = this.find(asked) ?? this.find(start);
    if (exact) return exact;
    // a range on the key, which its index serves
    const found = this.rows("SELECT * FROM issues WHERE id >= ? AND id < ? LIMIT 4", start, `${start}\u{10ffff}`);
    if (found.length === 1) return toIssue(found[0]);
    if (found.length > 1)
      throw new WorkError("AMBIGUOUS_ID", `"${id}" fits several issues: ${found.map((one) => one.id).join(", ")}`);
    throw new WorkError("ISSUE_NOT_FOUND", `no issue ${id}`);
  }

  count(): number {
    return this.row<{ n: number }>("SELECT COUNT(*) AS n FROM issues")!.n;
  }

  all(): Issue[] {
    return this.rows("SELECT * FROM issues ORDER BY created_at, id").map(toIssue);
  }

  dependencies(): Dependency[] {
    return this.rows<Dependency>(
      "SELECT issue_id, depends_on_id, type FROM dependencies ORDER BY issue_id, depends_on_id",
    );
  }

  /** The issues not closed and the edges among them: all the graph reads. */
  openWork(): { issues: Issue[]; dependencies: Dependency[]; ready: Set<string>; blocked: Map<string, string[]> } {
    return this.transaction("read", () => ({
      ready: new Set(this.ready().map((issue) => issue.id)),
      blocked: this.inTheWay(),
      issues: this.rows(
        `SELECT * FROM issues WHERE status IN ('open', 'in_progress', 'deferred') ORDER BY ${ORDERED}`,
      ).map(toIssue),
      dependencies: this.rows<Dependency>(
        "SELECT d.issue_id, d.depends_on_id, d.type FROM dependencies d JOIN issues a ON a.id = d.issue_id JOIN issues b ON b.id = d.depends_on_id WHERE a.status != 'closed' AND b.status != 'closed'",
      ),
    }));
  }

  create(input: NewIssue, actor: string): Issue {
    return this.write(() => this.insert(input, actor));
  }

  /** A whole plan in one write, all or none; issues name each other by `key`. */
  createMany(inputs: readonly (NewIssue & { key?: string })[], actor: string): Issue[] {
    return this.write(() => {
      const ids = new Map<string, string>();
      const named = (id: string) => ids.get(id) ?? id;
      const made = inputs.map((input) => {
        const issue = this.insert({ ...input, parent: input.parent && named(input.parent), deps: [] }, actor);
        if (input.key) ids.set(input.key, issue.id);
        return issue;
      });
      // every issue exists before the first edge: an issue may wait for one listed after it
      inputs.forEach((input, index) => {
        for (const dep of input.deps ?? [])
          this.link(made[index].id, this.get(named(dep.id)).id, dep.type ?? "blocks", actor);
      });
      return made;
    });
  }

  private insert(input: NewIssue, actor: string): Issue {
    const title = input.title?.trim() ?? "";
    if (!title || title.length > config.titleChars)
      throw new WorkError("VALIDATION_FAILED", `a title is 1 to ${config.titleChars} characters`);
    const priority = input.priority ?? 2;
    if (!Number.isInteger(priority) || priority < 0 || priority > 4)
      throw new WorkError("VALIDATION_FAILED", "priority is 0 (critical) to 4 (backlog)");
    const type = input.issue_type ?? "task";
    if (!ISSUE_TYPES.includes(type))
      throw new WorkError("VALIDATION_FAILED", `issue_type is one of ${ISSUE_TYPES.join(", ")}`);
    const parent = input.parent ? this.get(input.parent).id : null;
    const id = this.newId(title, parent);
    const at = this.stamp();
    this.run(
      INSERT_ISSUE,
      id,
      title,
      input.description ?? "",
      input.design ?? "",
      input.acceptance_criteria ?? "",
      "",
      input.write_scope ?? "",
      "open",
      priority,
      type,
      null,
      JSON.stringify(input.labels ?? []),
      1,
      at,
      actor,
      at,
      null,
      null,
      null,
      null,
    );
    this.event(id, "created", actor, null, title);
    if (parent) this.link(id, parent, "parent-child", actor);
    for (const dep of input.deps ?? []) this.link(id, this.get(dep.id).id, dep.type ?? "blocks", actor);
    return this.find(id)!;
  }

  /** `issue` depends on `on`; the cycle check and the insert are one write. */
  private link(issue: string, on: string, type: DependencyType, actor: string): void {
    if (!DEPENDENCY_TYPES.includes(type))
      throw new WorkError("VALIDATION_FAILED", `a dependency is one of ${DEPENDENCY_TYPES.join(", ")}`);
    if (issue === on) throw new WorkError("CYCLE_DETECTED", `${issue} cannot depend on itself`);
    if (ORDERING.includes(type)) {
      const back =
        type === "blocks"
          ? this.reaches(on, false, issue, true)
          : this.reaches(issue, false, on, false) || this.reaches(on, true, issue, true);
      if (back)
        throw new WorkError("CYCLE_DETECTED", `${issue} → ${on} would close a cycle: ${on} already waits for ${issue}`);
    }
    this.run(
      "INSERT OR IGNORE INTO dependencies (issue_id, depends_on_id, type, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
      issue,
      on,
      type,
      this.stamp(),
      actor,
    );
    this.run("UPDATE issues SET updated_at = ? WHERE id = ?", this.stamp(), issue);
    this.event(issue, "dependency_added", actor, null, `${type}:${on}`);
  }

  /** Whether `from` already waits for `target`, or for what is under it when `under`. */
  private reaches(from: string, above: boolean, target: string, under: boolean): boolean {
    return (
      this.row(
        `WITH RECURSIVE
           walk (id, up) AS (
             SELECT ?1, ?2
             UNION
             SELECT d.depends_on_id, 0 FROM walk CROSS JOIN dependencies d ON d.issue_id = walk.id AND d.type = 'blocks'
             UNION
             SELECT d.issue_id, 0 FROM walk CROSS JOIN dependencies d INDEXED BY dependencies_by_target
               ON d.depends_on_id = walk.id AND d.type = 'parent-child' WHERE walk.up = 0
             UNION
             SELECT d.depends_on_id, 1 FROM walk CROSS JOIN dependencies d ON d.issue_id = walk.id AND d.type = 'parent-child'
           ),
           goal (id) AS (
             SELECT ?3
             UNION
             SELECT d.issue_id FROM goal CROSS JOIN dependencies d INDEXED BY dependencies_by_target
               ON d.depends_on_id = goal.id AND d.type = 'parent-child' WHERE ?4 = 1
           )
         SELECT 1 AS found FROM walk WHERE up = 0 AND id IN (SELECT id FROM goal) LIMIT 1`,
        from,
        above ? 1 : 0,
        target,
        under ? 1 : 0,
      ) !== undefined
    );
  }

  addDependency(issue: string, on: string, type: DependencyType, actor: string): void {
    this.write(() => this.link(this.get(issue).id, this.get(on).id, type, actor));
  }

  /** Removes the edge of `type`, or every edge but parent-child when none is named. */
  removeDependency(issue: string, on: string, actor: string, type?: DependencyType): void {
    this.write(() => {
      const [a, b] = [this.get(issue).id, this.get(on).id];
      this.run(
        "DELETE FROM dependencies WHERE issue_id = ? AND depends_on_id = ? AND (type = ?3 OR (?3 IS NULL AND type != 'parent-child'))",
        a,
        b,
        type ?? null,
      );
      this.run("UPDATE issues SET updated_at = ? WHERE id = ?", this.stamp(), a);
      this.event(a, "dependency_removed", actor, b, type ?? null);
    });
  }

  /** What stands in an issue's way, as br's refs: a bare id blocks it, a suffix says it only holds it back. */
  blockers(id: string): string[] {
    const issue = this.get(id).id;
    return this.rows<{ ref: string }>(`${IN_THE_WAY} SELECT ref FROM way WHERE id = ? ORDER BY ref`, issue).map(
      (row) => row.ref,
    );
  }

  /** What keeps an issue from being started: its own blockers only. */
  private startBlockers(id: string): string[] {
    return this.blockers(id).filter((ref) => !ref.endsWith(PARENT_BLOCKED) && !ref.endsWith(CHILD_OPEN));
  }

  /** What keeps an issue from being closed: its own blockers and its open children. */
  private closeBlockers(id: string): string[] {
    return this.blockers(id)
      .filter((ref) => !ref.endsWith(PARENT_BLOCKED))
      .map(refIssue);
  }

  /** What stands in the way of every issue that has anything in its way. */
  private inTheWay(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const row of this.rows<{ id: string; ref: string }>(`${IN_THE_WAY} SELECT id, ref FROM way ORDER BY id, ref`))
      out.set(row.id, [...(out.get(row.id) ?? []), row.ref]);
    return out;
  }

  /** Open, not put off, and with nothing in its way: highest priority first, then oldest. */
  ready(options: { limit?: number; parent?: string; unassigned?: boolean } = {}): Issue[] {
    const parent = options.parent ? this.get(options.parent).id : null;
    return this.rows(
      `${HELD},
       below (id) AS (
         SELECT d.issue_id FROM dependencies d INDEXED BY dependencies_by_target WHERE d.depends_on_id = ?4 AND d.type = 'parent-child'
         UNION
         SELECT d.issue_id FROM below CROSS JOIN dependencies d INDEXED BY dependencies_by_target
           ON d.depends_on_id = below.id AND d.type = 'parent-child'
       )
       SELECT i.* FROM issues i
       WHERE i.status = 'open' AND (i.defer_until IS NULL OR i.defer_until <= ?1)
         AND i.id NOT IN (SELECT id FROM held) AND i.id NOT IN (SELECT id FROM parents)
         AND (?2 = 0 OR i.assignee IS NULL) AND (?4 IS NULL OR i.id IN (SELECT id FROM below))
       ORDER BY i.priority, i.created_at, i.id LIMIT ?3`,
      this.stamp(),
      options.unassigned ? 1 : 0,
      options.limit ?? -1,
      parent,
    ).map(toIssue);
  }

  list(filter: { status?: Status; assignee?: string; type?: IssueType; limit?: number } = {}): {
    issues: Issue[];
    total: number;
  } {
    // only the filters given go into the query, so each one can use its index
    const given = (["status", "assignee", "issue_type"] as const).flatMap((column) => {
      const value = { status: filter.status, assignee: filter.assignee, issue_type: filter.type }[column];
      return value === undefined ? [] : [{ column, value }];
    });
    const where = given.length ? `WHERE ${given.map(({ column }) => `${column} = ?`).join(" AND ")}` : "";
    const params = given.map(({ value }) => value);
    return this.transaction("read", () => ({
      issues: this.rows(`SELECT * FROM issues ${where} ORDER BY ${ORDERED} LIMIT ?`, ...params, filter.limit ?? -1).map(
        toIssue,
      ),
      total: this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM issues ${where}`, ...params)!.n,
    }));
  }

  /** Changes one issue row and counts its revision up; a stale `if_revision` is refused. */
  private touch(issue: Issue, set: Record<string, Param>, ifRevision?: number): void {
    if (ifRevision !== undefined && ifRevision !== issue.revision)
      throw new WorkError(
        "UPDATE_PRECONDITION_FAILED",
        `${issue.id} is at revision ${issue.revision}, not ${ifRevision}: read it again`,
      );
    const assignments = Object.keys(set).map((field) => `${field} = ?, `);
    this.run(
      `UPDATE issues SET ${assignments.join("")}revision = revision + 1, updated_at = ? WHERE id = ?`,
      ...Object.values(set),
      this.stamp(),
      issue.id,
    );
  }

  /** Takes an issue for `actor` in one write: nobody else holds it, nothing blocks it. */
  claim(id: string, actor: string): Issue {
    return this.write(() => {
      const issue = this.get(id);
      if (issue.status === "closed" || issue.status === "deferred")
        throw new WorkError("VALIDATION_FAILED", `${issue.id} is ${issue.status}: it cannot be claimed`);
      if (issue.assignee && issue.assignee !== actor)
        throw new WorkError("ALREADY_ASSIGNED", `${issue.id} is already assigned to ${issue.assignee}`);
      if (issue.defer_until && issue.defer_until > this.stamp())
        throw new WorkError("BLOCKED", `${issue.id} is put off until ${issue.defer_until}`);
      const blockers = this.startBlockers(issue.id);
      if (blockers.length > 0) throw new WorkError("BLOCKED", `${issue.id} waits for ${blockers.join(", ")}`);
      this.touch(issue, { assignee: actor, status: "in_progress" });
      if (issue.status !== "in_progress") this.event(issue.id, "status_changed", actor, issue.status, "in_progress");
      if (issue.assignee !== actor) this.event(issue.id, "assignee_changed", actor, issue.assignee, actor);
      return this.find(issue.id)!;
    });
  }

  update(
    id: string,
    patch: Partial<Pick<Issue, Exclude<Editable, "status"> | "labels">> & {
      status?: Exclude<Status, "closed">;
      append_notes?: string;
      if_revision?: number;
    },
    actor: string,
    owner = false,
  ): Issue {
    return this.write(() => {
      const issue = this.get(id);
      if (issue.status === "closed" && patch.status !== undefined)
        throw new WorkError("VALIDATION_FAILED", `${issue.id} is closed: reopen it first`);
      if (patch.assignee !== undefined && patch.assignee !== issue.assignee && !owner) {
        if (patch.assignee !== null)
          throw new WorkError("VALIDATION_FAILED", "take an issue with claim; only an Owner gives one to another seat");
        if (issue.assignee && issue.assignee !== actor)
          throw new WorkError(
            "ALREADY_ASSIGNED",
            `${issue.id} is held by ${issue.assignee}: only it or an Owner lets it go`,
          );
      }
      if (patch.status === "in_progress" && issue.status !== "in_progress") {
        const blockers = this.startBlockers(issue.id);
        if (blockers.length > 0) throw new WorkError("BLOCKED", `${issue.id} waits for ${blockers.join(", ")}`);
      }
      if ((patch as { status?: string }).status === "closed")
        throw new WorkError("VALIDATION_FAILED", "an issue is closed with close, which asks for its reason");
      if (patch.status !== undefined && !STATUSES.includes(patch.status))
        throw new WorkError("VALIDATION_FAILED", `status is one of ${STATUSES.join(", ")}`);
      if (
        patch.priority !== undefined &&
        (!Number.isInteger(patch.priority) || patch.priority < 0 || patch.priority > 4)
      )
        throw new WorkError("VALIDATION_FAILED", "priority is 0 (critical) to 4 (backlog)");
      if (patch.issue_type !== undefined && !ISSUE_TYPES.includes(patch.issue_type))
        throw new WorkError("VALIDATION_FAILED", `issue_type is one of ${ISSUE_TYPES.join(", ")}`);
      if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > config.titleChars))
        throw new WorkError("VALIDATION_FAILED", `a title is 1 to ${config.titleChars} characters`);
      // only the fields an issue has: a name from outside never reaches the statement
      const set: Record<string, Param> = {};
      for (const field of EDITABLE) if (patch[field] !== undefined) set[field] = patch[field] as Param;
      if (patch.labels) set.labels = JSON.stringify(patch.labels);
      if (patch.append_notes?.trim())
        set.notes = `${issue.notes}${issue.notes ? "\n" : ""}[${this.stamp()} ${actor}] ${patch.append_notes.trim()}`;
      this.touch(issue, set, patch.if_revision);
      for (const [field, value] of Object.entries(set)) {
        const before = field === "notes" ? null : String((issue as unknown as Row)[field] ?? "");
        const after = field === "notes" ? "notes" : String(value ?? "");
        this.event(issue.id, NAMED_EVENT[field as Editable] ?? "updated", actor, before, after);
      }
      return this.find(issue.id)!;
    });
  }

  comment(id: string, author: string, text: string): void {
    if (!text.trim()) throw new WorkError("VALIDATION_FAILED", "a comment has text");
    this.write(() => {
      const issue = this.get(id);
      this.run(
        "INSERT INTO comments (issue_id, author, text, created_at) VALUES (?, ?, ?, ?)",
        issue.id,
        author,
        text.trim(),
        this.stamp(),
      );
      this.run("UPDATE issues SET updated_at = ? WHERE id = ?", this.stamp(), issue.id);
      this.event(issue.id, "commented", author, null, null);
    });
  }

  /** Closes an issue with its reason; returns it and the issues it freed. */
  closeIssue(
    id: string,
    reason: string,
    actor: string,
    policy: ClosePolicy,
    force = false,
  ): { issue: Issue; unblocked: Issue[] } {
    return this.write(() => {
      const issue = this.get(id);
      if (issue.status === "closed") throw new WorkError("VALIDATION_FAILED", `${issue.id} is closed already`);
      if (reason.trim().length < policy.minReasonChars)
        throw new WorkError(
          "POLICY_VIOLATION",
          `a close reason has at least ${policy.minReasonChars} characters: what was done, and the commit or the evidence`,
        );
      if (policy.forbidSelfClose && issue.assignee === actor)
        throw new WorkError(
          "POLICY_VIOLATION",
          `${issue.id} is yours: the seat that did the work does not close it, its Owner does`,
        );
      const blockers = this.closeBlockers(issue.id);
      if (blockers.length > 0 && !force)
        throw new WorkError("CLOSE_INCOMPLETE", `${issue.id} still waits for ${blockers.join(", ")}`);
      // what this close may free: the open issues it blocked, and its open parent
      const waiting = this.rows<{ id: string }>(
        `SELECT d.issue_id AS id FROM dependencies d JOIN issues w ON w.id = d.issue_id
           WHERE d.depends_on_id = ? AND d.type = 'blocks' AND w.status = 'open'
         UNION
         SELECT d.depends_on_id FROM dependencies d JOIN issues p ON p.id = d.depends_on_id
           WHERE d.issue_id = ? AND d.type = 'parent-child' AND p.status = 'open'`,
        issue.id,
        issue.id,
      );
      this.touch(issue, { status: "closed", closed_at: this.stamp(), close_reason: reason.trim(), closed_by: actor });
      this.event(issue.id, "closed", actor, issue.status, reason.trim());
      return {
        issue: this.find(issue.id)!,
        unblocked: waiting.filter((one) => this.blockers(one.id).length === 0).map((one) => this.find(one.id)!),
      };
    });
  }

  reopen(id: string, actor: string): Issue {
    return this.write(() => {
      const issue = this.get(id);
      if (issue.status !== "closed") throw new WorkError("VALIDATION_FAILED", `${issue.id} is not closed`);
      this.touch(issue, { status: "open", closed_at: null, close_reason: null, closed_by: null });
      this.event(issue.id, "reopened", actor, "closed", "open");
      return this.find(issue.id)!;
    });
  }

  /** A gone seat's issues in progress are open again, or go to its successor. */
  release(actor: string, successor: string | null, by: string): string[] {
    return this.write(() => {
      const held = this.rows("SELECT * FROM issues WHERE assignee = ? AND status != 'closed'", actor).map(toIssue);
      for (const issue of held) {
        this.touch(issue, {
          assignee: successor,
          status: successor || issue.status !== "in_progress" ? issue.status : "open",
        });
        this.event(issue.id, "assignee_changed", by, actor, successor);
      }
      return held.map((issue) => issue.id);
    });
  }

  comments(id: string): Comment[] {
    return this.rows<Comment>(
      "SELECT author, text, created_at FROM comments WHERE issue_id = ? ORDER BY id",
      this.get(id).id,
    );
  }

  events(
    id: string,
    limit = 20,
  ): { event_type: string; actor: string; old_value: string | null; new_value: string | null; created_at: string }[] {
    return this.rows(
      "SELECT event_type, actor, old_value, new_value, created_at FROM events WHERE issue_id = ? ORDER BY id DESC LIMIT ?",
      this.get(id).id,
      limit,
    ) as never;
  }
}
