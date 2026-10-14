import { literal, type Word } from "../shell";
import type { Scene } from "../types";

/** git read as git reads its line: global options, subcommand, aliases, then DCG's git rules. */

export interface GitHit {
  pack: "core.git" | "strict_git";
  rule: string;
  detail: string;
}

export interface GitTools {
  /** an alias from the user's or the repository's git config, null when none */
  alias(name: string, cwd: string | null): Promise<string | null>;
  /** a `git-<name>` program on PATH: an external subcommand, not an alias */
  external(name: string): Promise<boolean>;
  rebasing(cwd: string | null): Promise<boolean>;
}

export interface GitOutcome {
  hits: GitHit[];
  /** an alias that runs a shell line: the gate judges that line too */
  shell: string | null;
}

const BUILTIN = new Set(
  `add am annotate apply archimport archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph
commit-tree config count-objects credential credential-cache credential-store cvsexportcommit cvsimport cvsserver daemon
describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack
filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc
get-tar-commit-id grep gui hash-object help hook http-backend imap-send index-pack init init-db instaweb
interpret-trailers last-modified lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base
merge-file merge-index merge-one-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4
pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push quiltimport range-diff read-tree rebase
receive-pack reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm
scalar send-email send-pack sh-i18n sh-setup shortlog show show-branch show-index show-ref sparse-checkout stage stash
status stripspace submodule survey svn switch symbolic-ref tag unpack-file unpack-objects update-index update-ref
update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree
write-tree`.split(/\s+/),
);

const GLOBAL_FLAGS = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
]);
const GLOBAL_VALUED = [
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--shallow-file",
  "--attr-source",
  "-c",
  "--config-env",
];
const GLOBAL_EXITS = new Set(["-v", "--version", "-h", "--help", "--html-path", "--man-path", "--info-path", "help"]);
const RECOVERY = new Set([
  "checkout-discard",
  "checkout-ref-discard",
  "checkout-discard-cwd",
  "restore-worktree",
  "restore-worktree-explicit",
]);
const MAX_ALIAS = 64;
const PROTECTED_BRANCHES = (["master", "main"] as const).map((b) => [b, new RegExp(`(^|[:/+])${b}$`)] as const);

interface Line {
  sub: string;
  args: Word[];
  texts: (string | null)[];
  cwd: string | null;
}

/** The git rules for a command that runs git (or `git-<sub>`). */
export async function gitRules(scene: Scene, tools: GitTools, strict: boolean): Promise<GitOutcome> {
  const name = scene.call.name ?? "";
  let words = scene.call.args;
  if (name !== "git") {
    const sub = name.slice(4);
    if (!name.startsWith("git-") || !BUILTIN.has(sub)) return { hits: [], shell: null };
    words = [{ raw: sub, start: 0, end: 0, parts: [{ kind: "text", text: sub, quote: "none" }] }, ...words];
  }
  const aliases = new Map<string, string>();
  let cwd = scene.cwd;
  const seen = new Set<string>();
  for (let depth = 0; depth <= MAX_ALIAS; depth += 1) {
    const read = readGlobals(words, aliases, cwd);
    if (read === "exit") return { hits: [], shell: null };
    if (read === "dynamic") return unverified("a word only known at run time stands where git reads its subcommand");
    cwd = read.cwd;
    words = read.rest;
    const sub = literal(words[0])!;
    if (BUILTIN.has(sub)) {
      const line: Line = { sub, args: words.slice(1), texts: words.slice(1).map(literal), cwd };
      return { hits: await rules(line, scene, tools, strict), shell: null };
    }
    const key = sub.toLowerCase();
    const body = aliases.get(key) ?? (await tools.alias(key, cwd));
    if (body === null) {
      if (!/^[A-Za-z0-9._+-]+$/.test(sub)) return { hits: [], shell: null };
      if (await tools.external(sub)) return { hits: [], shell: null };
      return unverified(`git ${sub} is neither a git command nor an alias the room can read`);
    }
    if (seen.has(key)) return unverified(`the alias ${sub} calls itself`);
    seen.add(key);
    if (body.startsWith("!")) {
      const rest = words
        .slice(1)
        .map((w) => w.raw)
        .join(" ");
      return { hits: [], shell: rest ? `${body.slice(1)} ${rest}` : body.slice(1) };
    }
    words = [...splitAlias(body), ...words.slice(1)];
  }
  return unverified("the alias goes deeper than the room reads");
}

function unverified(detail: string): GitOutcome {
  return { hits: [{ pack: "core.git", rule: "git-alias-semantic-unverified", detail }], shell: null };
}

