import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { evaluate, type Tools } from "../server/safety/gate/evaluate";
import { packsInForce } from "../server/safety/gate/packs";
import { namesDriver } from "../server/safety/gate/rules/attributes";
import type { Place } from "../server/safety/gate/types";
import { Guard } from "../server/safety/guard";
import { answerHook, type Cli } from "../server/safety/hooks";
import { SafetyStore } from "../server/safety/store";

shipSql();

const HOME = "/Users/u";
const PROJECT = "/Users/u/proj";
const place: Place = { home: HOME, project: PROJECT, tmp: null, start: PROJECT, guard: null, roomFolder: ".seatwork" };

const CLI = "/opt/homebrew/lib/node_modules/@getpaseo/cli/bin/paseo";
const LINKS: Record<string, string> = {
  "/Users/u/proj/p": CLI,
  "/Users/u/bin/p": "/opt/homebrew/bin/paseo",
  "/Users/u/proj/q": "/Users/u/proj/scripts/build.sh",
  "/Users/u/proj/cfg": "/Users/u/.config",
  "/Users/u/proj/hooks": "/Users/u/proj/.git/hooks",
  "/Users/u/proj/creds": "/Users/u/.aws/credentials",
  "/Users/u/proj/shared": "/Users/u/shared",
};

const tools: Tools = {
  ignored: async (paths) => new Set(paths.filter((path) => /\/node_modules(\/|$)/.test(path))),
  exempt: () => false,
  alias: async () => null,
  external: async () => false,
  rebasing: async () => false,
  stat: () => ({ exists: false, link: false, dir: false }),
  real: (path) => LINKS[path] ?? null,
  changed: async () => null,
};

