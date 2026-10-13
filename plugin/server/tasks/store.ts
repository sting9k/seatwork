import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import config from "../../shared/work.json";

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

const quoted = (words: readonly string[]) => words.map((word) => `'${word.replace(/[^a-z_-]/g, "")}'`).join(", ");

/** Version 1 of the layout; every lookup the store makes has an index. */
const SCHEMA_V1 = `
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${config.titleChars}),
  description TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  write_scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (${quoted(STATUSES)})),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
  issue_type TEXT NOT NULL CHECK (issue_type IN (${quoted(ISSUE_TYPES)})),
  assignee TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  closed_by TEXT,
  defer_until TEXT,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX issues_by_status ON issues (status, priority, created_at, id);
CREATE INDEX issues_by_assignee ON issues (assignee, status) WHERE assignee IS NOT NULL;
CREATE INDEX issues_by_update ON issues (status, updated_at);
CREATE TABLE dependencies (
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (${quoted(DEPENDENCY_TYPES)})),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (issue_id, depends_on_id, type),
  CHECK (issue_id != depends_on_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX dependencies_by_target ON dependencies (depends_on_id, type, issue_id);
CREATE INDEX dependencies_by_type ON dependencies (type, issue_id, depends_on_id);
CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX comments_of ON comments (issue_id, id);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX events_of ON events (issue_id, id);
`;
const MIGRATIONS: readonly string[] = [SCHEMA_V1];

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
const INSERT_ISSUE =
  "INSERT INTO issues (id, title, description, design, acceptance_criteria, notes, write_scope, status, priority, issue_type, assignee, labels, revision, created_at, created_by, updated_at, closed_at, close_reason, closed_by, defer_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
const LOCKED = "another process is writing the work store; try again";

type Row = Record<string, unknown>;
type Param = string | number | null;

const toIssue = (row: Row): Issue => ({
  ...(row as unknown as Issue),
  labels: JSON.parse(String(row.labels)) as string[],
});
const isBusy = (error: unknown) =>
  (error as { errcode?: number })?.errcode === 5 || /database is locked/i.test((error as Error)?.message ?? "");

export class WorkStore {
  private readonly db: DatabaseSync;
  private readonly file: string;
  private readonly jsonl: string;
  private readonly statements = new Map<string, StatementSync>();
  private pending: NodeJS.Timeout | undefined;
  private depth = 0;

