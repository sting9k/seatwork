import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { handInLine, handInReturn, inspectHandIn, workDigest } from "../server/safety/handin";
import { changedSince, snapshot } from "../server/safety/council/git";
import { buildControl } from "../server/safety/control";
import { SafetyStore } from "../server/safety/store";
import { claudeRc, machineTools } from "../server/safety/system";
import { git, repoWith, writeFiles } from "./support/git";

shipSql();

let repos = 0;
/** A git repository with one commit of a small project, and a store that knows a seat started in `start`, a folder of it. */
function project(files: Record<string, string>, start = "") {
  const dir = repoWith(join(ROOM_HOME, `handin-${(repos += 1)}`), {
    ...files,
    ".gitignore": ".store/\nnode_modules/\ndist/\n",
  });
  const store = new SafetyStore(join(dir, ".store"), 1000);
  store.noteStart("seat", join(dir, start), git(dir, "rev-parse", "HEAD"));
  const gate = {
    place: { home: "/Users/u", project: dir, tmp: null, start: join(dir, start), guard: null, roomFolder: ".seatwork" },
    config: { budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  };
  return { dir, store, git: (...args: string[]) => git(dir, ...args), check: () => inspectHandIn("seat", store, gate) };
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
  writeFiles(dir, {
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
  writeFiles(dir, {
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
  writeFiles(dir, {
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
  const result = await check();
  assert.deepEqual(result.tests, { added: 2, removed: 0, files: 1, sources: 1 });
  assert.deepEqual(result.warnings.map((r) => `${r.rule} ${r.path}`).sort(), [
    "check-config jest.config.js",
    "check-config package.json",
    "test-answer-in-source src/units.ts",
    "test-aware-source src/units.ts",
  ]);
  assert.deepEqual(
    result.dependencies
      ?.map(({ manager, name }) => [manager, name])
      .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
    [
      ["cargo", "tokio"],
      ["go", "github.com/acme/kit"],
      ["maven", "com.google.guava:guava"],
      ["maven", "org.junit.jupiter:junit-jupiter"],
      ["npm", "left-pad-x"],
      ["nuget", "Polly"],
      ["packagist", "guzzlehttp/guzzle"],
      ["pypi", "httpx"],
      ["pypi", "requests"],
      ["rubygems", "sinatra"],
      ["swift", "https://github.com/apple/swift-log.git"],
    ],
  );
  const line = handInLine(result) ?? "";
  assert.match(line, /tests: \+2\/-0 lines in 1 file\(s\)/);
  assert.match(line, /new dependencies: tokio \(cargo\), .*left-pad-x \(npm\)/);
});

test("a package added to NuGet's central package file is a new dependency", async () => {
  const props = (...names: string[]) =>
    `<Project>\n  <ItemGroup>\n${names.map((name) => `    <PackageVersion Include="${name}" Version="1.0.0" />\n`).join("")}  </ItemGroup>\n</Project>\n`;
  const { dir, check } = project({ "Directory.Packages.props": props("Serilog") });
  writeFiles(dir, { "Directory.Packages.props": props("Serilog", "Dapper") });
  assert.deepEqual(
    (await check()).dependencies?.map(({ name }) => name),
    ["Dapper"],
  );
});

test("a control is the project at the writer's start with only its tests laid in, and the project's own tree is left as it was", async () => {
  const { dir, git } = project(START);
  const head = git("rev-parse", "HEAD");
  mkdirSync(join(dir, "node_modules", "jest"), { recursive: true });
  writeFiles(dir, {
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
  writeFiles(plain, { "src/sum.ts": "export const sum = (a: number, b: number) => b + a;\n" });
  assert.match(
    String(await buildControl(plain, plainGit("rev-parse", "HEAD"), join(ROOM_HOME, "controls-test", "two"))),
    /changed no test/,
  );
});

test("a control of a writer that started in a folder of its repository is the whole repository, run from that folder", async () => {
  const { dir, git } = project({
    "app/src/sum.ts": START["src/sum.ts"],
    "app/test/sum.test.ts": START["test/sum.test.ts"],
  });
  const head = git("rev-parse", "HEAD");
  mkdirSync(join(dir, "app", "node_modules", "jest"), { recursive: true });
  writeFiles(dir, { "app/test/new.test.ts": 'test("new", () => expect(1).toBe(1));\n' });
  const to = join(ROOM_HOME, "controls-test", "below");
  const made = await buildControl(join(dir, "app"), head, to);
  assert.deepEqual(made, { path: join(to, "app"), base: head, tests: ["app/test/new.test.ts"], sources: [] });
  assert.ok(existsSync(join(to, "app/src/sum.ts")) && existsSync(join(to, "app/test/new.test.ts")));
  assert.ok(lstatSync(join(to, "app", "node_modules")).isSymbolicLink());
});

test("the room's own folder, and work another seat left in the tree, are no change of a seat's turn", async () => {
  const { dir, check } = project(START);
  writeFiles(dir, {
    ".seatwork/mission.md": "the mission\n",
    ".seatwork/room.json": "{}\n",
    "src/new.ts": "export const n = 1;\n",
  });
  assert.equal((await check()).files, 1);
  const found = await snapshot(dir);
  writeFiles(dir, { ".seatwork/law.md": "the law\n" });
  assert.deepEqual(await changedSince(found!), [], "what was there before the turn is no change of it");
  writeFiles(dir, { "src/new.ts": "export const n = 2;\n", "src/other.ts": "export const o = 1;\n" });
  assert.deepEqual((await changedSince(found!))?.sort(), ["src/new.ts", "src/other.ts"], "what the turn changed is");
});

test("a hand-in that goes up with blocking findings, as when the check only warns, names them to the seat above", () => {
  const row = (rule: string, line: number) => ({
    seat: "s",
    fingerprint: `${rule}${line}`,
    rule,
    severity: "block" as const,
    path: "src/a.ts",
    line,
    text: "",
    first_at: "",
    last_at: "",
    ack: null,
    acked_at: null,
  });
  const line = handInLine({
    state: "blocked",
    files: 2,
    open: [row("debugger", 3), row("focused-test", 9)],
    acknowledged: [],
    warnings: [],
    why: null,
    left: { block: 4, warn: 0 },
  });
  assert.match(
    line ?? "",
    /2 blocking finding\(s\) not acknowledged and 4 more left out: debugger src\/a\.ts:3; focused-test src\/a\.ts:9/,
  );
});

test("the work a seat hands in keeps its digest: the same work reads the same, a change reads another, a verdict keeps its own", async () => {
  const { dir, store, check } = project(START);
  writeFiles(dir, { "src/sum.ts": "export const sum = (a: number, b: number) => b + a;\n" });
  await check();
  const handed = await workDigest("seat", store);
  assert.deepEqual(store.noteVerdict("seat", "returned", handed), { handed, verdict: null, verdictDigest: null });
  writeFiles(dir, { "src/sum.ts": "export const sum = (a: number, b: number) => a + b + 0;\n" });
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
  writeFiles(dir, { "test/sum.test.ts": START["test/sum.test.ts"].replace('test("sum"', 'test.skip("sum"') });
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
    config: { budgetMs: 1000, maxBytes: 65536 },
    tools: machineTools(() => null),
  });
  assert.equal(unknown.state, "partial");
  assert.match(handInLine(unknown) ?? "", /not verified/);
});

test("vendored, generated and lock files are not read", async () => {
  const { dir, check } = project(START);
  // ignored folders never reach the diff; a lock file and a minified file do, and are skipped
  writeFiles(dir, {
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
  writeFiles(dir, { "a.ts": "export const a = 1;\n", "tést.ts": "debugger;\n", "z.ts": "export const z = 1;\n" });
  const result = await check();
  assert.deepEqual(
    result.open.map((r) => `${r.rule} ${r.path}:${r.line}`),
    ["debugger tést.ts:1"],
  );
});

test("a seat started below the repository root is read at the paths git names: tracked, new and outside its folder", async () => {
  const { dir, check } = project(
    {
      "app/a.ts": "export const a = 1;\n",
      "app/src/sum.ts": "export const sum = 1;\n",
      "app/test/sum.test.ts": 'import { sum } from "../src/sum";\ntest("sum", () => expect(sum).toBe(1));\n',
      "app/test/other.test.ts": 'import { sum } from "../src/sum";\ntest("o", () => expect(sum).toBe(1));\n',
      "app/package.json": '{"name":"x","scripts":{"test":"jest"}}\n',
      "lib/l.ts": "export const l = 1;\n",
    },
    "app",
  );
  writeFiles(dir, {
    "app/a.ts": "export const a = 1;\nconst x = 2; // TODO real\n",
    "app/src/sum.ts": "export const sum = 2;\n",
    "app/test/other.test.ts": 'import { sum } from "../src/sum";\ntest("o", () => expect(sum).toBe(2));\n',
    "app/package.json": '{"name":"x","scripts":{"test":"jest","clean":"rm -rf ~"},"dependencies":{"left-pad-x":"1"}}\n',
    "app/b.ts": "const y = 3; // TODO new\n",
    "lib/l.ts": "export const l = 1;\ndebugger;\n",
  });
  const result = await check();
  assert.deepEqual(
    {
      found: result.open
        .concat(result.warnings)
        .map((r) => `${r.rule} ${r.path}:${r.line}`)
        .sort(),
      dependencies: result.dependencies?.map(({ name }) => name),
      related: result.related,
    },
    {
      found: [
        "debugger lib/l.ts:2",
        "destructive-script app/package.json:1",
        "new-todo app/a.ts:2",
        "new-todo app/b.ts:1",
      ],
      dependencies: ["left-pad-x"],
      related: ["app/test/sum.test.ts"],
    },
  );
});

test("a line that runs on another machine, in CI or a container, counts only for what it does to state kept off it", async () => {
  const { dir, check } = project(START);
  writeFiles(dir, {
    Dockerfile: "FROM node:22\nRUN npm install -g typescript\nRUN rm -rf /\n",
    ".github/workflows/ci.yml":
      "jobs:\n  test:\n    steps:\n      - run: git config --global user.name ci\n      - run: npm publish\n",
    "scripts/setup.sh": "npm install -g typescript\n",
  });
  const result = await check();
  assert.deepEqual(
    result.open
      .concat(result.warnings)
      .filter((r) => r.rule === "destructive-script")
      .map((r) => `${r.path}:${r.line}`)
      .sort(),
    [".github/workflows/ci.yml:5", "scripts/setup.sh:1"],
  );
});

test("a script that publishes, deploys or installs goes up as a warning; one that harms this machine sends the candidate back", async () => {
  const { dir, check } = project(START);
  writeFiles(dir, {
    "package.json":
      '{"name":"x","scripts":{"test":"jest","release":"npm publish","down":"terraform destroy","tools":"npm i -g tsx","wipe":"rm -rf ~"}}\n',
  });
  const result = await check();
  const scripts = (found: typeof result.open) =>
    found
      .filter((r) => r.rule === "destructive-script")
      .map((r) => r.text.split(" :: ")[0])
      .sort();
  assert.deepEqual(scripts(result.open), ["rm -rf ~"]);
  assert.deepEqual(scripts(result.warnings), ["npm i -g tsx", "npm publish", "terraform destroy"]);
});

test("a link in the work tree is not followed to a file outside it", async () => {
  const { dir, check } = project(START);
  const outside = join(ROOM_HOME, `handin-outside-${repos}.ts`);
  writeFileSync(outside, "debugger;\n");
  symlinkSync(outside, join(dir, "link.ts"));
  assert.equal((await check()).state, "empty");
});

/** The paths under `dir` that `work` passes to `fs[call]`, in order. */
async function pathsAsked(call: "readFileSync" | "readdirSync", dir: string, work: () => unknown): Promise<string[]> {
  const asked: string[] = [];
  const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = module[call];
  module[call] = (path, ...rest) => {
    if (String(path).startsWith(dir)) asked.push(String(path));
    return real(path, ...rest);
  };
  try {
    await work();
  } finally {
    module[call] = real;
  }
  return asked;
}

test("a hand-in reads each changed file once, a manifest and a script included", async () => {
  const { dir, check } = project({
    ...START,
    "package.json": JSON.stringify({ scripts: { test: "jest" }, dependencies: { a: "1" } }) + "\n",
  });
  writeFiles(dir, {
    "src/sum.ts": "export const sum = (a: number, b: number) => b + a;\n",
    "src/new.ts": "export const fresh = 1;\n",
    "package.json": JSON.stringify({ scripts: { test: "jest" }, dependencies: { a: "1", b: "2" } }) + "\n",
  });
  const read = await pathsAsked("readFileSync", dir, check);
  assert.deepEqual(read.sort(), [join(dir, "package.json"), join(dir, "src/new.ts"), join(dir, "src/sum.ts")]);
});

test("a hand-in with more new files than the check reads is not verified, and none of them is read", async () => {
  const { dir, check } = project(START);
  writeFiles(dir, Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`gen/file${i}.txt`, "x\n"])));
  const read = await pathsAsked("readFileSync", dir, async () => {
    const result = await check();
    assert.equal(result.state, "partial");
    assert.match(handInLine(result) ?? "", /more than 2000 files changed; not verified/);
  });
  assert.equal(read.length, 0, "a check that cannot hold the files does not read them first");
});

test("one pass keeps a bounded number of findings and says how many it left out; blocking ones left out are not read as clean", async () => {
  const { dir, check, store } = project(START);
  writeFiles(dir, { "src/noisy.ts": "debugger;\n".repeat(5000), "src/notes.ts": "// TODO later\n".repeat(5000) });
  const first = await check();
  const [kept, noted] = [first.open.length, first.warnings.length];
  assert.equal(first.state, "blocked");
  assert.ok(kept < 5000 && noted < 5000, `${kept} blocking and ${noted} notes were kept`);
  assert.deepEqual(first.left, { block: 5000 - kept, warn: 5000 - noted });
  assert.match(handInReturn(first), /and 4980 more/);
  assert.match(handInLine(first) ?? "", new RegExp(`${noted} note\\(s\\) and ${5000 - noted} more left out`));

  for (const row of first.open) store.acknowledge("seat", row.fingerprint, "kept on purpose");
  const second = await check();
  assert.equal(second.state, "partial");
  assert.match(handInLine(second) ?? "", new RegExp(`incomplete: ${5000 - kept} blocking finding\\(s\\) .*left out`));
});

test("the shell snapshot folder is listed once while it stands, and again when a snapshot comes, goes or changes", async () => {
  const dir = join(ROOM_HOME, "snapshots-1");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ago = (ms: number) => new Date(Date.now() - ms);
  const snapshot = (name: string, alias: string, age: number) => {
    writeFileSync(join(dir, name), `alias -- ${alias}='ls'\n`);
    utimesSync(join(dir, name), ago(age), ago(age));
  };
  const newest: string[][] = [];
  const listed = await pathsAsked("readdirSync", dir, () => {
    const look = () => newest.push([...(claudeRc(dir)?.aliases.keys() ?? [])]);
    snapshot("snapshot-zsh-1.sh", "old", 120_000);
    snapshot("snapshot-zsh-2.sh", "one", 60_000);
    utimesSync(dir, ago(60_000), ago(60_000));
    look();
    look();
    snapshot("snapshot-zsh-2.sh", "two", 30_000);
    look();
    snapshot("snapshot-zsh-3.sh", "three", 0);
    look();
    rmSync(join(dir, "snapshot-zsh-3.sh"));
    utimesSync(dir, ago(60_000), ago(60_000));
    look();
  });
  assert.deepEqual(newest, [["one"], ["one"], ["two"], ["three"], ["two"]]);
  assert.equal(listed.length, 4, "the second look at a folder that stood listed nothing");
});

test("an added line that begins with ++ is a line like any other, and the lines after it keep their numbers", async () => {
  const { dir, check } = project({ "a.ts": "const i = 0;\n" });
  writeFiles(dir, { "a.ts": "const i = 0;\n++i;\ndebugger;\n" });
  assert.deepEqual(
    (await check()).open.map((r) => `${r.rule}:${r.line}`),
    ["debugger:3"],
  );
});

test("a rule reads the part of a line its language says it is: code, comment or string", async () => {
  const { dir, check } = project({});
  writeFiles(dir, {
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
  const kept = open.map((one: object) => ({ ...one, ack: "kept on purpose" })) as never[];
  const text = handInReturn({ state: "blocked", files: 1, open, acknowledged: [], warnings: [], why: null });
  assert.ok(text.split("\n").length <= 25, "a long list is cut");
  assert.match(text, /found 300 problem\(s\)/);
  assert.match(text, /and 280 more/);
  assert.ok(
    (handInLine({ state: "clean", files: 1, open: [], acknowledged: kept, warnings: [], why: null }) ?? "").length <
      4000,
  );
});
