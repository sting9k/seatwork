import type { SimpleCommand } from "./shell";

/** What one simple command does, read from its program and flags; one with no effect is unknown. */

export type CheckKind = "test" | "build" | "lint" | "types";

export type Effect =
  | { kind: "check"; what: CheckKind | "named"; label: string }
  | { kind: "write"; paths: string[]; tree?: true }
  | { kind: "destroy"; what: string; paths?: string[]; bounded?: boolean }
  | { kind: "external"; what: string }
  | { kind: "install"; what: string }
  | { kind: "wait"; seconds: number }
  | { kind: "look" };

export interface EffectContext {
  namedChecks: readonly string[];
}

/* ---------- helpers over argv ---------- */

const flags = (argv: readonly string[]) => argv.slice(1).filter((a) => a.startsWith("-"));
const operands = (argv: readonly string[]) => argv.slice(1).filter((a) => !a.startsWith("-"));
/** Short flags may be clustered: `-rf` has both `r` and `f`. */
const hasShort = (argv: readonly string[], letter: string) =>
  flags(argv).some((f) => !f.startsWith("--") && f.includes(letter));
const hasLong = (argv: readonly string[], ...names: string[]) =>
  flags(argv).some((f) => names.includes(f.split("=")[0]));

const SCRIPT_KIND: readonly [RegExp, CheckKind][] = [
  [/(?:^|[:_-])(?:type-?check|types|tsc)(?:$|[:_-])/, "types"],
  [/(?:^|[:_-])(?:lint|format:check|fmt:check|style)(?:$|[:_-])/, "lint"],
  [/(?:^|[:_-])(?:test|tests|spec|e2e|verify|check|ci|validate|smoke)(?:$|[:_-])/, "test"],
  [/(?:^|[:_-])(?:build|compile)(?:$|[:_-])/, "build"],
];

function scriptKind(name: string): CheckKind | null {
  const lower = name.toLowerCase();
  return SCRIPT_KIND.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
}

/** Package-manager verbs that are not scripts. */
const PM_VERBS = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "upgrade",
  "up",
  "link",
  "unlink",
  "init",
  "create",
  "dlx",
  "exec",
  "x",
  "run",
  "why",
  "list",
  "ls",
  "outdated",
  "audit",
  "publish",
  "pack",
  "config",
  "cache",
  "store",
  "import",
  "dedupe",
  "prune",
  "rebuild",
  "version",
  "login",
  "logout",
  "whoami",
  "info",
  "view",
  "pm",
]);
const PM_WRITES = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "upgrade",
  "up",
  "dedupe",
  "prune",
  "rebuild",
  "link",
  "unlink",
  "import",
]);

/** Runners that only start another program. */
function unwrapRunner(argv: readonly string[]): readonly string[] {
  const [program, first, second] = argv;
  if (["npx", "pnpx", "bunx", "uvx", "pipx"].includes(program)) return operandsFrom(argv, 1);
  if (["pnpm", "yarn", "npm", "bun"].includes(program) && ["exec", "dlx", "x"].includes(first))
    return operandsFrom(argv, 2);
  if (["uv", "poetry", "pdm", "hatch", "pipenv", "rye"].includes(program) && first === "run")
    return operandsFrom(argv, 2);
  if (program === "bundle" && first === "exec") return argv.slice(2);
  if (/^python[0-9.]*$/.test(program) && first === "-m" && second) return argv.slice(2);
  if (program === "dotenv" || program === "cross-env") return operandsFrom(argv, 1);
  return argv;
}

function operandsFrom(argv: readonly string[], start: number): readonly string[] {
  let i = start;
  while (i < argv.length && (argv[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]))) i += 1;
  return argv.slice(i);
}

/* ---------- checks ---------- */

