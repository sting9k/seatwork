import assert from "node:assert/strict";
import { test } from "node:test";
import { effectsOf } from "../server/watch/effects";
import { parseShell, statusCovers } from "../server/watch/shell";

const programs = (command: string) => parseShell(command).commands.map((c) => c.argv.slice(0, 2).join(" "));
const kinds = (command: string, namedChecks: string[] = []) => parseShell(command).commands.flatMap((c) => effectsOf(c, { namedChecks }).map((e) => e.kind));

test("a command line is read as the commands the shell would run, never as its quoted text", () => {
  assert.deepEqual(programs(`git commit -m "drop the rm -rf step"`), ["git commit"]);
  assert.deepEqual(programs(`echo "DROP TABLE users" | tee notes.md`), ["echo DROP TABLE users", "tee notes.md"]);
  assert.deepEqual(programs(`cd api && npm test 2>&1 | tail -20`), ["cd api", "npm test", "tail -20"]);
  assert.deepEqual(programs(`bash -lc "npm run build && npm test"`), ["npm run", "npm test"]);
  assert.deepEqual(programs(`FOO=1 sudo -u app timeout -k 5 60 pytest -x`), ["pytest -x"]);
  assert.deepEqual(programs(`cat > src/a.js <<'EOF'\nrm -rf /\nEOF\nnpm test`), ["cat", "npm test"]);
  assert.deepEqual(programs(`bash <<'EOF'\nset -e\nnpm test\nEOF`), ["set -e", "npm test"]);
  assert.deepEqual(programs(`node -e "process.exit(3)" # rm -rf /`), ["node -e"]);
});

test("words that are only data cause no effect", () => {
  assert.deepEqual(kinds(`git commit -m "rm -rf build and git push --force"`), []);
  assert.deepEqual(kinds(`grep -rn "DROP TABLE" src`), ["look"]);
  assert.deepEqual(kinds(`cat > notes.md <<'EOF'\nsleep 600\nnpm publish\nEOF`), ["write"]);
});

test("the line's exit status proves a check only when the check's own status reaches it", () => {
  const covers = (command: string, program: string) => {
    const line = parseShell(command);
    return statusCovers(line, line.commands.find((c) => c.argv[0] === program)!);
  };
  assert.equal(covers("npm test", "npm"), true);
  assert.equal(covers("cd api && npm test", "npm"), true);
  assert.equal(covers("npm test && echo ok", "npm"), true);
  assert.equal(covers("(cd web && npm test) || exit 1", "npm"), true);
  assert.equal(covers("npm test | tail -5", "npm"), false);
  assert.equal(covers("npm test; git status", "npm"), false);
  assert.equal(covers("npm test || true", "npm"), false);
  assert.equal(covers("npm test &", "npm"), false);
  assert.equal(covers("if npm test; then echo ok; fi", "npm"), false);
});

test("commands are known by what they do", () => {
  const cases: [string, string[]][] = [
    ["npm test", ["check"]],
    ["pnpm lint", ["check"]],
    ["npx vitest run", ["check"]],
    ["python -m pytest -x tests/", ["check"]],
    ["cargo nextest run", ["check"]],
    ["go vet ./...", ["check"]],
    ["npx tsc --noEmit", ["check"]],
    ["npm install left-pad", ["write"]],
    ["pnpm install", ["write"]],
    ["vitest --watch", []],
    ["printf 'x' > b.txt", ["write"]],
    ["sed -i '' 's/a/b/' src/a.js", ["write"]],
    ["npm test > out.log 2>&1", ["check", "write"]],
    ["prettier --write .", ["write"]],
    ["rm -rf src", ["destroy", "write"]],
    ["rm -rf node_modules dist /tmp/x", ["write"]],
    ['rm -rf "$TMPDIR/work"', ["write"]],
    ["git reset --hard HEAD~1", ["destroy", "write"]],
    ["git push --force-with-lease origin feat", ["destroy", "external"]],
    ["git push origin feat", ["external"]],
    ["git clean -n", []],
    ["git restore --staged .", ["write"]],
    ["find src -name '*.ts' -delete", ["destroy"]],
    ["find . -name '*.pyc' -delete", []],
    ["find . -name __pycache__ -type d -exec rm -rf {} +", []],
    ['psql -c "DROP TABLE users"', ["destroy"]],
    ["gh pr create --fill", ["external"]],
    ["sleep 90", ["wait"]],
    ["tail -f server.log", ["wait"]],
    ["git status", ["look"]],
    ["ls -la", ["look"]],
    ["node scripts/migrate.js", []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(kinds(command), expected, command);
});

test("a command the brief names as proof is a check, whatever it is called", () => {
  assert.deepEqual(kinds("./tools/gate.sh --fast"), []);
  assert.deepEqual(kinds("./tools/gate.sh --fast", ["./tools/gate.sh"]), ["check"]);
  assert.deepEqual(kinds("./scripts/verify.sh"), ["check"], "a script named for what it does needs no brief");
  assert.deepEqual(kinds("node --test test/reconnect.test.ts", ["reconnect.test.ts"]), ["check"]);
});

test("a sleep inside a shell loop is seen as a loop, with its length", () => {
  const line = parseShell("while ! curl -s localhost:3000; do sleep 2; done");
  const sleeper = line.commands.find((c) => c.argv[0] === "sleep")!;
  assert.equal(sleeper.inLoop, true);
  assert.deepEqual(effectsOf(sleeper, { namedChecks: [] }), [{ kind: "wait", seconds: 2 }]);
});

test("an open quote is read as far as it goes and marked incomplete", () => {
  const line = parseShell(`echo "unterminated && rm -rf /`);
  assert.equal(line.complete, false);
  assert.deepEqual(line.commands.map((c) => c.argv[0]), ["echo"]);
});