/** The rules a command trips, as `pack:rule`, sorted, with `doubt` for each thing the gate could not read. */
async function rules(command: string, cwd: string | null = PROJECT): Promise<string[]> {
  const found = await evaluate(
    command,
    cwd,
    place,
    { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
    tools,
  );
  return [...found.findings.map((f) => `${f.pack}:${f.rule}`), ...found.doubts.map(() => "doubt")].sort();
}

const PASEO = ["room.guard:paseo-cli"];

test("the Paseo CLI is stopped when a runtime or a shell starts it by the path of its script", async () => {
  for (const line of [
    `node ${CLI} send abc hi`,
    "node /opt/homebrew/lib/node_modules/@getpaseo/cli/dist/index.js send abc hi",
    "node --disable-warning=DEP0040 /opt/homebrew/lib/node_modules/@getpaseo/cli/dist/index.js send abc hi",
    "node -r ./preload.js node_modules/@getpaseo/cli/dist/index.js send abc hi",
    "bun /usr/local/lib/node_modules/@getpaseo/cli/dist/index.js run x",
    "tsx ./node_modules/@getpaseo/cli/dist/index.js send abc hi",
    "node /Users/u/.nvm/versions/node/v22/lib/node_modules/@getpaseo/cli/bin/paseo agent ls",
    "sh /Applications/Paseo.app/Contents/Resources/bin/paseo send abc hi",
    "bash /opt/homebrew/bin/paseo send abc hi",
    "source /opt/homebrew/bin/paseo send abc",
    "cd /opt/homebrew/lib/node_modules/@getpaseo/cli && node dist/index.js send abc hi",
    "(cd /opt/homebrew/lib/node_modules/@getpaseo/cli/dist; node ./index.js send abc)",
    `env FOO=1 nice node ${CLI} ls`,
  ])
    assert.deepEqual(await rules(line), PASEO, line);
});

test("a script path that only mentions the Paseo CLI, or a run that names no command, is not stopped", async () => {
  for (const line of [
    `node ${CLI}`,
    `node ${CLI} --version`,
    "node dist/index.js send abc hi",
    "node scripts/check-cli.js /opt/homebrew/bin/paseo",
    "node -e 'console.log(1)'",
    "tsx scripts/send.ts hello",
    "bash scripts/deploy.sh send now",
    `cat ${CLI}`,
    "ls -l /opt/homebrew/lib/node_modules/@getpaseo/cli/dist/index.js",
    "grep -n send /opt/homebrew/lib/node_modules/@getpaseo/cli/dist/cli.js",
    "head -3 /opt/homebrew/bin/paseo",
    "readlink -f /opt/homebrew/bin/paseo",
    "wc -l node_modules/@getpaseo/cli/package.json",
  ])
    assert.deepEqual(await rules(line), [], line);
});

test("a link to the Paseo CLI under another name is followed to what it points at", async () => {
  for (const line of [
    "./p send abc hi",
    "/Users/u/proj/p send abc hi",
    "/Users/u/bin/p run x",
    "node ./p send abc hi",
    "sh ./p send abc hi",
    "env -i /Users/u/bin/p send abc hi",
    "cd /Users/u/bin && ./p send abc hi",
    "echo abc | xargs ./p send",
  ])
    assert.deepEqual(await rules(line), PASEO, line);
  for (const line of ["./p", "./p --version", "./q send abc hi", "./scripts/build.sh send", "cat ./p", "ls -l ./p"])
    assert.deepEqual(await rules(line), [], line);
});

test("making a link to the Paseo CLI is stopped, and so is using one made earlier on the same line", async () => {
  for (const line of [
    "ln -s /opt/homebrew/bin/paseo /tmp/p",
    "ln -sf /opt/homebrew/lib/node_modules/@getpaseo/cli/bin/paseo ~/.local/bin/p",
    "ln -s $(which paseo) ~/.local/bin/p",
    "ln -s `command -v paseo` p",
    "ln -s /opt/homebrew/bin/paseo pp && ./pp send abc hi",
    "ln -s $(which paseo) /tmp/pp; /tmp/pp send abc hi",
  ])
    assert.deepEqual(await rules(line), PASEO, line);
  for (const line of [
    "ln -s ../lib/foo.so foo.so",
    "ln -sf $(which node) node",
    "ln -s node_modules/.bin/vitest vitest",
    "ln -s /opt/homebrew/bin/jq /tmp/jq && /tmp/jq . x.json",
    "ln -s README.md paseo-readme.md",
  ])
    assert.deepEqual(await rules(line), [], line);
});

test("a substitution that names the Paseo CLI stands for it", async () => {
  for (const line of [
    "$(which paseo) send abc hi",
    "`which paseo` send abc hi",
    "$(command -v paseo) send abc hi",
    "$(type -p paseo) send abc hi",
    '"$(which paseo)" send abc hi',
    "$(readlink -f $(which paseo)) send abc hi",
    "$(realpath /opt/homebrew/bin/paseo) send abc hi",
    "p=$(which paseo); $p send abc hi",
    'p="$(command -v paseo)"; "$p" send abc hi',
    "export P=$(which paseo); $P run x",
    "node $(which paseo) send abc hi",
    "echo abc | xargs $(which paseo) send",
  ])
    assert.deepEqual(await rules(line), PASEO, line);
  for (const line of [
    "which paseo",
    "echo $(which paseo)",
    "ls -l $(which paseo)",
    "$(which paseo) --version",
    "$(which paseo)",
    "p=$(which paseo); echo $p",
    "$(which node) script.js",
    "p=$(which git); $p status",
    "echo $(command -v paseo) >> notes.txt",
  ])
    assert.deepEqual(await rules(line), [], line);
});

test("a shell alias of the Paseo CLI defined on the line stands for it", async () => {
  for (const line of [
    "alias p=paseo; p send abc hi",
    "alias p='paseo'; p run x",
    "alias p=/opt/homebrew/bin/paseo\np send abc hi",
    "alias p=paseo && p send abc hi",
    "if true; then alias p=paseo; fi; p send abc hi",
  ])
    assert.deepEqual(await rules(line), PASEO, line);
  for (const line of [
    "alias p=paseo; p --version",
    "alias ll='ls -la'; ll",
    "alias g=git; g status",
    "alias p=paseo; echo p send",
    "alias ls='ls -la'; ls",
    "alias rm='rm -i'; rm a.txt",
  ])
    assert.deepEqual(await rules(line), [], line);
});

test("a package runner is read through the options that come before its subcommand", async () => {
  for (const line of [
    "pnpm --silent dlx @getpaseo/cli send abc hi",
    "pnpm --filter app exec paseo send abc hi",
    "pnpm -C . dlx @getpaseo/cli send abc hi",
    "pnpm -r exec paseo ls",
    "npm --yes exec @getpaseo/cli -- send abc hi",
    "npm --prefix ./app exec paseo -- send abc hi",
    "yarn --silent dlx @getpaseo/cli send abc",
    "yarn paseo send abc",
    "pnpm paseo send abc hi",
  ])
    assert.deepEqual(await rules(line), PASEO, line);
  assert.deepEqual(await rules("pnpm --filter app exec rm -rf /"), ["core.filesystem:rm-rf-root-home"]);
  for (const line of [
    "pnpm --silent dlx cowsay hi",
    "pnpm --filter app exec ls",
    "npm --yes exec cowsay hi",
    "yarn lint",
    "pnpm test",
    "pnpm dlx @getpaseo/cli --version",
    "pnpm --filter app test",
    "npx tsx script.ts",
  ])
    assert.deepEqual(await rules(line), [], line);
});

const ATTRIBUTES = ["room.guard:git-attributes-driver"];

test("a shell command that writes a filter or driver into .gitattributes is stopped, whichever way it shows the text", async () => {
  for (const line of [
    "echo '* filter=x' >> .gitattributes",
    "echo '*.bin diff=hex' > .gitattributes",
    "printf '*.bin filter=x\\n' >> .gitattributes",
    "printf '* text=auto\\n*.dat\\tmerge=custom\\n' > sub/.gitattributes",
    "cat > .gitattributes <<EOF\n* text=auto\n*.bin filter=x\nEOF",
    "cat >> .gitattributes <<'EOF'\n*.bin diff=custom\nEOF",
    "tee .gitattributes <<< '* filter=x'",
    "tee -a .gitattributes <<EOF\n* filter=x\nEOF",
    "echo '* filter=x' | tee .gitattributes",
    "printf '* filter=x\\n' | tee -a /Users/u/proj/.gitattributes",
    "cat <<EOF | tee .gitattributes\n* filter=x\nEOF",
    "x='* filter=evil'; echo \"$x\" >> .gitattributes",
    "echo '* filter=x' > /tmp/attrs && cp /tmp/attrs .gitattributes",
    "(echo '* filter=x' >> .gitattributes)",
    "cd sub && echo '* filter=x' >> .gitattributes",
    "bash -c \"echo '* filter=x' >> .gitattributes\"",
  ])
    assert.deepEqual(await rules(line), ATTRIBUTES, line);
});

test("a .gitattributes line that names no driver of its own, or text that goes elsewhere, is not stopped", async () => {
  for (const line of [
    "echo '* text=auto' >> .gitattributes",
    "echo '*.png binary' >> .gitattributes",
    "echo '* filter=lfs diff=lfs merge=lfs -text' >> .gitattributes",
    "git lfs track '*.psd'",
    "printf '*.go diff=golang\\n*.md diff=markdown\\n' >> .gitattributes",
    "echo '*.lock -diff' >> .gitattributes",
    "echo 'yarn.lock merge=union' >> .gitattributes",
    "echo '* filter=x' >> notes.txt",
    "echo '* filter=x' > attributes.md",
    "cat .gitattributes",
    "grep filter .gitattributes",
    "echo 'filter=x' >> .gitignore",
    "cat > .gitattributes <<EOF\n* text=auto eol=lf\nEOF",
    "tee .gitattributes <<< '*.sh eol=lf'",
    "echo '* filter=x' | grep filter",
    "echo '* filter=x'",
  ])
    assert.deepEqual(await rules(line), [], line);
});

test("the guard reads .gitattributes by the rule of the hand-in check, and only the person lifts it", async () => {
  const lines = [
    "* text=auto",
    "*.png binary",
    "*.lock -diff",
    "*.go diff=golang",
    "*.md diff=markdown",
    "yarn.lock merge=union",
    "*.sh eol=lf",
    "*.bin filter=trap",
    "*.dat diff=hex",
    "*.json merge=custom",
    "docs/** filter=lfs diff=lfs merge=lfs -text",
  ];
  assert.deepEqual(
    lines.map((line) => namesDriver(line)),
    [false, false, false, false, false, false, false, true, true, true, false],
  );
  const guard = new Guard({
    store: () => new SafetyStore(join(ROOM_HOME, "holes-attributes"), 1000),
    policy: () => ({}),
    tools: () => tools,
    place: () => place,
    repeated: () => {},
  });
  const seat = { id: "peer", role: "peer", project: PROJECT, tmp: null, start: PROJECT };
  const ruling = await guard.check(seat, "claude", "echo '* filter=x' >> .gitattributes", PROJECT);
  assert.equal(ruling.allow, false);
  assert.equal(ruling.finding?.rule, "git-attributes-driver");
  assert.equal(ruling.grantor, "human");
  assert.equal((await guard.check(seat, "claude", "echo '*.png binary' >> .gitattributes", PROJECT)).allow, true);
});

const ROOT = ["core.filesystem:rm-rf-root-home"];
const GENERAL = ["core.filesystem:rm-rf-general"];
const GENERATED = ["core.filesystem:rm-generated"];

test("a cd inside a function reaches the line from where the function is called", async () => {
  for (const line of [
    "f() { cd /; }; f; rm -rf etc",
    "function f { cd /; }; f; rm -rf etc",
    "f() { cd /; }; f && rm -rf etc",
    "f() { cd /; }; g() { f; }; g; rm -rf etc",
    "f() { cd /; }; if true; then f; fi; f; rm -rf etc",
    "f() { cd /; rm -rf etc; }; f",
  ])
    assert.deepEqual(await rules(line), ROOT, line);
  for (const line of [
    "f() { cd /; }; (f); rm -rf node_modules",
    "f() { cd /; }; x=$(f); rm -rf node_modules",
    "f() { cd /; }; f & rm -rf node_modules",
    "f() { cd /Users/u/proj/sub; }; cd /; f; rm -rf node_modules",
    "setup() { mkdir -p out; }; setup; rm -rf node_modules",
    "clean() { rm -rf node_modules; }; clean",
  ])
    assert.deepEqual(await rules(line), GENERATED, line);
  assert.deepEqual(await rules("build() { cd app && npm run build; }; build"), []);
});

test("a function body is read in the folder of its caller, and one the line may define two ways runs both", async () => {
  assert.deepEqual(await rules("f() { rm -rf node_modules; }; cd /; f"), [...GENERATED, ...ROOT].sort());
  for (const line of [
    "f() { cd /; }; echo x | f; rm -rf node_modules",
    "if true; then f() { cd /; }; else f() { cd /tmp; }; fi; f; rm -rf node_modules",
    "if false; then f() { cd /; }; fi; f; rm -rf node_modules",
    "f() { [ -d x ] && cd x; }; f; rm -rf node_modules",
  ])
    assert.deepEqual(await rules(line), GENERAL, line);
  assert.deepEqual(await rules("f() { f; }; f"), []);
  assert.deepEqual(await rules("f() { g; }; g() { f; }; f; rm -rf node_modules"), GENERATED);
  assert.deepEqual(await rules("f() { cd /; }; unset -f f; f; rm -rf node_modules"), GENERATED);
});

test("what a function declares local is gone when it returns", async () => {
  assert.deepEqual(
    await rules("f() { local d=/; cd $d; }; d=/Users/u/proj/sub; f; cd $d; rm -rf node_modules"),
    GENERATED,
  );
  assert.deepEqual(await rules("f() { local d=/Users/u/proj; }; d=/; f; cd $d; rm -rf etc"), ROOT);
});

test("a variable that holds a folder is followed, and unknown wherever the line leaves two values", async () => {
  for (const line of [
    "d=/; cd $d; rm -rf etc",
    'd=/; cd "$d"; rm -rf etc',
    "d=/; cd ${d}; rm -rf etc",
    "export d=/; cd $d; rm -rf etc",
  ])
    assert.deepEqual(await rules(line), ROOT, line);
  assert.deepEqual(await rules("d=/Users/u/proj; d+=/sub; cd $d; rm -rf node_modules"), GENERATED);
  for (const line of [
    "cd $d; rm -rf node_modules",
    "d=/; if cmd; then d=/Users/u/proj; fi; cd $d; rm -rf node_modules",
    "d=/; case $x in a) d=/Users/u/proj;; esac; cd $d; rm -rf node_modules",
    "d=/; for x in 1 2; do d=/Users/u/proj; done; cd $d; rm -rf node_modules",
    "d=/; while cmd; do d=/Users/u/proj; done; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; for d in / /tmp; do cd $d; rm -rf node_modules; done",
    "d=/Users/u/proj; read d; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; read -r -p 'where? ' d; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; mapfile d < list; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; printf -v d /; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; getopts ab d; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; (( d++ )); cd $d; rm -rf node_modules",
    "d=/Users/u/proj; let d=1; cd $d; rm -rf node_modules",
    "d=/Users/u/proj; : ${d:=/}; cd $d; rm -rf node_modules",
    "d=(/ /tmp); cd $d; rm -rf node_modules",
    "d=/Users/u/proj; d[0]=/; cd $d; rm -rf node_modules",
    "d+=/x; cd $d; rm -rf node_modules",
    "d=/; cmd || d=/Users/u/proj; cd $d; rm -rf node_modules",
    "d=/; true || d=/Users/u/proj; cd $d; rm -rf node_modules",
    "d=/; false && d=/Users/u/proj; cd $d; rm -rf node_modules",
  ])
    assert.deepEqual(await rules(line), GENERAL, line);
});

test("~ and a bare cd follow HOME when the line sets it", async () => {
  assert.deepEqual(await rules("HOME=/; cd ~; rm -rf etc"), ROOT);
  assert.deepEqual(await rules("HOME=/; cd; rm -rf etc"), ROOT);
  assert.deepEqual(await rules("HOME=$X; cd ~; rm -rf node_modules"), GENERAL);
  assert.deepEqual(await rules("pushd; rm -rf node_modules"), GENERAL);
  assert.deepEqual(await rules("pushd +1; rm -rf node_modules"), GENERAL);
});

test("eval and source run in the line's own shell, so what they change stays", async () => {
  for (const line of [
    "eval 'cd /'; rm -rf etc",
    'eval "cd /"; rm -rf etc',
    "d=/Users/u/proj; eval 'd=/'; cd $d; rm -rf etc",
    "echo 'cd /' > e.sh; source ./e.sh; rm -rf etc",
    "cat > e.sh <<EOF\ncd /\nEOF\n. e.sh; rm -rf etc",
  ])
    assert.deepEqual(await rules(line), ROOT, line);
  for (const line of [
    "bash -c 'cd /'; rm -rf node_modules",
    "echo 'cd /' > e.sh; sh e.sh; rm -rf node_modules",
    "echo 'cd /' > e.sh; bash ./e.sh; rm -rf node_modules",
  ])
    assert.deepEqual(await rules(line), GENERATED, line);
});

test("in a list of && and ||, each command runs where the ones before let it, and what follows stands after any of them", async () => {
  for (const line of [
    "cd / && rm -rf etc",
    "cd /Users/u/proj/sub && true && cd / && rm -rf etc",
    "{ cd /; } || true; rm -rf etc",
    "{ cd /; } && true; rm -rf etc",
    "if cd / && true; then rm -rf etc; fi",
    "while true && cd /; do rm -rf etc; break; done",
    "cd / && rm -rf etc &",
  ])
    assert.deepEqual(await rules(line), ROOT, line);
  for (const line of [
    "cd /Users/u/proj/sub && rm -rf node_modules",
    "git pull && cd /Users/u/proj/sub && rm -rf node_modules",
    "cd / && cd /Users/u/proj && rm -rf node_modules",
    "cd /Users/u/proj/sub && make || echo failed; rm -rf node_modules",
    "cd /Users/u/proj/build || exit 1; rm -rf node_modules",
    "cd /Users/u/proj/build || { echo no; exit 1; }; rm -rf node_modules",
    "(cd / && true) || rm -rf node_modules",
    "(cd /) && rm -rf node_modules",
    "cd / & rm -rf node_modules",
    "true && echo a || echo b; rm -rf node_modules",
    "test -d x && echo y || echo n; rm -rf node_modules",
  ])
    assert.deepEqual(await rules(line), GENERATED, line);
  for (const line of [
    "cd / || cd /Users/u/proj; rm -rf node_modules",
    "cd /; true || cd /Users/u/proj; rm -rf node_modules",
    "cd /; false && cd /Users/u/proj; rm -rf node_modules",
    "[ -d sub ] && cd sub; rm -rf node_modules",
    "cd /Users/u/proj/sub || cd /; rm -rf node_modules",
    "a && cd / || cd /tmp; rm -rf node_modules",
    "cd / && a || cd /Users/u/proj; rm -rf node_modules",
    "true | cd /; rm -rf node_modules",
  ])
    assert.deepEqual(await rules(line), GENERAL, line);
});

test("a file written in a subshell or a stage of a pipeline is written all the same", async () => {
  for (const line of [
    "(echo 'rm -rf /' > e.sh); sh e.sh",
    "echo 'rm -rf /' | tee e.sh; sh e.sh",
    "echo 'rm -rf /' > e.sh & wait; sh e.sh",
    "x=$(echo 'rm -rf /' > e.sh); sh e.sh",
  ])
    assert.deepEqual(await rules(line), ROOT, line);
  assert.deepEqual(await rules("(echo 'echo hi' > e.sh); sh e.sh"), []);
});

test("an alias that is told to expand to itself, or functions that call each other, end", async () => {
  assert.deepEqual(await rules("alias ls='ls -la'; ls"), []);
  assert.deepEqual(await rules("alias a=b; alias b=a; a"), []);
  assert.deepEqual(await rules("f() { g; g; }; g() { h; h; }; h() { i; i; }; i() { f; f; }; f"), []);
  // each function calls the one before it twice: the calls double with every level, and the reading stops at a fixed number
  const doubling = Array.from({ length: 30 }, (_, i) => `f${i + 1}() { f${i}; f${i}; };`).join(" ");
  assert.deepEqual(await rules(`f0() { :; }; ${doubling} f30`), ["doubt"]);
});

test("long lists of commands and of branches cost in proportion to their length", async () => {
  const chain = (n: number) => Array.from({ length: n }, () => "true").join(" && ");
  const either = (n: number) => Array.from({ length: n }, (_, i) => `x=${i}`).join(" || ");
  const mixed = (n: number) => Array.from({ length: n }, () => "true && false || true").join("; ");
  const once = async (line: string) => {
    const started = process.hrtime.bigint();
    await rules(line);
    return Number(process.hrtime.bigint() - started);
  };
  // fastest of seven after a warm-up: a line four times longer may cost about four times as much, not sixteen
  const fastest = async (line: string) => {
    await once(line);
    const runs: number[] = [];
    for (let i = 0; i < 7; i += 1) runs.push(await once(line));
    return Math.min(...runs);
  };
  // the best of three pairs: a loaded machine slows one pair, never every pair by the square of the length
  for (const make of [chain, either, mixed]) {
    let best = Infinity;
    for (let pair = 0; pair < 3 && best >= 9; pair += 1)
      best = Math.min(best, (await fastest(make(400))) / (await fastest(make(100))));
    assert.ok(best < 9, `${make.name}: four times the length cost ${best.toFixed(1)} times`);
  }
});

test("a program that a git option or a git variable gives is read as a shell line", async () => {
  for (const line of [
    "git -c core.pager='rm -rf /' log",
    "git -c core.editor='rm -rf /' commit",
    "git -c credential.helper='!rm -rf /' push",
    "git -c diff.external='rm -rf /' diff",
    "git -c core.fsmonitor='rm -rf /' status",
    "git -c filter.x.clean='rm -rf /' add .",
    "git -C sub -c core.pager='rm -rf /' log",
    "GIT_SSH_COMMAND='rm -rf /' git fetch",
    "GIT_EXTERNAL_DIFF='rm -rf /' git diff",
    "GIT_PAGER='rm -rf /' git log",
    "env GIT_EDITOR='rm -rf /' git commit",
    "export GIT_ASKPASS='rm -rf /'; git push",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0='rm -rf /' git log",
  ])
    assert.deepEqual(await rules(line), ROOT, line);
  assert.deepEqual(await rules("git -c core.sshCommand='paseo send a b' fetch"), PASEO);
  assert.deepEqual(await rules("git -c core.pager=$PAGER log"), ["room.guard:git-config-exec"]);
  for (const line of [
    "git -c core.hooksPath=/dev/null commit -m x",
    "git -c core.fsmonitor=false status",
    "git -c core.pager=cat log",
    "git -c core.editor=true rebase -i HEAD~2",
    "git -c user.name=x -c user.email=y commit -m z",
    "git -c core.sshCommand='ssh -i key' fetch",
    "GIT_SSH_COMMAND='ssh -i key' git fetch",
    "GIT_PAGER=cat git log",
    "GIT_EDITOR=true git commit",
    "GIT_TERMINAL_PROMPT=0 git fetch",
    "git -c alias.st=status st",
  ])
    assert.deepEqual(await rules(line), [], line);
});

test("a write through a link that leads into a protected place is a write into it", async () => {
  assert.deepEqual(await rules("echo x > cfg/gh/hosts.yml"), ["core.filesystem:credential-file-write"]);
  assert.deepEqual(await rules("cp token creds"), ["core.filesystem:credential-file-write"]);
  assert.deepEqual(await rules("tee hooks/pre-commit < hook.sh"), ["room.guard:git-config-write"]);
  assert.deepEqual(await rules("echo x > hooks/new/deeper/pre-push"), ["room.guard:git-config-write"]);
  assert.deepEqual(await rules("ln -s ~/.ssh ssh-link"), ["core.filesystem:credential-file-write"]);
  assert.deepEqual(await rules("ln -s /Users/u/.aws/credentials aws.txt"), ["core.filesystem:credential-file-write"]);
  for (const line of [
    "echo x > out/a.txt",
    "echo x > shared/a.txt",
    "ln -s ../shared shared2",
    "ln -s ~/.config cfg2",
    "ln -s /opt/homebrew/bin/jq jq",
    "cat cfg/gh/hosts.yml",
    "echo x > cfg2/notes.txt",
  ])
    assert.deepEqual(await rules(line), [], line);
  const guard = new Guard({
    store: () => new SafetyStore(join(ROOM_HOME, "holes-links"), 1000),
    policy: () => ({}),
    tools: () => tools,
    place: () => place,
    repeated: () => {},
  });
  const seat = { id: "peer", role: "peer", project: PROJECT, tmp: null, start: PROJECT };
  const through = await guard.checkWrite(seat, "claude", `${PROJECT}/cfg/gh/hosts.yml`, PROJECT);
  assert.equal(through.allow, false);
  assert.equal(through.finding?.rule, "credential-file-write");
  assert.equal((await guard.checkWrite(seat, "claude", `${PROJECT}/out/a.txt`, PROJECT)).allow, true);
});

test("a file tool that adds a filter or driver to .gitattributes is stopped, by the text it shows", async () => {
  const guard = new Guard({
    store: () => new SafetyStore(join(ROOM_HOME, "holes-tools"), 1000),
    policy: () => ({}),
    tools: () => tools,
    place: () => place,
    repeated: () => {},
  });
  const seat = { id: "peer", role: "peer", project: PROJECT, tmp: null, start: PROJECT };
  const attributes = `${PROJECT}/.gitattributes`;
  const payloads: [Cli, Record<string, unknown>, boolean][] = [
    [
      "claude",
      { tool_name: "Write", tool_input: { file_path: attributes, content: "* text=auto\n*.bin filter=x\n" } },
      true,
    ],
    [
      "claude",
      { tool_name: "Write", tool_input: { file_path: attributes, content: "* text=auto\n*.png binary\n" } },
      false,
    ],
    [
      "claude",
      { tool_name: "Edit", tool_input: { file_path: attributes, old_string: "a", new_string: "*.bin diff=hex" } },
      true,
    ],
    [
      "claude",
      {
        tool_name: "MultiEdit",
        tool_input: { file_path: attributes, edits: [{ new_string: "x" }, { new_string: "* merge=custom" }] },
      },
      true,
    ],
    [
      "claude",
      { tool_name: "Write", tool_input: { file_path: `${PROJECT}/notes.md`, content: "* filter=x\n" } },
      false,
    ],
    ["pi", { tool: "write", input: { path: attributes, content: "* filter=x\n" } }, true],
    ["pi", { tool: "edit", input: { path: attributes, newText: "* filter=x" } }, true],
    [
      "codex",
      {
        tool_name: "apply_patch",
        tool_input: {
          command: "*** Begin Patch\n*** Add File: .gitattributes\n+* text=auto\n+*.bin filter=x\n*** End Patch",
        },
      },
      true,
    ],
    [
      "codex",
      {
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Update File: .gitattributes\n@@\n-*.bin binary\n+*.bin -diff\n*** Add File: notes.md\n+* filter=x\n*** End Patch",
        },
      },
      false,
    ],
  ];
  for (const [cli, body, stopped] of payloads) {
    const answered = await answerHook(guard, cli, { ...body, cwd: PROJECT }, seat);
    assert.equal(/block":true|"deny"/.test(answered.text), stopped, `${cli} ${JSON.stringify(body)}`);
  }
});