/** Steps over git's global options; notes `-c alias.x=...` and `-C dir`. */
function readGlobals(
  words: Word[],
  aliases: Map<string, string>,
  cwd: string | null,
): { rest: Word[]; cwd: string | null } | "exit" | "dynamic" {
  let i = 0;
  while (i < words.length) {
    const text = literal(words[i]);
    if (text === null) return "dynamic";
    if (GLOBAL_EXITS.has(text) || text.startsWith("--list-cmds") || text === "--exec-path") return "exit";
    if (GLOBAL_FLAGS.has(text) || text.startsWith("--exec-path=")) {
      i += 1;
      continue;
    }
    const valued = GLOBAL_VALUED.find(
      (f) => text === f || text.startsWith(`${f}=`) || (f.length === 2 && text.startsWith(f) && text.length > 2),
    );
    if (valued) {
      const glued =
        text.length > valued.length ? text.slice(valued.length + (text[valued.length] === "=" ? 1 : 0)) : null;
      const value = glued ?? (words[i + 1] ? literal(words[i + 1]) : null);
      if (glued === null && !words[i + 1]) return "exit";
      if (valued === "-c" && value) {
        const match = /^alias\.([^=]+)=(.*)$/is.exec(value);
        if (match) aliases.set(match[1].toLowerCase(), match[2]);
      }
      if (valued === "-C" && value) cwd = value.startsWith("/") ? value : cwd ? `${cwd}/${value}` : null;
      else if (valued === "-C") cwd = null;
      i += glued === null ? 2 : 1;
      continue;
    }
    if (text === "--") return "exit";
    if (text.startsWith("-")) return "exit";
    return { rest: words.slice(i), cwd };
  }
  return "exit";
}

/** An alias value split into words by git's own quoting. */
function splitAlias(body: string): Word[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let any = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < body.length) current += body[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      any = true;
    } else if (c === "\\" && i + 1 < body.length) current += body[++i];
    else if (/\s/.test(c)) {
      if (current || any) out.push(current);
      current = "";
      any = false;
    } else current += c;
  }
  if (current || any) out.push(current);
  return out.map((text) => ({ raw: text, start: 0, end: 0, parts: [{ kind: "text", text, quote: "single" }] }));
}

const isCluster = (t: string | null): t is string => t !== null && /^-[^-]/.test(t);
const abbrev = (t: string | null, full: string, min: number): boolean =>
  t !== null && t.startsWith("--") && t.length - 2 >= min && full.startsWith(t.slice(2)) && !t.includes("=");
const beforeEnd = (texts: (string | null)[]): (string | null)[] => {
  const end = texts.indexOf("--");
  return end < 0 ? texts : texts.slice(0, end);
};