/** Program → the check it is; null when this invocation is not a check. */
const CHECK_PROGRAMS: Record<string, (argv: readonly string[]) => CheckKind | null> = {
  vitest: (a) => (a.includes("--watch") || a[1] === "watch" || a[1] === "dev" ? null : "test"),
  jest: (a) => (hasLong(a, "--watch", "--watchAll") ? null : "test"),
  mocha: () => "test",
  ava: () => "test",
  tap: () => "test",
  jasmine: () => "test",
  playwright: (a) => (a[1] === "test" ? "test" : null),
  cypress: (a) => (a[1] === "run" ? "test" : null),
  pytest: () => "test",
  "py.test": () => "test",
  unittest: () => "test",
  tox: () => "test",
  nox: () => "test",
  rspec: () => "test",
  phpunit: () => "test",
  pest: () => "test",
  ctest: () => "test",
  go: (a) => (a[1] === "test" ? "test" : a[1] === "vet" ? "lint" : a[1] === "build" ? "build" : null),
  cargo: (a) => {
    const verb = operands(a)[0];
    if (verb === "test" || verb === "nextest") return "test";
    if (verb === "clippy") return "lint";
    if (verb === "fmt") return hasLong(a, "--check") ? "lint" : null;
    return verb === "check" || verb === "build" ? "build" : null;
  },
  deno: (a) => (a[1] === "test" ? "test" : a[1] === "lint" ? "lint" : a[1] === "check" ? "types" : null),
  dotnet: (a) => (a[1] === "test" ? "test" : a[1] === "build" ? "build" : null),
  swift: (a) => (a[1] === "test" ? "test" : a[1] === "build" ? "build" : null),
  mix: (a) => (a[1] === "test" ? "test" : a[1] === "compile" ? "build" : null),
  rake: (a) => scriptKind(operands(a)[0] ?? ""),
  gradle: (a) => gradleKind(a),
  gradlew: (a) => gradleKind(a),
  mvn: (a) => mavenKind(a),
  mvnw: (a) => mavenKind(a),
  bazel: (a) => (a[1] === "test" ? "test" : a[1] === "build" ? "build" : null),
  make: (a) => (operands(a).length === 0 ? "build" : firstKind(operands(a))),
  just: (a) => firstKind(operands(a)),
  task: (a) => firstKind(operands(a)),
  tsc: (a) => (hasLong(a, "--watch") || hasShort(a, "w") ? null : "types"),
  "vue-tsc": () => "types",
  mypy: () => "types",
  pyright: () => "types",
  eslint: () => "lint",
  biome: (a) =>
    ["check", "lint", "ci"].includes(a[1]) ? "lint" : a[1] === "format" && !hasLong(a, "--write") ? "lint" : null,
  prettier: (a) => (hasLong(a, "--check", "--list-different") || hasShort(a, "c") || hasShort(a, "l") ? "lint" : null),
  ruff: (a) => (a[1] === "check" ? "lint" : a[1] === "format" && hasLong(a, "--check", "--diff") ? "lint" : null),
  flake8: () => "lint",
  pylint: () => "lint",
  black: (a) => (hasLong(a, "--check", "--diff") ? "lint" : null),
  isort: (a) => (hasLong(a, "--check", "--check-only", "--diff") || hasShort(a, "c") ? "lint" : null),
  "golangci-lint": () => "lint",
  staticcheck: () => "lint",
  rubocop: (a) =>
    hasShort(a, "a") || hasShort(a, "A") || hasLong(a, "--autocorrect", "--auto-correct") ? null : "lint",
  shellcheck: () => "lint",
  stylelint: () => "lint",
  hadolint: () => "lint",
  clippy: () => "lint",
};

/** Programs whose first word after the name says which check runs. */
const VERBED = new Set([
  "go",
  "cargo",
  "deno",
  "dotnet",
  "swift",
  "mix",
  "bazel",
  "make",
  "just",
  "task",
  "rake",
  "biome",
  "ruff",
  "playwright",
  "cypress",
  "gradle",
  "gradlew",
  "mvn",
  "mvnw",
]);

function firstKind(names: readonly string[]): CheckKind | null {
  for (const name of names) {
    const kind = scriptKind(name);
    if (kind) return kind;
  }
  return null;
}

