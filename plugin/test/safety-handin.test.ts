import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { packsInForce } from "../server/safety/gate/packs";
import { handInLine, handInReturn, inspectHandIn, workDigest, type Lookups } from "../server/safety/handin";
import { Safety } from "../server/safety/index";
import { buildControl } from "../server/safety/control";
import { SafetyStore } from "../server/safety/store";
import { machineTools } from "../server/safety/system";

shipSql();

let repos = 0;
/** A git repository with one commit of a small project, and a store that knows a seat started there. */
function project(files: Record<string, string>) {
  const dir = join(ROOM_HOME, `handin-${(repos += 1)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  git("init", "-q");
  write(dir, { ...files, ".gitignore": ".store/\nnode_modules/\ndist/\n" });
  git("add", "-A");
  git("commit", "-qm", "start");
  const store = new SafetyStore(join(dir, ".store"), 1000);
  store.noteStart("seat", dir, git("rev-parse", "HEAD"));
  const gate = {
    place: { home: "/Users/u", project: dir, tmp: null, start: dir, guard: null, roomFolder: ".seatwork" },
    config: { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  };
  return { dir, store, git, check: (lookups: Lookups = {}) => inspectHandIn("seat", store, gate, lookups) };
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const START = {
  "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n",
  "test/sum.test.ts":
    'import { sum } from "../src/sum";\ntest("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n  expect(sum(0, 0)).toBe(0);\n});\n',
  "test/old.test.ts": 'test("old", () => expect(1).toBe(1));\n',
  "package.json": '{"name":"x","scripts":{"test":"jest"}}\n',
};

test("the check reads what the seat changed since it started, committed or not, new files included", async () => {
  const { dir, check, git } = project(START);
  write(dir, {
    "test/sum.test.ts":
      'import { sum } from "../src/sum";\ntest.only("sum", () => {\n  expect(sum(1, 2)).toBeTruthy();\n});\n',
    "src/sum.ts":
      'export const sum = (a: number, b: number) => {\n  debugger;\n  // TODO handle floats\n  const key = "sk-proj-Abcdefghijklmnopqrstuvwx12";\n  return a + b;\n};\n',
    "package.json": '{"name":"x","scripts":{"test":"jest","clean":"rm -rf ~"}}\n',
    "src/new.ts": 'const s = "it.only( and debugger; inside a string are data";\n',
  });
  git("add", "src/sum.ts");
  git("commit", "-qm", "work in progress");
  rmSync(join(dir, "test/old.test.ts"));
  const result = await check();
  assert.equal(result.state, "blocked");
  const open = result.open.map((r) => `${r.rule} ${r.path}`).sort();
  assert.deepEqual(open, [
    "assertions-removed test/sum.test.ts",
    "debugger src/sum.ts",
    "destructive-script package.json",
    "hardcoded-secret src/sum.ts",
    "test-deleted test/old.test.ts",
    "test-focused test/sum.test.ts",
  ]);
  assert.deepEqual(result.warnings.map((r) => r.rule).sort(), ["new-todo", "weak-assertion"]);
  assert.ok(!result.open.some((r) => r.text.includes("sk-proj-Abcdefghijklmnop")), "the secret itself is not kept");
  assert.match(handInReturn(result), /Fix each one, or acknowledge it/);
});

test("the tests no change touched that name a changed source file ride up with the candidate", async () => {
  const { dir, check } = project({
    "src/duration.ts": "export const parse = (s: string) => Number(s);\n",
    "src/index.ts": 'export * from "./duration";\n',
    "src/parser.ts": "export const p = 1;\n",
    "lib/index.ts": "export const other = 1;\n",
    "test/cli.test.ts": 'import { parse } from "../src/duration";\ntest("cli", () => expect(parse("1")).toBe(1));\n',
    "test/duration_extra.test.ts": 'test("x", () => expect(1).toBe(1));\n',
    "test/parse.test.ts": 'import { p } from "../src/parser";\ntest("p", () => expect(p).toBe(1));\n',
    "test/lib.test.ts": 'import { other } from "../lib/index";\ntest("o", () => expect(other).toBe(1));\n',
    "test/entry.test.ts":
      'import * as all from "../src/index";\ntest("all", () => expect(all.parse).toBe(all.parse));\n',
    "docs/duration.md": "duration\n",
    "test/fixtures/duration.json": '{ "duration": 1 }\n',
  });
  write(dir, {
    "src/duration.ts": "export const parse = (s: string) => Number(s) * 1000;\n",
    "src/index.ts": 'export * from "./duration";\nexport const v = 1;\n',
  });
  const result = await check();
  assert.deepEqual(result.related, ["test/cli.test.ts", "test/duration_extra.test.ts", "test/entry.test.ts"]);
  assert.match(
    handInLine(result) ?? "",
    /; 3 unchanged test\(s\) name what changed: test\/cli\.test\.ts, test\/duration_extra\.test\.ts, test\/entry\.test\.ts$/,
  );
});

test("the hand-in counts test lines, names what decides the checks, a test's answer in source, and new dependencies", async () => {
  const { dir, check } = project({
    ...START,
    "package.json": JSON.stringify({ scripts: { test: "jest" }, dependencies: { lodash: "^4" } }, null, 2) + "\n",
    "jest.config.js": "module.exports = {};\n",
    "requirements.txt": "flask==2.0\n",
    "go.mod": "module example.com/app\n\ngo 1.22\n",
    "Cargo.toml": '[package]\nname = "app"\n\n[dependencies]\nserde = "1"\n',
    "pyproject.toml": '[project]\nname = "app"\ndependencies = [\n  "attrs>=23",\n]\n',
    "src/units.ts": "export const ms = (s: string) => Number(s);\n",
    "pom.xml":
      "<project><dependencies>\n<dependency>\n<groupId>org.slf4j</groupId>\n<artifactId>slf4j-api</artifactId>\n</dependency>\n</dependencies></project>\n",
    "app/build.gradle.kts": 'dependencies {\n  implementation("com.squareup.okio:okio:3.9.0")\n}\n',
    Gemfile: 'source "https://rubygems.org"\ngem "rack", "~> 3.0"\n',
    "composer.json": JSON.stringify({ require: { php: ">=8.2", "monolog/monolog": "^3" } }, null, 2) + "\n",
    "App/App.csproj":
      '<Project>\n  <ItemGroup>\n    <PackageReference Include="Serilog" Version="4.0.0" />\n  </ItemGroup>\n</Project>\n',
    "Package.swift": 'let package = Package(name: "App", dependencies: [\n])\n',
  });
  write(dir, {
    "package.json":
      JSON.stringify(
        { scripts: { test: "jest --passWithNoTests" }, dependencies: { lodash: "^4", "left-pad-x": "1.0.0" } },
        null,
        2,
      ) + "\n",
    "jest.config.js": "module.exports = { testPathIgnorePatterns: ['slow'] };\n",
    "requirements.txt": "flask==3.0\nrequests==2.32\n",
    "go.mod": "module example.com/app\n\ngo 1.22\n\nrequire github.com/acme/kit v1.2.0\n",
    "Cargo.toml": '[package]\nname = "app"\nversion = "0.2.0"\n\n[dependencies]\nserde = "1"\ntokio = "1"\n',
    "pyproject.toml": '[project]\nname = "app"\ndependencies = [\n  "attrs>=23",\n  "httpx>=0.27",\n]\n',
    "pom.xml":
      "<project><dependencies>\n<dependency>\n<groupId>org.slf4j</groupId>\n<artifactId>slf4j-api</artifactId>\n</dependency>\n<dependency>\n<groupId>com.google.guava</groupId>\n<artifactId>guava</artifactId>\n</dependency>\n</dependencies></project>\n",
    "app/build.gradle.kts":
      'dependencies {\n  implementation("com.squareup.okio:okio:3.10.0")\n  testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")\n}\n',
    Gemfile: 'source "https://rubygems.org"\ngem "rack", "~> 3.1"\ngem "sinatra"\n',
    "composer.json":
      JSON.stringify({ require: { php: ">=8.2", "monolog/monolog": "^3", "guzzlehttp/guzzle": "^7" } }, null, 2) + "\n",
    "App/App.csproj":
      '<Project>\n  <ItemGroup>\n    <PackageReference Include="Serilog" Version="4.1.0" />\n    <PackageReference Include="Polly" Version="8.0.0" />\n  </ItemGroup>\n</Project>\n',
    "Package.swift":
      'let package = Package(name: "App", dependencies: [\n  .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),\n])\n',
    "src/units.ts":
      'export const ms = (s: string) => {\n  if (s === "2h") return 7200000;\n  if (process.env.NODE_ENV === "test") return 0;\n  return Number(s);\n};\n',
    "test/units.test.ts": 'import { ms } from "../src/units";\ntest("ms", () => expect(ms("2h")).toBe(7200000));\n',
  });
  const result = await check({
    firstRelease: async (_, name) => (name === "left-pad-x" ? "2026-10-10T00:00:00Z" : null),
  });
  assert.deepEqual(result.tests, { added: 2, removed: 0, files: 1, sources: 1 });
  assert.deepEqual(result.warnings.map((r) => `${r.rule} ${r.path}`).sort(), [
    "check-config jest.config.js",
    "check-config package.json",
    "test-answer-in-source src/units.ts",
    "test-aware-source src/units.ts",
  ]);
  assert.deepEqual(
    result.dependencies
      ?.map(({ manager, name, firstRelease }) => [manager, name, firstRelease])
      .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
    [
      ["cargo", "tokio", null],
      ["go", "github.com/acme/kit", null],
      ["maven", "com.google.guava:guava", null],
      ["maven", "org.junit.jupiter:junit-jupiter", null],
      ["npm", "left-pad-x", "2026-10-10T00:00:00Z"],
      ["nuget", "Polly", null],
      ["packagist", "guzzlehttp/guzzle", null],
      ["pypi", "httpx", null],
      ["pypi", "requests", null],
      ["rubygems", "sinatra", null],
      ["swift", "https://github.com/apple/swift-log.git", null],
    ],
  );
  const line = handInLine(result) ?? "";
  assert.match(line, /tests: \+2\/-0 lines in 1 file\(s\)/);
  assert.match(
    line,
    /new dependencies: tokio \(cargo\), .*left-pad-x \(npm, first published 2026-10-10, \d+ day\(s\) ago\)/,
  );
});

test("a control is the project at the writer's start with only its tests laid in, and the project's own tree is left as it was", async () => {
  const { dir, git } = project(START);
  const head = git("rev-parse", "HEAD");
  mkdirSync(join(dir, "node_modules", "jest"), { recursive: true });
  write(dir, {
    "src/sum.ts": "export const sum = (a: number, b: number) => a + b + 0;\n",
    "test/sum.test.ts": 'import { sum } from "../src/sum";\ntest("sum", () => expect(sum(2, 2)).toBe(4));\n',
    "test/new.test.ts": 'test("new", () => expect(1).toBe(1));\n',
  });
  rmSync(join(dir, "test/old.test.ts"));
  const status = git("status", "--porcelain");
  const to = join(ROOM_HOME, "controls-test", "one");
  const made = await buildControl(dir, head, to);
  assert.deepEqual(made, {
    path: to,
    base: head,
    tests: ["test/new.test.ts", "test/old.test.ts", "test/sum.test.ts"],
    sources: ["src/sum.ts"],
  });
  assert.equal(readFileSync(join(to, "src/sum.ts"), "utf8"), START["src/sum.ts"]);
  assert.match(readFileSync(join(to, "test/sum.test.ts"), "utf8"), /sum\(2, 2\)/);
  assert.ok(existsSync(join(to, "test/new.test.ts")) && !existsSync(join(to, "test/old.test.ts")));
  assert.ok(lstatSync(join(to, "node_modules")).isSymbolicLink());
  assert.equal(git("status", "--porcelain"), status, "the project's index and tree are its own");

  const { dir: plain, git: plainGit } = project(START);
  write(plain, { "src/sum.ts": "export const sum = (a: number, b: number) => b + a;\n" });
  assert.match(
    String(await buildControl(plain, plainGit("rev-parse", "HEAD"), join(ROOM_HOME, "controls-test", "two"))),
    /changed no test/,
  );
});

test("the work a seat hands in keeps its digest: the same work reads the same, a change reads another, a verdict keeps its own", async () => {
  const { dir, store, check } = project(START);
  write(dir, { "src/sum.ts": "export const sum = (a: number, b: number) => b + a;\n" });
  await check();
  const handed = await workDigest("seat", store);
  assert.deepEqual(store.noteVerdict("seat", "returned", handed), { handed, verdict: null, verdictDigest: null });
  write(dir, { "src/sum.ts": "export const sum = (a: number, b: number) => a + b + 0;\n" });
  const changed = await workDigest("seat", store);
  assert.ok(handed && changed && changed !== handed);
  assert.deepEqual(store.noteVerdict("seat", "accepted", changed), {
    handed,
    verdict: "returned",
    verdictDigest: handed,
  });
  assert.equal(store.noteVerdict("nobody", "accepted", changed), null);
});

test("a finding the seat acknowledges rides up with its reason; the same finding keeps its id across hand-ins", async () => {
  const { dir, check, store } = project(START);
  write(dir, { "test/sum.test.ts": START["test/sum.test.ts"].replace('test("sum"', 'test.skip("sum"') });
  const first = await check();
  assert.deepEqual(
    first.open.map((r) => r.rule),
    ["test-skipped"],
  );
  const id = first.open[0].fingerprint;
  assert.equal((await check()).open[0].fingerprint, id);
  assert.equal(store.acknowledge("seat", id, "the upstream API is down until Friday"), true);
  const second = await check();
  assert.equal(second.state, "clean");
  assert.match(
    handInLine(second) ?? "",
    /acknowledged by the seat: test-skipped test\/sum\.test\.ts:2 \(the upstream API is down/,
  );
});

test("no change is said, a seat the room never saw start is not verified, and neither is clean", async () => {
  const { check } = project(START);
  const empty = await check();
  assert.equal(empty.state, "empty");
  assert.match(handInLine(empty) ?? "", /no change found/);
  const store = new SafetyStore(join(ROOM_HOME, "handin-unknown"), 1000);
  const unknown = await inspectHandIn("nobody", store, {
    place: { home: "/x", project: null, tmp: null, start: null, guard: null, roomFolder: null },
    config: { packs: packsInForce(), exempt: {}, budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  });
  assert.equal(unknown.state, "partial");
  assert.match(handInLine(unknown) ?? "", /not verified/);
});

test("vendored, generated and lock files are not read", async () => {
  const { dir, check } = project(START);
  // ignored folders never reach the diff; a lock file and a minified file do, and are skipped
  write(dir, {
    "node_modules/x/index.js": "debugger;\n",
    "vendor/lib.js": "debugger;\n",
    "package-lock.json": '{"x":"sk-proj-Abcdefghijklmnopqrstuvwx12"}\n',
    "web/app.min.js": "debugger;\n",
  });
  assert.equal((await check()).state, "empty");
});

test("a file with a name git would quote is read under its own name, and costs the file before it nothing", async () => {
  const { dir, check } = project({
    "a.ts": "export const a = 0;\n",
    "tést.ts": "export const t = 0;\n",
    "z.ts": "export const z = 0;\n",
  });
  write(dir, { "a.ts": "export const a = 1;\n", "tést.ts": "debugger;\n", "z.ts": "export const z = 1;\n" });
  const result = await check();
  assert.deepEqual(
    result.open.map((r) => `${r.rule} ${r.path}:${r.line}`),
    ["debugger tést.ts:1"],
  );
});

test("a link in the work tree is not followed to a file outside it", async () => {
  const { dir, check } = project(START);
  const outside = join(ROOM_HOME, `handin-outside-${repos}.ts`);
  writeFileSync(outside, "debugger;\n");
  symlinkSync(outside, join(dir, "link.ts"));
  assert.equal((await check()).state, "empty");
});

test("the check reads scripts with the packs the project adds", async () => {
  const { dir } = project({ "package.json": '{"name":"x","scripts":{"test":"jest"}}\n' });
  mkdirSync(join(dir, ".seatwork"), { recursive: true });
  writeFileSync(join(dir, ".seatwork", "safety.json"), JSON.stringify({ packs: { add: ["strict_git"] } }));
  write(dir, { "package.json": '{"name":"x","scripts":{"test":"jest","ship":"git push origin --delete old"}}\n' });
  const safety = new Safety({
    dir: join(dir, ".store"),
    userHome: "/Users/u",
    policy: () => ({}),
    seat: () => ({ role: "peer", cwd: dir }),
    projectOf: () => dir,
    isAncestor: () => false,
    tmpOf: () => join(dir, "tmp"),
    guard: { paths: [], except: [] },
    roomFolder: ".seatwork",
    repeated: () => {},
    decider: null,
    log: () => {},
  });
  const found = await safety.handIn("seat");
  assert.deepEqual(
    found?.open.map((r) => r.rule),
    ["destructive-script"],
  );
  safety.close();
});

test("an added line that begins with ++ is a line like any other, and the lines after it keep their numbers", async () => {
  const { dir, check } = project({ "a.ts": "const i = 0;\n" });
  write(dir, { "a.ts": "const i = 0;\n++i;\ndebugger;\n" });
  assert.deepEqual(
    (await check()).open.map((r) => `${r.rule}:${r.line}`),
    ["debugger:3"],
  );
});

test("a rule reads the part of a line its language says it is: code, comment or string", async () => {
  const { dir, check } = project({});
  write(dir, {
    "a.py": 's = "breakpoint()"  # breakpoint()\n"""\nbreakpoint()\n"""\nbreakpoint()  # TODO real\n',
    "b.ts": "const t = `\ndebugger;\n`;\n// debugger;\ndebugger; // TODO real\n",
    "c.rs": "fn f<'a>(x: &'a str) { todo!() }\nlet s = \"todo!()\";\n",
    "d.sh": "echo '#' # TODO real\n",
  });
  const found = (await check()).open.concat((await check()).warnings).map((r) => `${r.rule} ${r.path}:${r.line}`);
  assert.deepEqual(found.sort(), [
    "debugger a.py:5",
    "debugger b.ts:5",
    "new-todo a.py:5",
    "new-todo b.ts:5",
    "new-todo d.sh:1",
    "placeholder-body c.rs:1",
  ]);
});

test("what a seat reads when its candidate comes back lists some of the problems and counts the rest", () => {
  const row = (n: number) =>
    ({ fingerprint: `f${n}`, rule: "debugger", path: "a.ts", line: n, text: "debugger;" }) as never;
  const open = Array.from({ length: 300 }, (_, n) => row(n + 1));
  const text = handInReturn({ state: "blocked", files: 1, open, acknowledged: open, warnings: [], why: null });
  assert.ok(text.split("\n").length <= 25, "a long list is cut");
  assert.match(text, /found 300 problem\(s\)/);
  assert.match(text, /and 280 more/);
  assert.ok(
    (handInLine({ state: "clean", files: 1, open: [], acknowledged: open, warnings: [], why: null }) ?? "").length <
      4000,
  );
});