async function rules(line: Line, scene: Scene, tools: GitTools, strict: boolean): Promise<GitHit[]> {
  const hits: GitHit[] = [];
  const core = (rule: string, detail = `git ${line.sub}`) => hits.push({ pack: "core.git", rule, detail });
  const tight = (rule: string, detail = `git ${line.sub}`) => strict && hits.push({ pack: "strict_git", rule, detail });
  const t = line.texts;
  const opts = beforeEnd(t);
  switch (line.sub) {
    case "checkout": {
      if (t[0] === "-b" || t[0] === "--orphan") break;
      if (
        opts.some(
          (x) => ["--f", "--fo", "--for", "--forc", "--force"].includes(x ?? "") || (isCluster(x) && x.includes("f")),
        )
      )
        core("checkout-force");
      if (t[0] === "--" && t.length > 1) core("checkout-discard");
      else if (t[1] === "--" && t.length > 2 && t[0] !== null) core("checkout-ref-discard");
      if (t.slice(0, 2).some((x) => x === "." || (x !== null && x.startsWith("./")))) core("checkout-discard-cwd");
      break;
    }
    case "switch":
      if (t[0] === "-c") break;
      if (opts.some((x) => x === "--force" || abbrev(x, "discard-changes", 2) || (isCluster(x) && x.includes("f"))))
        core("switch-discard");
      break;
    case "rm":
      if (t.some((x) => x === "--cached" || x === "--dry-run" || (isCluster(x) && x.includes("n")))) break;
      if (opts.some((x) => abbrev(x, "force", 1) || (isCluster(x) && x.includes("f")))) core("rm-force");
      break;
    case "update-ref":
      if (t.some((x) => x === "-d" || x === "--delete")) core("update-ref-delete");
      break;
    case "read-tree":
      if (t.some((x) => abbrev(x, "reset", 3)) && t.some((x) => isCluster(x) && x.includes("u")))
        core("read-tree-reset");
      break;
    case "show": {
      const source = t[0] && /^[^:]*:(.+)$/.exec(t[0]);
      if (!source) break;
      const path = source[1].replace(/^\.\//, "");
      for (const r of scene.simple.redirects) {
        if (r.op !== ">" && r.op !== ">>" && r.op !== ">|") continue;
        const target = r.target ? literal(r.target) : null;
        if (target && target.replace(/^\.\//, "") === path)
          core("show-redirect-overwrite-source", `git show ${t[0]} > ${target}`);
      }
      break;
    }
    case "restore":
      if (t.some((x) => x === "--worktree" || x === "-W")) core("restore-worktree-explicit");
      else if (!t.some((x) => x === "--staged" || x === "-S")) core("restore-worktree");
      break;
    case "reset":
      if (t.some((x) => abbrev(x, "hard", 1))) core("reset-hard");
      if (t.some((x) => abbrev(x, "merge", 2))) core("reset-merge");
      break;
    case "clean":
      if (opts.some((x) => x === "--dry-run" || (isCluster(x) && /^-[a-z]*n/.test(x)))) break;
      if (opts.some((x) => abbrev(x, "force", 1) || (isCluster(x) && x.includes("f")))) core("clean-force");
      break;
    case "push":
      pushRules(line, core, tight);
      break;
    case "branch": {
      const verdict = branchVerdict(line.args);
      if (verdict) core(verdict);
      break;
    }
    case "stash":
      if (t[0] === "drop") core("stash-drop");
      if (t[0] === "clear") core("stash-clear");
      break;
    case "filter-branch":
      core("filter-branch");
      tight("filter-branch");
      break;
    case "reflog":
      if (t[0] === "expire") {
        tight("reflog-expire");
        for (let i = 1; i < t.length; i += 1) {
          const x = t[i] ?? "";
          const m = /^--(expire(?:-u[a-z-]*)?)(?:=(.*))?$/.exec(x);
          if (!m || (m[1] !== "expire" && !"expire-unreachable".startsWith(m[1]))) continue;
          const value = m[2] ?? t[i + 1] ?? "";
          if (["now", "all", "0"].includes(value)) core("reflog-expire-now");
        }
      }
      break;
    case "lfs":
      if (t[0] === "migrate" && (t[1] === "import" || t[1] === "export")) core("lfs-migrate-rewrite");
      if (t[0] === "prune" && !t.includes("--dry-run")) core("lfs-prune");
      if (t[0] === "uninstall") core("lfs-uninstall");
      break;
    case "rebase":
      tight("rebase");
      break;
    case "commit":
      if (opts.some((x) => abbrev(x, "amend", 2))) tight("commit-amend");
      break;
    case "cherry-pick":
      tight("cherry-pick");
      break;
    case "filter-repo":
      tight("filter-repo");
      break;
    case "gc":
      if (opts.some((x) => abbrev(x, "aggressive", 2) || (x !== null && /^--prune(=|$)/.test(x))))
        tight("gc-aggressive");
      break;
    case "worktree":
      if (t[0] === "remove") tight("worktree-remove");
      break;
    case "submodule":
      if (t.includes("deinit")) tight("submodule-deinit");
      break;
    case "add":
      if (t.some((x) => x === ".")) tight("add-all-dot");
      if (opts.some((x) => x === "--all" || (isCluster(x) && x.includes("A")))) tight("add-all-flag");
      break;
  }
  if (hits.some((h) => RECOVERY.has(h.rule)) && (await tools.rebasing(line.cwd)))
    return hits.filter((h) => !RECOVERY.has(h.rule));
  return hits;
}

function pushRules(
  line: Line,
  core: (rule: string, detail?: string) => void,
  tight: (rule: string, detail?: string) => unknown,
): void {
  const t = line.texts;
  const opts = beforeEnd(t);
  const forceLong = opts.some((x) => x === "--force" || (x !== null && x.startsWith("--force=")));
  const forceShort = opts.some((x) => isCluster(x) && /[fF]/.test(x));
  const refspec = t.some((x) => x !== null && x.startsWith("+"));
  if (forceLong) core("push-force-long");
  if (forceShort) core("push-force-short");
  if (refspec) core("push-force-refspec");
  if (forceLong || forceShort || refspec || opts.some((x) => x !== null && /^--force-(with-lease|if-includes)/.test(x)))
    tight("push-force-any");
  if (opts.includes("--mirror")) tight("push-mirror");
  if (opts.some((x) => abbrev(x, "delete", 2) || (isCluster(x) && x.includes("d")))) tight("push-delete");
  if (t.some((x) => x !== null && /^:.+/.test(x))) tight("push-delete-refspec");
  if (opts.some((x) => abbrev(x, "prune", 3))) tight("push-prune");
  if (
    line.args.some(
      (w) =>
        literal(w) === null || w.parts.some((p) => p.kind === "text" && p.quote === "none" && /[*?[{}\\]/.test(p.text)),
    )
  )
    tight("push-dynamic-argument");
  const names = t.filter((x): x is string => x !== null && !x.startsWith("-"));
  for (const [branch, test] of PROTECTED_BRANCHES)
    if (names.slice(1).some((x) => test.test(x))) tight(`push-${branch}`);
}

const BRANCH_LONG: Record<string, "flag" | "glued" | "value" | "lastDefault"> = {
  abbrev: "glued",
  all: "flag",
  color: "glued",
  column: "glued",
  contains: "lastDefault",
  copy: "flag",
  "create-reflog": "flag",
  delete: "flag",
  "edit-description": "flag",
  force: "flag",
  format: "value",
  "ignore-case": "flag",
  list: "flag",
  merged: "lastDefault",
  move: "flag",
  "no-contains": "lastDefault",
  "no-merged": "lastDefault",
  "no-track": "flag",
  "omit-empty": "flag",
  "points-at": "value",
  quiet: "flag",
  "recurse-submodules": "flag",
  remotes: "flag",
  "set-upstream-to": "value",
  "show-current": "flag",
  sort: "value",
  track: "glued",
  "unset-upstream": "flag",
  verbose: "flag",
  with: "lastDefault",
  without: "lastDefault",
};
const NEGATABLE = new Set([
  "delete",
  "force",
  "abbrev",
  "color",
  "column",
  "track",
  "create-reflog",
  "recurse-submodules",
  "contains",
  "merged",
  "with",
  "without",
  "omit-empty",
]);

/** `git branch` read flag by flag: a delete git checks for merging, a forced one, or neither. */
function branchVerdict(args: Word[]): "branch-delete" | "branch-force-delete" | "branch-dynamic-token" | null {
  let del = false;
  let forceDel = false;
  let force = false;
  let moveCopy = false;
  let forceMove = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    const text = literal(word);
    if (text === null) {
      const unquoted = word.parts.some((p) => p.kind !== "text" && p.kind !== "tilde" && !("quoted" in p && p.quoted));
      const asFlag = /^-/.test(word.parts[0]?.kind === "text" ? word.parts[0].text : "");
      if (unquoted || asFlag) return "branch-dynamic-token";
      continue;
    }
    if (text === "--" || text === "--end-of-options") break;
    if (text.startsWith("--")) {
      const [raw, value] = text.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      let name = raw;
      let negated = false;
      if (name.startsWith("no-") && !(name in BRANCH_LONG)) {
        negated = true;
        name = name.slice(3);
      }
      const options = Object.keys(BRANCH_LONG).filter((o) => o.startsWith(name));
      const full = name in BRANCH_LONG ? name : options.length === 1 ? options[0] : null;
      if (!full || (negated && !NEGATABLE.has(full))) return null;
      if (full === "help" || full === "help-all") return null;
      const kind = BRANCH_LONG[full];
      if (kind === "flag" && value !== undefined) return null;
      if (full === "delete") del = !negated;
      else if (full === "force") force = !negated;
      else if (full === "move" || full === "copy") moveCopy = !negated;
      if (kind === "value" && value === undefined) i += 1;
      else if (
        kind === "lastDefault" &&
        value === undefined &&
        args[i + 1] &&
        !(literal(args[i + 1]) ?? "-").startsWith("-")
      )
        i += 1;
      continue;
    }
    if (text.startsWith("-") && text.length > 1) {
      for (let j = 1; j < text.length; j += 1) {
        const c = text[j];
        if (c === "d") del = true;
        else if (c === "D") forceDel = true;
        else if (c === "f") force = true;
        else if (c === "M" || c === "C") forceMove = true;
        else if (c === "m" || c === "c") moveCopy = true;
        else if ("vqrali".includes(c)) continue;
        else if (c === "h") return null;
        else if (c === "u") {
          if (j === text.length - 1) i += 1;
          break;
        } else if (c === "t") break;
        else return null;
      }
    }
  }
  if (forceDel || forceMove || (moveCopy && force) || (del && force) || (force && !del)) return "branch-force-delete";
  if (del) return "branch-delete";
  return null;
}
