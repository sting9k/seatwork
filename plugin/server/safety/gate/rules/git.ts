import { literal, textWord, type Word } from "../shell";
import type { Scene } from "../types";

/** git read as git reads its line: global options, subcommand, aliases, then DCG's git rules. */

interface GitHit {
  pack: "core.git" | "strict_git" | "room.guard";
  rule: string;
  detail: string;
}

/** What the git rules ask of the machine: an alias in git config, a `git-<name>` program, a rebase under way. */
export interface GitTools {
  alias(name: string, cwd: string | null): Promise<string | null>;
  external(name: string): Promise<boolean>;
  rebasing(cwd: string | null): Promise<boolean>;
}

/** The rules a git command trips; `shells` are the lines it runs through the shell (an alias, a program a `-c` option names), which are judged too. */
interface GitOutcome {
  hits: GitHit[];
  shells: string[];
}

const BUILTIN = new Set(
  `add am annotate apply archimport archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore
check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph
commit-tree config count-objects credential credential-cache credential-store cvsexportcommit cvsimport cvsserver daemon
describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export fast-import fetch fetch-pack
filter-branch filter-repo fmt-merge-msg for-each-ref for-each-repo format-patch fsck fsck-objects fsmonitor--daemon gc
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
const EXEC_KEYS =
  /^(core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|attributesfile)|filter\..+|diff\.(external|.+\.(command|textconv|cachetextconv))|merge\..+\.(driver|recursivedriver)|(difftool|mergetool)\..+\.(cmd|path)|credential\.(.+\.)?helper|gpg\.(.+\.)?program|sequence\.editor|pager\..+|include\.path|includeif\..+\.path)$/;
const PATH_KEYS = /^(core\.(hookspath|attributesfile)|include\.path|includeif\..+\.path)$/;
const CONFIG_VALUED = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment"]);
const CONFIG_READS = new Set(["get", "list", "unset", "edit", "remove-section", "rename-section"]);
const MAX_ALIAS = 64;
const PROTECTED_BRANCHES = (["master", "main"] as const).map((b) => [b, new RegExp(`(^|[:/+])${b}$`)] as const);

/** A git command after its global options: the subcommand, and what follows it. */
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
    if (!name.startsWith("git-") || !BUILTIN.has(sub)) return NOTHING;
    words = [textWord(sub), ...words];
  }
  const aliases = new Map<string, string>();
  const given: GitOutcome = { hits: [], shells: [] };
  let cwd = scene.cwd;
  const seen = new Set<string>();
  for (let depth = 0; depth <= MAX_ALIAS; depth += 1) {
    const read = readGlobals(words, aliases, cwd, given);
    if (read === "exit") return given;
    if (read === "dynamic")
      return unverified(given, "a word only known at run time stands where git reads its subcommand");
    cwd = read.cwd;
    words = read.rest;
    const sub = literal(words[0])!;
    if (BUILTIN.has(sub)) {
      const line: Line = { sub, args: words.slice(1), texts: words.slice(1).map(literal), cwd };
      given.hits.push(...(await rules(line, scene, tools, strict)));
      return given;
    }
    const key = sub.toLowerCase();
    const body = aliases.get(key) ?? (await tools.alias(key, cwd));
    if (body === null) {
      if (!/^[A-Za-z0-9._+-]+$/.test(sub)) return given;
      if (await tools.external(sub)) return given;
      return unverified(given, `git ${sub} is neither a git command nor an alias the room can read`);
    }
    if (seen.has(key)) return unverified(given, `the alias ${sub} calls itself`);
    seen.add(key);
    if (body.startsWith("!")) {
      const rest = words
        .slice(1)
        .map((w) => w.raw)
        .join(" ");
      given.shells.push(rest ? `${body.slice(1)} ${rest}` : body.slice(1));
      return given;
    }
    words = [...splitAlias(body), ...words.slice(1)];
  }
  return unverified(given, "the alias goes deeper than the room reads");
}

const NOTHING: GitOutcome = { hits: [], shells: [] };

/** The outcome for a subcommand the room cannot read. */
function unverified(given: GitOutcome, detail: string): GitOutcome {
  given.hits.push({ pack: "core.git", rule: "git-alias-semantic-unverified", detail });
  return given;
}

/** Steps over git's global options; notes `-c alias.x=...`, the programs other `-c` options name, and `-C dir`. */
function readGlobals(
  words: Word[],
  aliases: Map<string, string>,
  cwd: string | null,
  given: GitOutcome,
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
      if (valued === "-c") {
        if (value !== null) {
          const match = /^alias\.([^=]+)=(.*)$/is.exec(value);
          if (match) aliases.set(match[1].toLowerCase(), match[2]);
          else programOf(value, given);
        } else if (glued === null && words[i + 1]) programOf(words[i + 1].raw, given, true);
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

export const PROGRAM_VARIABLES = [
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_PROXY_COMMAND",
];

/** Whether a git config key names a program git runs. */
export function givesProgram(key: string): boolean {
  const lower = key.toLowerCase();
  return EXEC_KEYS.test(lower) && !PATH_KEYS.test(lower);
}

/** Notes the program a `key=value` setting gives git, when its key is one that runs a program; a value known only at run time is a finding. */
function programOf(setting: string, given: GitOutcome, dynamic = false): void {
  const at = setting.indexOf("=");
  if (at < 0) return;
  const key = setting.slice(0, at);
  if (!givesProgram(key)) return;
  if (dynamic) given.hits.push({ pack: "room.guard", rule: "git-config-exec", detail: key.slice(0, 80) });
  else given.shells.push(setting.slice(at + 1).replace(/^!/, ""));
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
  return out.map((text) => textWord(text, "single"));
}

/** True for a cluster of short options such as `-fd`. */
const isCluster = (t: string | null): t is string => t !== null && /^-[^-]/.test(t);
/** True when `t` is a long option cut short of `full` by at least `min` letters. */
const abbrev = (t: string | null, full: string, min: number): boolean =>
  t !== null && t.startsWith("--") && t.length - 2 >= min && full.startsWith(t.slice(2)) && !t.includes("=");
/** The words before a bare `--`. */
const beforeEnd = (texts: (string | null)[]): (string | null)[] => {
  const end = texts.indexOf("--");
  return end < 0 ? texts : texts.slice(0, end);
};

const HOOKED = new Set(["am", "commit", "merge", "push", "rebase"]);
const COMMIT_VALUE_LETTERS = "mFcCt";

/** Whether a git line skips the repository's hooks: `--no-verify`, or `-n` for a commit; a later `--verify` undoes it. */
function skipsHooks(sub: string, texts: (string | null)[]): boolean {
  const opts = beforeEnd(texts);
  let skips = false;
  for (let i = 0; i < opts.length; i += 1) {
    const x = opts[i];
    if (abbrev(x, "no-verify", 7)) skips = true;
    else if (x === "--verify") skips = false;
    else if (sub === "commit" && isCluster(x))
      for (const [at, letter] of [...x.slice(1)].entries()) {
        if (letter === "n") skips = true;
        if (!COMMIT_VALUE_LETTERS.includes(letter) && letter !== "S" && letter !== "u") continue;
        // an option that takes a value ends the cluster; with nothing after it, the next word is the value
        if (COMMIT_VALUE_LETTERS.includes(letter) && at === x.length - 2) i += 1;
        break;
      }
  }
  return skips;
}

/** The rules for one subcommand and its arguments; during a rebase the discard rules stand down. */
async function rules(line: Line, scene: Scene, tools: GitTools, strict: boolean): Promise<GitHit[]> {
  const hits: GitHit[] = [];
  const core = (rule: string, detail = `git ${line.sub}`) => hits.push({ pack: "core.git", rule, detail });
  const tight = (rule: string, detail = `git ${line.sub}`) => strict && hits.push({ pack: "strict_git", rule, detail });
  const room = (rule: string, detail: string) => hits.push({ pack: "room.guard", rule, detail });
  const t = line.texts;
  const opts = beforeEnd(t);
  switch (line.sub) {
    case "config": {
      const key = programKey(t);
      if (key !== null) room("git-config-exec", key);
      break;
    }
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
  if (HOOKED.has(line.sub) && skipsHooks(line.sub, t)) room("git-no-verify", `git ${line.sub} --no-verify`);
  if (hits.some((h) => RECOVERY.has(h.rule)) && (await tools.rebasing(line.cwd)))
    return hits.filter((h) => !RECOVERY.has(h.rule));
  return hits;
}

/** The key a `git config` line sets when it names a program git runs later (`filter.x.clean`, `core.hooksPath`); null for a read, an unset, or any other key. */
function programKey(texts: (string | null)[]): string | null {
  const words: (string | null)[] = [];
  let reads = false;
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i];
    if (text === "--") continue;
    if (text !== null && text.startsWith("-")) {
      reads ||= text === "-l" || text === "-e" || /^--(get|list|show|name|unset|remove|rename|edit)/.test(text);
      if (CONFIG_VALUED.has(text)) i += 1;
      continue;
    }
    words.push(text);
  }
  if (reads || CONFIG_READS.has(words[0] ?? "")) return null;
  // `git config set key value` is the newer spelling of `git config key value`
  const named = words[0] === "set" ? words.slice(1) : words;
  if (named.length < 2) return null;
  const key = named[0];
  if (key === null) return "a key known only at run time";
  return EXEC_KEYS.test(key.toLowerCase()) ? key.slice(0, 80) : null;
}

/** The rules for `git push`: force in its forms, mirror, delete, prune, and the protected branches. */
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