function gradleKind(argv: readonly string[]): CheckKind | null {
  const tasks = operands(argv).map((t) => t.split(":").pop() ?? t);
  return tasks.includes("test") || tasks.includes("check")
    ? "test"
    : tasks.some((t) => /^(build|assemble|compile\w*)$/.test(t))
      ? "build"
      : null;
}

function mavenKind(argv: readonly string[]): CheckKind | null {
  const goals = operands(argv);
  return goals.some((g) => ["test", "verify", "integration-test"].includes(g))
    ? "test"
    : goals.some((g) => ["package", "compile", "install"].includes(g))
      ? "build"
      : null;
}

function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function checkOf(command: SimpleCommand, context: EffectContext): Effect | null {
  const plain = (text: string) => normalizeCommand(text).replace(/^\.\//, "");
  const written = plain(command.argv.join(" "));
  // the brief's proof comes first
  for (const named of context.namedChecks) {
    const wanted = plain(named);
    const isFile = !wanted.includes(" ");
    if (
      isFile
        ? command.argv.some((a) => plain(a) === wanted || a.endsWith(`/${wanted}`))
        : written === wanted || written.startsWith(`${wanted} `)
    ) {
      return { kind: "check", what: "named", label: named };
    }
  }
  const argv = unwrapRunner(command.argv);
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    const rest = operands(argv);
    const script = rest[0] === "run" || rest[0] === "run-script" ? rest[1] : rest[0];
    if (!script) return null;
    if (script === "test" || script === "t") return { kind: "check", what: "test", label: `${program} test` };
    if (rest[0] !== "run" && rest[0] !== "run-script" && (program === "npm" || PM_VERBS.has(script))) return null;
    const kind = scriptKind(script);
    return kind ? { kind: "check", what: kind, label: `${program} run ${script}` } : null;
  }
  if (program === "node" && argv.includes("--test")) return { kind: "check", what: "test", label: "node --test" };
  const known = CHECK_PROGRAMS[program]?.(argv);
  // the label names the check, not this invocation: `go test`, not `go test ./pkg/a -run X`
  const verb = operands(argv)[0] ?? "";
  if (known)
    return {
      kind: "check",
      what: known,
      label: /^[a-z][a-z:-]*$/.test(verb) && VERBED.has(program) ? `${program} ${verb}` : program,
    };
  // a script named for what it does: ./scripts/test.sh, python tools/verify.py
  const script = /^(?:bash|sh|zsh|node|python[0-9.]*|ruby|tsx|ts-node)$/.test(program)
    ? operands(argv)[0]
    : argv[0]?.includes("/")
      ? argv[0]
      : undefined;
  if (script && /\.(?:sh|bash|js|cjs|mjs|ts|py|rb)$|^\.{0,2}\//.test(script)) {
    const stem = (script.split("/").pop() ?? "").replace(/\.\w+$/, "");
    const kind = scriptKind(stem.replace(/^run[-_]?/, ""));
    if (kind) return { kind: "check", what: kind, label: script };
  }
  return null;
}

/* ---------- writes ---------- */

const NOT_A_FILE = /^(?:\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)|&\d+|-)$/;