  constructor(
    dir: string,
    private readonly policy: Pick<WorkPolicy, "busyTimeoutMs" | "flushAfterMs">,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "work.db");
    this.jsonl = join(dir, "issues.jsonl");
    this.db = this.open();
    this.migrate();
    // a new database gets its issues back from the text copy
    if (this.count() === 0 && existsSync(this.jsonl)) this.restore();
  }

  /** Opens the database; a damaged one is set aside and a new one started. */
  private open(): DatabaseSync {
    const attempt = () => {
      const db = new DatabaseSync(this.file);
      try {
        db.exec(`PRAGMA busy_timeout = ${Math.trunc(this.policy.busyTimeoutMs)}; PRAGMA journal_mode = WAL;`);
        db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
        const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
        if (check?.quick_check !== "ok") throw new Error(`quick_check: ${check?.quick_check ?? "no answer"}`);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    try {
      return attempt();
    } catch (error) {
      if (isBusy(error)) throw new WorkError("DATABASE_LOCKED", LOCKED);
      const aside = `${this.file}.damaged-${this.now().toISOString().replace(/[:.]/g, "-")}`;
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(this.file + suffix)) renameSync(this.file + suffix, aside + suffix);
      return attempt();
    }
  }

  /** Brings the layout up to this code's version, a step at a time. */
  private migrate(): void {
    const { user_version: at } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (at > MIGRATIONS.length)
      throw new WorkError(
        "SCHEMA_TOO_NEW",
        `the work store is at layout ${at} and this plugin writes ${MIGRATIONS.length}: update the plugin`,
      );
    for (let version = at; version < MIGRATIONS.length; version += 1)
      this.transaction("write", () => {
        // of two processes on a new store, the one that waited finds the step done
        const { user_version: now } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
        if (now === version) this.db.exec(`${MIGRATIONS[version]}; PRAGMA user_version = ${version + 1};`);
      });
  }

  close(): void {
    this.flush();
    this.statements.clear();
    this.db.exec("PRAGMA optimize");
    this.db.close();
  }

  private statement(sql: string): StatementSync {
    let prepared = this.statements.get(sql);
    if (!prepared) this.statements.set(sql, (prepared = this.db.prepare(sql)));
    return prepared;
  }

  private run(sql: string, ...params: Param[]): void {
    this.statement(sql).run(...params);
  }

  private rows<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  private row<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  /** One unit of work; a write takes the write lock first, so nothing it read can change. */
  private transaction<T>(mode: "read" | "write", work: () => T): T {
    if (this.depth > 0) return work();
    try {
      this.db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    } catch (error) {
      throw isBusy(error) ? new WorkError("DATABASE_LOCKED", LOCKED) : error;
    }
    this.depth += 1;
    try {
      const done = work();
      this.db.exec("COMMIT");
      return done;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw isBusy(error) ? new WorkError("DATABASE_LOCKED", LOCKED) : error;
    } finally {
      this.depth -= 1;
    }
  }

  private write<T>(work: () => T): T {
    const done = this.transaction("write", work);
    // the text copy follows a moment later, once for a burst of writes
    this.pending ??= setTimeout(() => this.flush(), this.policy.flushAfterMs).unref();
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
      for (const one of read) {
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
      }
      for (const one of read) {
        for (const dep of one.dependencies ?? [])
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
    if (parent) for (let next = 1; ; next += 1) if (!this.find(`${parent}.${next}`)) return `${parent}.${next}`;
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
    const exact = this.find(asked);
    if (exact) return exact;
    const start = asked.startsWith(`${config.idPrefix}-`) ? asked : `${config.idPrefix}-${asked}`;
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
  openWork(): { issues: Issue[]; dependencies: Dependency[] } {
    return this.transaction("read", () => ({
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
    {
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
  }

  /** `issue` depends on `on`; the cycle check and the insert are one write. */
  private link(issue: string, on: string, type: DependencyType, actor: string): void {
    if (!DEPENDENCY_TYPES.includes(type))
      throw new WorkError("VALIDATION_FAILED", `a dependency is one of ${DEPENDENCY_TYPES.join(", ")}`);
    if (issue === on) throw new WorkError("CYCLE_DETECTED", `${issue} cannot depend on itself`);
    if (ORDERING.includes(type)) {
      const back = this.row(
        `WITH RECURSIVE waits (id) AS (
           SELECT ? UNION
           SELECT d.depends_on_id FROM waits CROSS JOIN dependencies d
             ON d.issue_id = waits.id AND d.type IN (${quoted(ORDERING)})
         ) SELECT 1 AS found FROM waits WHERE id = ? LIMIT 1`,
        on,
        issue,
      );
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
    this.event(issue, "dependency_added", actor, null, `${type}:${on}`);
  }

  addDependency(issue: string, on: string, type: DependencyType, actor: string): void {
    this.write(() => this.link(this.get(issue).id, this.get(on).id, type, actor));
  }

  removeDependency(issue: string, on: string, actor: string): void {
    this.write(() => {
      const [a, b] = [this.get(issue).id, this.get(on).id];
      this.run("DELETE FROM dependencies WHERE issue_id = ? AND depends_on_id = ?", a, b);
      this.event(a, "dependency_removed", actor, b, null);
    });
  }

  /** What stands in one issue's way. */
  blockers(id: string): string[] {
    const issue = this.get(id).id;
    return this.rows<{ id: string }>(
      `WITH RECURSIVE up (id) AS (
         SELECT ? UNION
         SELECT d.depends_on_id FROM up CROSS JOIN dependencies d ON d.issue_id = up.id AND d.type = 'parent-child'
       )
       SELECT d.depends_on_id AS id FROM up JOIN dependencies d ON d.issue_id = up.id AND d.type = 'blocks'
         JOIN issues b ON b.id = d.depends_on_id WHERE b.status != 'closed'
       UNION
       SELECT d.issue_id FROM dependencies d JOIN issues c ON c.id = d.issue_id
         WHERE d.depends_on_id = ? AND d.type = 'parent-child' AND c.status != 'closed'`,
      issue,
      issue,
    ).map((one) => one.id);
  }

  /** Open, not put off, and with nothing in its way: highest priority first, then oldest. */
  ready(options: { limit?: number; parent?: string; unassigned?: boolean } = {}): Issue[] {
    const under = options.parent ? `${this.get(options.parent).id}.` : null;
    return this.rows(
      `${HELD}
       SELECT i.* FROM issues i
       WHERE i.status = 'open' AND (i.defer_until IS NULL OR i.defer_until <= ?)
         AND i.id NOT IN (SELECT id FROM held) AND i.id NOT IN (SELECT id FROM parents)
         AND (? = 0 OR i.assignee IS NULL) AND (? IS NULL OR (i.id >= ? AND i.id < ?))
       ORDER BY i.priority, i.created_at, i.id LIMIT ?`,
      this.stamp(),
      options.unassigned ? 1 : 0,
      under,
      under,
      under === null ? null : `${under}\u{10ffff}`,
      options.limit ?? -1,
    ).map(toIssue);
  }

  list(filter: { status?: Status; assignee?: string; type?: IssueType; limit?: number; offset?: number } = {}): {
    issues: Issue[];
    total: number;
  } {
    const where = "(? IS NULL OR status = ?) AND (? IS NULL OR assignee = ?) AND (? IS NULL OR issue_type = ?)";
    const [status, assignee, type] = [filter.status ?? null, filter.assignee ?? null, filter.type ?? null];
    const params = [status, status, assignee, assignee, type, type];
    return this.transaction("read", () => ({
      issues: this.rows(
        `SELECT * FROM issues WHERE ${where} ORDER BY ${ORDERED} LIMIT ? OFFSET ?`,
        ...params,
        filter.limit ?? -1,
        filter.offset ?? 0,
      ).map(toIssue),
      total: this.row<{ n: number }>(`SELECT COUNT(*) AS n FROM issues WHERE ${where}`, ...params)!.n,
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
      const blockers = this.blockers(issue.id);
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
  ): Issue {
    return this.write(() => {
      const issue = this.get(id);
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
      const blockers = this.blockers(issue.id);
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
        this.touch(issue, { assignee: successor, status: successor ? issue.status : "open" });
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

  /** How SQLite will run one of this store's lookups, for the test that each has its index. */
  explain(
    lookup: "ready" | "cycle" | "byAssignee" | "byStatus" | "blockers" | "prefix" | "comments" | "events",
  ): string[] {
    const sql = {
      ready: `${HELD} SELECT i.* FROM issues i WHERE i.status = 'open' AND i.id NOT IN (SELECT id FROM held) AND i.id NOT IN (SELECT id FROM parents) ORDER BY i.priority, i.created_at, i.id`,
      cycle: `WITH RECURSIVE waits (id) AS (SELECT 'x' UNION SELECT d.depends_on_id FROM waits CROSS JOIN dependencies d ON d.issue_id = waits.id AND d.type IN (${quoted(ORDERING)})) SELECT 1 FROM waits WHERE id = 'y'`,
      byAssignee: "SELECT * FROM issues WHERE assignee = 'x' AND status != 'closed'",
      byStatus: `SELECT * FROM issues WHERE status = 'in_progress' ORDER BY ${ORDERED}`,
      blockers:
        "SELECT d.issue_id FROM dependencies d JOIN issues c ON c.id = d.issue_id WHERE d.depends_on_id = 'x' AND d.type = 'parent-child' AND c.status != 'closed'",
      prefix: "SELECT * FROM issues WHERE id >= 'sw-a' AND id < 'sw-b'",
      comments: "SELECT author FROM comments WHERE issue_id = 'x' ORDER BY id",
      events: "SELECT actor FROM events WHERE issue_id = 'x' ORDER BY id DESC LIMIT 20",
    }[lookup];
    return this.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((step) => String((step as { detail: string }).detail));
  }
}