/** Program → the paths this invocation writes; an empty list when the command line does not say where. */
const WRITE_PROGRAMS: Record<string, (argv: readonly string[]) => string[] | null> = {
  tee: (a) => operands(a),
  touch: (a) => operands(a),
  mkdir: (a) => operands(a),
  rm: (a) => operands(a),
  rmdir: (a) => operands(a),
  unlink: (a) => operands(a),
  mv: (a) => operands(a),
  cp: (a) => operands(a).slice(-1),
  ln: (a) => operands(a).slice(-1),
  install: (a) => operands(a).slice(-1),
  truncate: (a) => operands(a),
  chmod: (a) => operands(a).slice(1),
  chown: (a) => operands(a).slice(1),
  patch: () => [],
  sed: (a) => (flags(a).some((f) => /^-[a-zA-Z]*i/.test(f) || f.startsWith("--in-place")) ? scriptOperands(a) : null),
  gsed: (a) => (flags(a).some((f) => /^-[a-zA-Z]*i/.test(f) || f.startsWith("--in-place")) ? scriptOperands(a) : null),
  perl: (a) => (flags(a).some((f) => /^-[a-zA-Z]*i/.test(f)) ? [] : null),
  prettier: (a) => (hasLong(a, "--write") || hasShort(a, "w") ? [] : null),
  eslint: (a) => (hasLong(a, "--fix") ? [] : null),
  biome: (a) => (hasLong(a, "--write", "--apply", "--fix") ? [] : null),
  ruff: (a) => (hasLong(a, "--fix") || (a[1] === "format" && !hasLong(a, "--check", "--diff")) ? [] : null),
  black: (a) => (hasLong(a, "--check", "--diff") ? null : []),
  isort: (a) => (hasLong(a, "--check", "--check-only", "--diff") || hasShort(a, "c") ? null : []),
  gofmt: (a) => (hasShort(a, "w") ? operands(a) : null),
  rubocop: (a) => (hasShort(a, "a") || hasShort(a, "A") || hasLong(a, "--autocorrect", "--auto-correct") ? [] : null),
  pip: (a) => (["install", "uninstall"].includes(a[1]) ? [] : null),
  pip3: (a) => (["install", "uninstall"].includes(a[1]) ? [] : null),
  go: (a) =>
    a[1] === "fmt" || a[1] === "get" || a[1] === "generate" || (a[1] === "mod" && a[2] !== "verify" && a[2] !== "graph")
      ? []
      : null,
  cargo: (a) =>
    ["add", "remove", "update", "fix"].includes(operands(a)[0]) || (operands(a)[0] === "fmt" && !hasLong(a, "--check"))
      ? []
      : null,
  git: (a) => gitWrites(a),
};

/** sed's operands minus its script (and minus the empty backup suffix macOS wants after -i). */
function scriptOperands(argv: readonly string[]): string[] {
  return operands(argv)
    .filter((word) => word !== "")
    .slice(1);
}

function gitVerb(argv: readonly string[]): { verb: string; rest: readonly string[] } {
  // `git -C dir -c key=value <verb> …`
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-"))
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(argv[i]) ? 2 : 1;
  return { verb: argv[i] ?? "", rest: argv.slice(i + 1) };
}

function gitWrites(argv: readonly string[]): string[] | null {
  const { verb, rest } = gitVerb(argv);
  const changesTree = [
    "apply",
    "am",
    "checkout",
    "switch",
    "restore",
    "reset",
    "merge",
    "rebase",
    "cherry-pick",
    "revert",
    "pull",
    "clean",
    "rm",
    "mv",
  ];
  if (verb === "stash")
    return ["pop", "apply", "push", "save", undefined].includes(rest.find((r) => !r.startsWith("-"))) ? [] : null;
  if (!changesTree.includes(verb)) return null;
  if (verb === "clean" && rest.some((r) => r === "--dry-run" || /^-[a-zA-Z]*n/.test(r))) return null;
  // `git checkout -- <paths>` and `git restore <paths>` say which files
  const dashes = rest.indexOf("--");
  return dashes >= 0
    ? rest.slice(dashes + 1)
    : verb === "rm" || verb === "mv"
      ? rest.filter((r) => !r.startsWith("-"))
      : [];
}

/** Commands after which the whole working tree may differ. */
function rewritesTree(program: string, argv: readonly string[]): boolean {
  if (program === "patch") return true;
  if (program !== "git") return false;
  const { verb, rest } = gitVerb(argv);
  if (verb === "stash") return ["pop", "apply"].includes(rest[0]);
  return (
    ["apply", "am", "checkout", "switch", "reset", "merge", "rebase", "cherry-pick", "revert", "pull"].includes(verb) &&
    !rest.includes("--")
  );
}

function writesOf(command: SimpleCommand): Extract<Effect, { kind: "write" }> | null {
  const paths: string[] = [];
  let writes = false;
  for (const redirect of command.redirects) {
    if (redirect.op !== "<" && !NOT_A_FILE.test(redirect.target)) {
      writes = true;
      paths.push(redirect.target);
    }
  }
  const argv = unwrapRunner(command.argv);
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  if (["npm", "pnpm", "yarn", "bun"].includes(program) && PM_WRITES.has(operands(argv)[0] ?? "")) writes = true;
  const named = WRITE_PROGRAMS[program]?.(argv) ?? null;
  if (named) {
    writes = true;
    // through xargs the paths arrive on stdin, not on the command line
    if (!command.viaXargs) paths.push(...named.filter((path) => !NOT_A_FILE.test(path)));
  }
  if (!writes) return null;
  return rewritesTree(program, argv) ? { kind: "write", paths, tree: true } : { kind: "write", paths };
}

/* ---------- destroy, external, wait, look ---------- */

/** Rebuilt or thrown away by design: deleting them loses nothing. */
const REBUILT =
  /(?:^|\/)(?:node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.gradle|\.tox|tmp|temp|\.tmp)(?:\/[^/]*)*\/?$|^(?:\/private)?\/(?:tmp|var\/folders)\/|^\$\{?\w*(?:tmp|temp|scratch|cache|build|dist|out)\w*\}?(?:\/|$)/i;

const SHARED_PATTERN = /^(?:\/private)?\/(?:tmp|var\/folders)\/.*[*?]/;

interface Destruction {
  what: string;
  paths?: string[];
  bounded?: boolean;
}

/** Names nobody misses: editor and OS droppings, compiled caches, patch leftovers. */
const LITTER =
  /^(?:\.DS_Store|Thumbs\.db|__pycache__|\*\.(?:pyc|pyo|orig|rej|bak|tmp|temp|swp|log)|\*~|\.#\*|node_modules|\.pytest_cache|\.mypy_cache|\.ruff_cache)$/;
const FIND_TESTS = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-regex",
  "-newer",
  "-mmin",
  "-mtime",
  "-size",
  "-empty",
]);

function destroys(command: SimpleCommand): Destruction | null {
  const argv = unwrapRunner(command.argv);
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  if (program === "rm" && (hasShort(argv, "r") || hasShort(argv, "R") || hasLong(argv, "--recursive"))) {
    const targets = operands(argv);
    // through xargs the targets are not on the command line
    if (command.viaXargs) return null;
    // a pattern in a shared temporary directory may take another seat's files
    const kept = targets.filter((t) => !REBUILT.test(t.replace(/\/+$/, "")) || SHARED_PATTERN.test(t));
    return kept.length > 0 ? { what: `recursive delete of ${kept.slice(0, 3).join(", ")}`, paths: kept } : null;
  }
  if (
    program === "find" &&
    (argv.includes("-delete") || argv.some((a, i) => a === "-exec" && /^(?:rm|shred)$/.test(argv[i + 1] ?? "")))
  ) {
    const first = argv.findIndex((word, index) => index > 0 && /^[-(!]/.test(word));
    const roots = argv.slice(1, first < 0 ? argv.length : first).filter((root) => !REBUILT.test(root));
    const names = argv.flatMap((word, index) => (word === "-name" || word === "-iname" ? [argv[index + 1] ?? ""] : []));
    if ((first === 1 ? false : roots.length === 0) || (names.length > 0 && names.every((name) => LITTER.test(name))))
      return null;
    const under = roots.length > 0 ? roots : ["."];
    return {
      what: `find … -delete under ${under.slice(0, 3).join(", ")}`,
      paths: under,
      bounded: argv.some((word) => FIND_TESTS.has(word)),
    };
  }
  if (program === "git") {
    const { verb, rest } = gitVerb(argv);
    const has = (...names: string[]) => rest.some((r) => names.includes(r.split("=")[0]));
    const short = (letter: string) => rest.some((r) => /^-[a-zA-Z]+$/.test(r) && r.includes(letter));
    if (
      verb === "push" &&
      (has("--force", "--force-with-lease", "--mirror", "--delete") ||
        short("f") ||
        short("d") ||
        rest.some((r) => /^\+|^:/.test(r)))
    )
      return { what: "git push that rewrites or deletes a remote ref" };
    if (verb === "reset" && has("--hard")) return { what: "git reset --hard" };
    if (verb === "clean" && (short("f") || has("--force")) && !short("n") && !has("--dry-run"))
      return { what: "git clean" };
    const wholeTree = rest.includes(".") || rest.includes(":/");
    const indexOnly = has("--staged") && !has("--worktree");
    if ((verb === "checkout" || verb === "restore") && wholeTree && !indexOnly)
      return { what: `git ${verb} that discards uncommitted changes` };
    if (verb === "stash" && ["drop", "clear"].includes(rest[0])) return { what: `git stash ${rest[0]}` };
    if (verb === "branch" && (short("D") || (has("--delete") && has("--force")))) return { what: "git branch -D" };
    if (
      ["filter-branch", "filter-repo"].includes(verb) ||
      (verb === "reflog" && rest[0] === "expire") ||
      (verb === "update-ref" && short("d"))
    )
      return { what: `git ${verb}` };
    return null;
  }
  if (["psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "clickhouse-client", "duckdb"].includes(program)) {
    const sql = argv.slice(1).join(" ");
    if (
      /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b/i.test(sql) ||
      /\bDELETE\s+FROM\s+[\w."`]+\s*(?:;|$)/i.test(sql)
    )
      return { what: "SQL that drops or empties data" };
    return null;
  }
  if (program === "dd" && argv.some((a) => a.startsWith("of=/dev/"))) return { what: "dd to a device" };
  if (/^mkfs/.test(program) || program === "shred") return { what: program };
  if (program === "kubectl" && argv[1] === "delete") return { what: "kubectl delete" };
  if (program === "terraform" && argv[1] === "destroy") return { what: "terraform destroy" };
  if (
    program === "docker" &&
    ((argv[1] === "system" && argv[2] === "prune") || (argv[1] === "volume" && ["rm", "prune"].includes(argv[2])))
  )
    return { what: `docker ${argv[1]} ${argv[2]}` };
  if (program === "aws" && argv[1] === "s3" && ["rm", "rb"].includes(argv[2])) return { what: `aws s3 ${argv[2]}` };
  if (program === "gh" && argv[1] === "repo" && argv[2] === "delete") return { what: "gh repo delete" };
  if (program === "npm" && argv[1] === "unpublish") return { what: "npm unpublish" };
  return null;
}

function leavesMachine(command: SimpleCommand): string | null {
  const argv = unwrapRunner(command.argv);
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  const verb = operands(argv)[0] ?? "";
  if (program === "git" && gitVerb(argv).verb === "push") return "git push";
  if (
    ["npm", "pnpm", "yarn", "bun", "cargo", "twine", "gem", "poetry"].includes(program) &&
    (verb === "publish" || verb === "upload" || verb === "push")
  )
    return `${program} ${verb}`;
  if (
    program === "gh" &&
    ((verb === "pr" && ["create", "merge", "close", "ready"].includes(argv[2])) ||
      (verb === "release" && ["create", "delete", "upload"].includes(argv[2])) ||
      (verb === "workflow" && argv[2] === "run"))
  )
    return `gh ${verb} ${argv[2]}`;
  if (program === "docker" && verb === "push") return "docker push";
  if (program === "kubectl" && ["apply", "create", "patch", "replace", "scale", "rollout"].includes(verb))
    return `kubectl ${verb}`;
  if (program === "terraform" && verb === "apply") return "terraform apply";
  if (
    ["vercel", "netlify", "fly", "flyctl", "wrangler", "firebase", "railway", "heroku"].includes(program) &&
    /^(?:deploy|publish|--prod)$/.test(verb || argv[1] || "")
  )
    return `${program} deploy`;
  return null;
}

const SYSTEM_INSTALLERS: Record<string, readonly string[]> = {
  brew: ["install", "reinstall", "upgrade", "tap"],
  apt: ["install"],
  "apt-get": ["install"],
  dnf: ["install"],
  yum: ["install"],
  zypper: ["install"],
  apk: ["add"],
  port: ["install"],
  snap: ["install"],
  winget: ["install"],
  choco: ["install"],
  scoop: ["install"],
};
const TOOL_INSTALLERS: Record<string, readonly string[]> = {
  pipx: ["install"],
  gem: ["install"],
  nvm: ["install"],
  fnm: ["install"],
  volta: ["install"],
  asdf: ["install"],
  pyenv: ["install"],
  mise: ["install", "use"],
};
const TWO_WORD_INSTALLERS: Record<string, readonly string[]> = {
  uv: ["tool install"],
  dotnet: ["tool install"],
  rustup: ["toolchain install", "component add", "target add"],
};
const BROWSER_FETCHERS = new Set(["playwright", "playwright-core", "@playwright/test", "cypress"]);

const FETCHERS = new Set(["curl", "wget"]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const UNPACKERS = new Set(["tar", "bsdtar", "gtar"]);
const ARCHIVE = /\.(?:tar(?:\.(?:gz|xz|bz2|zst))?|tgz|zip|dmg|pkg|deb|rpm|appimage|exe|msi)(?:[?#].*)?$/i;

/** Software a command puts on the machine, the project's own dependencies aside. */
function installs(command: SimpleCommand, next: SimpleCommand | undefined): string | null {
  const raw = command.argv;
  const name = (of: SimpleCommand) => (of.argv[0] ?? "").split("/").pop() ?? "";
  // asking what an install would do installs nothing
  if (hasLong(raw, "--dry-run", "--help") || flags(raw).includes("-h")) return null;
  if (FETCHERS.has(name(command))) {
    const into = command.joiner === "|" && next ? name(next) : "";
    if (SHELL_PROGRAMS.has(into)) return "a script from the network piped into a shell";
    return UNPACKERS.has(into) || raw.some((word) => ARCHIVE.test(word)) ? "an archive from the network" : null;
  }
  const tool = (raw[0] ?? "").split("/").pop() ?? "";
  const first = operands(raw)[0] ?? "";
  if (SYSTEM_INSTALLERS[tool]?.includes(first)) return `a system package (${tool} ${first})`;
  if (tool === "pacman" && flags(raw).some((flag) => /^-S/.test(flag))) return "a system package (pacman -S)";
  if (TOOL_INSTALLERS[tool]?.includes(first)) return `a tool for this user (${tool} ${first})`;
  const pair = `${first} ${operands(raw)[1] ?? ""}`;
  if (TWO_WORD_INSTALLERS[tool]?.includes(pair)) return `a tool for this user (${tool} ${pair})`;
  // a project's own binary goes in the same way: `cargo install --path .`
  if (tool === "cargo" && first === "install" && !hasLong(raw, "--path")) return "a tool for this user (cargo install)";
  if (tool === "go" && first === "install" && operands(raw).some((word) => word.includes("@")))
    return "a tool for this user (go install)";
  if (/^pip[0-9.]*$/.test(tool) && first === "install" && hasLong(raw, "--user"))
    return `a package for this user (${tool} install --user)`;
  if (["npm", "pnpm", "bun"].includes(tool) && ["install", "i", "add"].includes(first)) {
    if (flags(raw).includes("-g") || hasLong(raw, "--global")) return `a global package (${tool} ${first} -g)`;
  }
  if (tool === "yarn" && first === "global" && operands(raw)[1] === "add") return "a global package (yarn global add)";
  const argv = unwrapRunner(raw);
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  const words = operands(argv);
  const fetcher = [program, argv[0] ?? ""].find((name) => BROWSER_FETCHERS.has(name));
  if (fetcher && /^install(?:-deps)?$/.test(words[0] ?? "")) return `a browser download (${fetcher} ${words[0]})`;
  if (
    (program === "puppeteer" && words[0] === "browsers" && words[1] === "install") ||
    ((argv[0] ?? "") === "@puppeteer/browsers" && words[0] === "install")
  )
    return "a browser download (puppeteer browsers install)";
  return null;
}

const UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };

/** Seconds this command waits by itself; Infinity when it never ends alone. */
function waits(command: SimpleCommand): number {
  const argv = command.argv;
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  if (program === "sleep" || program === "gsleep") {
    return operands(argv).reduce((sum, word) => {
      const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(word);
      return sum + (match ? Number(match[1]) * UNIT_SECONDS[match[2]] : 0);
    }, 0);
  }
  if (program === "watch") return Number.POSITIVE_INFINITY;
  if (program === "tail" && (hasShort(argv, "f") || hasShort(argv, "F") || hasLong(argv, "--follow")))
    return Number.POSITIVE_INFINITY;
  if (program === "gh" && argv[1] === "run" && argv[2] === "watch") return Number.POSITIVE_INFINITY;
  if (program === "kubectl" && (argv[1] === "wait" || hasShort(argv, "w") || hasLong(argv, "--watch")))
    return Number.POSITIVE_INFINITY;
  return 0;
}

const LOOK_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "less",
  "more",
  "bat",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "fd",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "which",
  "type",
  "whoami",
  "date",
  "printenv",
  "uname",
  "hostname",
  "id",
  "ps",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "xxd",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "test",
  "[",
  "[[",
  "true",
  "false",
  ":",
  "cd",
  "pushd",
  "popd",
  "echo",
  "printf",
  "seq",
  "nl",
  "column",
  "awk",
  "env",
  "export",
  "set",
  "unset",
  "command",
  "exit",
  "return",
]);
const GIT_LOOKS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "blame",
  "describe",
  "shortlog",
  "remote",
  "config",
  "fetch",
  "cat-file",
  "merge-base",
  "rev-list",
  "grep",
  "worktree",
  "branch",
  "tag",
  "reflog",
  "version",
  "var",
  "check-ignore",
  "diff-tree",
  "name-rev",
  "symbolic-ref",
  "for-each-ref",
]);

function looksOnly(command: SimpleCommand): boolean {
  const argv = unwrapRunner(command.argv);
  const program = (argv[0] ?? "").split("/").pop() ?? "";
  if (program === "git") return GIT_LOOKS.has(gitVerb(argv).verb);
  if (program === "gh")
    return ["view", "list", "diff", "checks", "status"].includes(argv[2] ?? "") || argv[1] === "status";
  if (program === "tail") return waits(command) === 0;
  if (program === "find") return !argv.some((a) => ["-delete", "-exec", "-execdir", "-ok"].includes(a));
  if (program === "sed") return WRITE_PROGRAMS.sed(argv) === null;
  return LOOK_PROGRAMS.has(program);
}

/* ---------- the reading of one command ---------- */

export function effectsOf(command: SimpleCommand, context: EffectContext, next?: SimpleCommand): Effect[] {
  const effects: Effect[] = [];
  const check = checkOf(command, context);
  if (check) effects.push(check);
  const destroyed = destroys(command);
  if (destroyed) effects.push({ kind: "destroy", ...destroyed });
  const external = leavesMachine(command);
  if (external) effects.push({ kind: "external", what: external });
  const installed = installs(command, next);
  if (installed) effects.push({ kind: "install", what: installed });
  const seconds = waits(command);
  if (seconds > 0) effects.push({ kind: "wait", seconds });
  const written = writesOf(command);
  if (written) effects.push(written);
  if (effects.length === 0 && looksOnly(command)) effects.push({ kind: "look" });
  return effects;
}
