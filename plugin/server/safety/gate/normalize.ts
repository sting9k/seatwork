import { literal, type Assignment, type Script, type Simple, type Word } from "./shell";

/** Reads the wrappers (sudo, env, timeout, npx) off a simple command to find the program it runs. */

/** The program a simple command runs: its lower-case base name (null when known only at run time), and what a wrapper adds to it. */
export interface Invocation {
  name: string | null;
  command: Word | null;
  args: Word[];
  wrappers: string[];
  assigns: Assignment[];
  inline: Word[];
  chdir: Word | null;
  unread: string | null;
  query: boolean;
}

/** How a wrapper's options read: flags with and without a value, and those that query, run a string, change folder. */
interface Spec {
  short?: string;
  shortValued?: string;
  long?: string[];
  longValued?: string[];
  query?: string;
  queryLong?: string[];
  inlineShort?: string;
  inlineLong?: string[];
  chdirShort?: string;
  chdirLong?: string[];
  assigns?: boolean;
  lone?: RegExp;
  positionals?: number;
  number?: boolean;
}

const WRAPPERS: Record<string, Spec> = {
  sudo: {
    short: "EHnkKSsbiPAB",
    shortValued: "ughpCrUDtaT",
    query: "lvVe",
    chdirShort: "D",
    long: ["preserve-env", "login", "shell", "non-interactive", "stdin", "background", "reset-timestamp"],
    longValued: [
      "user",
      "group",
      "host",
      "prompt",
      "close-from",
      "role",
      "other-user",
      "chdir",
      "type",
      "auth-type",
      "chroot",
    ],
    chdirLong: ["chdir"],
    queryLong: ["list", "validate", "version", "edit", "help"],
  },
  doas: { short: "ns", shortValued: "ua", query: "C" },
  env: {
    short: "i0v",
    shortValued: "uPCa",
    long: [
      "ignore-environment",
      "null",
      "debug",
      "ignore-signal",
      "default-signal",
      "block-signal",
      "list-signal-handling",
    ],
    longValued: ["unset", "chdir", "argv0"],
    inlineShort: "S",
    inlineLong: ["split-string"],
    chdirShort: "C",
    chdirLong: ["chdir"],
    assigns: true,
    lone: /^-$/,
  },
  command: { short: "p", query: "vV" },
  builtin: {},
  exec: { short: "cl", shortValued: "a" },
  nohup: {},
  time: {
    short: "apqv",
    shortValued: "fo",
    long: ["append", "portability", "quiet", "verbose"],
    longValued: ["format", "output"],
  },
  nice: { shortValued: "n", longValued: ["adjustment"], number: true },
  ionice: {
    short: "t",
    shortValued: "cn",
    long: ["ignore"],
    longValued: ["class", "classdata"],
    query: "pPu",
    queryLong: ["pid", "pgid", "uid"],
  },
  setsid: { short: "cfw", long: ["ctty", "fork", "wait"] },
  timeout: {
    short: "fpv",
    shortValued: "ks",
    long: ["foreground", "preserve-status", "verbose"],
    longValued: ["kill-after", "signal"],
    positionals: 1,
  },
  stdbuf: { shortValued: "ioe", longValued: ["input", "output", "error"] },
  chrt: { short: "obifrdeRav", shortValued: "TPD", query: "mp", queryLong: ["max", "pid"], number: true },
  caffeinate: { short: "dimsu", shortValued: "tw" },
  chronic: { short: "ev" },
  unbuffer: { short: "p" },
  nocorrect: {},
  noglob: {},
  pkexec: { long: ["disable-internal-agent", "keep-cwd"], longValued: ["user"] },
  xcrun: {
    short: "rvnl",
    longValued: ["sdk", "toolchain"],
    long: ["run", "verbose", "no-cache", "log"],
    query: "f",
    queryLong: ["find", "show-sdk-path", "show-sdk-version", "show-sdk-platform-path"],
  },
  arch: { shortValued: "ed", short: "c", lone: /^-(arm64e?|x86_64h?|i386|ppc|32|64)$/ },
};

/** A package runner: its subcommands, the options that take a value before one, and how its own options read. */
interface Runner {
  sub?: string[];
  before?: { short?: string; long?: string[] };
  spec: Spec;
}

const RUNNERS: Record<string, Runner> = {
  npx: {
    spec: {
      short: "yq",
      shortValued: "p",
      long: ["yes", "no", "quiet", "no-install", "ignore-existing"],
      longValued: ["package", "call", "shell"],
      inlineShort: "c",
      inlineLong: ["call"],
    },
  },
  bunx: { spec: { short: "b", long: ["bun"], longValued: ["package"] } },
  uvx: {
    spec: {
      short: "q",
      long: ["quiet", "isolated", "no-cache", "offline"],
      longValued: ["from", "with", "python", "index", "index-url"],
    },
  },
  npm: {
    sub: ["exec", "x"],
    before: { short: "w", long: ["prefix", "workspace", "userconfig", "registry", "cache", "loglevel"] },
    spec: {
      short: "yq",
      long: ["yes", "no", "workspaces"],
      longValued: ["package", "workspace", "call"],
      inlineShort: "c",
      inlineLong: ["call"],
    },
  },
  pnpm: {
    sub: ["dlx", "exec"],
    before: { short: "CF", long: ["dir", "filter", "filter-prod", "reporter", "loglevel", "config"] },
    spec: { long: ["recursive", "parallel", "shell-mode"], longValued: ["package", "filter"], inlineShort: "c" },
  },
  yarn: {
    sub: ["dlx", "exec"],
    before: { long: ["cwd"] },
    spec: { short: "q", long: ["quiet"], longValued: ["package"] },
  },
  bun: { sub: ["x"], before: { long: ["cwd"] }, spec: { long: ["bun"] } },
  uv: {
    sub: ["run"],
    spec: {
      short: "q",
      long: ["quiet", "isolated", "no-project", "no-sync", "frozen", "locked", "offline"],
      longValued: ["with", "python", "project", "directory", "package", "env-file", "group", "extra"],
      chdirLong: ["directory"],
    },
  },
  poetry: { sub: ["run"], spec: { short: "q", long: ["quiet"], longValued: ["directory"], chdirLong: ["directory"] } },
  pipenv: { sub: ["run"], spec: {} },
  pipx: { sub: ["run"], spec: { long: ["no-cache", "verbose"], longValued: ["spec", "python"] } },
  bundle: { sub: ["exec"], spec: {} },
  rbenv: { sub: ["exec"], spec: {} },
  pyenv: { sub: ["exec"], spec: {} },
  asdf: { sub: ["exec"], spec: {} },
  direnv: { sub: ["exec"], spec: { positionals: 1 } },
  op: { sub: ["run"], spec: { long: ["no-masking"], longValued: ["env-file", "account"] } },
  doppler: { sub: ["run"], spec: { longValued: ["project", "config", "token"] } },
  infisical: { sub: ["run"], spec: { longValued: ["env", "projectId", "path", "token"] } },
  "aws-vault": { sub: ["exec"], spec: { positionals: 1, long: ["no-session"], longValued: ["duration", "region"] } },
  mise: {
    sub: ["exec", "x"],
    spec: {
      short: "yq",
      shortValued: "CEjP",
      long: ["yes", "quiet", "raw", "fresh-env", "no-prepare"],
      longValued: ["cd", "env", "jobs", "profile"],
      inlineShort: "c",
      inlineLong: ["command"],
      chdirShort: "C",
      chdirLong: ["cd"],
    },
  },
};

const PACKAGE_PROGRAMS: Record<string, string> = { "@getpaseo/cli": "paseo" };

const MAX_WRAPPERS = 32;

/** A table's entry for a name the seat typed; a name like `constructor` finds nothing. */
const own = <T>(table: Record<string, T>, name: string | null): T | undefined =>
  name !== null && Object.hasOwn(table, name) ? table[name] : undefined;

/** The last path component of a command word, lower case. */
export const baseName = (text: string): string => text.slice(text.lastIndexOf("/") + 1).toLowerCase();

/** Where a runner's subcommand stands in its words, past the options before it; 0 for a runner with none, -1 when it is not there. */
function subAt(words: Word[], runner: Runner): number {
  const before = runner.before;
  const longValued = new Set([...(runner.spec.longValued ?? []), ...(before?.long ?? [])]);
  const shortValued = `${runner.spec.shortValued ?? ""}${before?.short ?? ""}`;
  for (let i = 1; i < words.length; i += 1) {
    const text = literal(words[i]);
    if (text === null) return -1;
    if (runner.sub!.includes(text.toLowerCase())) return i;
    if (!text.startsWith("-")) return -1;
    const valued = text.startsWith("--")
      ? longValued.has(text.slice(2))
      : text.length === 2 && shortValued.includes(text[1]);
    if (valued) i += 1;
  }
  return -1;
}

/** The program a simple command runs, with wrappers and package runners (`npx tool`, `uv run cmd`) read through. */
export function invocationOf(simple: Simple): Invocation {
  const out: Invocation = {
    name: null,
    command: null,
    args: [],
    wrappers: [],
    assigns: [...simple.assigns],
    inline: [],
    chdir: null,
    unread: null,
    query: false,
  };
  let words = simple.words;
  for (let round = 0; round <= MAX_WRAPPERS && words.length; round += 1) {
    const head = literal(words[0]);
    const name = head === null ? null : baseName(head);
    if (round === MAX_WRAPPERS) {
      out.unread = "too many wrappers";
      break;
    }
    if (name === "busybox" && words.length > 1) {
      out.wrappers.push(name);
      words = words.slice(1);
      continue;
    }
    const runner = own(RUNNERS, name);
    if (runner) {
      const at = runner.sub ? subAt(words, runner) : 0;
      if (at >= 0) {
        const rest = readOptions(words.slice(at + 1), runner.spec, out);
        if (rest === null) break;
        out.wrappers.push(runner.sub ? `${name} ${literal(words[at])!.toLowerCase()}` : name!);
        words = rest;
        if (!words.length) return finish(out, words);
        continue;
      }
    }
    const spec = own(WRAPPERS, name);
    if (!spec || words.length < 2) break;
    const rest = readOptions(words.slice(1), spec, out);
    if (rest === null) break;
    out.wrappers.push(name!);
    words = rest;
    if (!words.length) return finish(out, words);
  }
  return finish(out, words);
}

/** The program and arguments from the words left once the wrappers are read. */
function finish(out: Invocation, words: Word[]): Invocation {
  if (out.query) return out;
  out.command = words[0] ?? null;
  out.args = words.slice(1);
  const head = out.command ? literal(out.command) : null;
  const viaRunner = out.wrappers.some((wrapper) => own(RUNNERS, wrapper.split(" ")[0]));
  out.name = head === null ? null : baseName(viaRunner ? packageProgram(head) : head);
  return out;
}

/** The program a package runner starts for a package spec: `paseo@1.2` is `paseo`, and `@getpaseo/cli` is the `paseo` it ships. */
function packageProgram(spec: string): string {
  const bare = spec.replace(/^(@?[^@/]+(?:\/[^@/]+)?)@[^/]*$/, "$1");
  return own(PACKAGE_PROGRAMS, bare) ?? bare;
}

/** A wrapper's options; the words left start with its program. Null for an unknown option. */
function readOptions(words: Word[], spec: Spec, out: Invocation): Word[] | null {
  let i = 0;
  let positionals = spec.positionals ?? 0;
  const unread = (why: string): null => {
    out.unread = why;
    return null;
  };
  while (i < words.length) {
    const text = literal(words[i]);
    if (text === null) {
      if (positionals === 0) return unread("an option only known at run time");
      positionals -= 1;
      i += 1;
      continue;
    }
    if (text === "--") {
      i += 1;
      break;
    }
    if (spec.assigns && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
      const name = text.slice(0, text.indexOf("="));
      out.assigns.push({
        name,
        append: false,
        indexed: false,
        value: valueWord(words[i], name.length + 1),
        items: null,
      });
      i += 1;
      continue;
    }
    if (spec.lone?.test(text)) {
      i += 1;
      continue;
    }
    if (spec.number && /^-[+-]?\d+$/.test(text)) {
      i += 1;
      continue;
    }
    if (text.startsWith("--") && text.length > 2) {
      const [flag, value] = splitLong(text.slice(2));
      if (spec.queryLong?.includes(flag)) {
        out.query = true;
        return [];
      }
      if (spec.inlineLong?.includes(flag)) {
        const word = value === null ? words[i + 1] : valueWord(words[i], text.length - value.length);
        if (!word) return unread(`--${flag} without its value`);
        out.inline.push(word);
        i += value === null ? 2 : 1;
        continue;
      }
      if (spec.longValued?.includes(flag)) {
        const word = value === null ? words[i + 1] : valueWord(words[i], text.length - value.length);
        if (!word) return unread(`--${flag} without its value`);
        if (spec.chdirLong?.includes(flag)) out.chdir = word;
        i += value === null ? 2 : 1;
        continue;
      }
      if (spec.long?.includes(flag) && value === null) {
        i += 1;
        continue;
      }
      return unread(`an option the room does not know: ${text}`);
    }
    if (text.startsWith("-") && text.length > 1) {
      let j = 1;
      let next = i + 1;
      while (j < text.length) {
        const c = text[j];
        if (spec.query?.includes(c)) {
          out.query = true;
          return [];
        }
        if (spec.short?.includes(c)) {
          j += 1;
          continue;
        }
        const valued = spec.shortValued?.includes(c) || spec.inlineShort?.includes(c);
        if (!valued) return unread(`an option the room does not know: -${c}`);
        const glued = text.slice(j + 1);
        const word = glued ? valueWord(words[i], j + 1) : words[next];
        if (!word) return unread(`-${c} without its value`);
        if (spec.inlineShort?.includes(c)) out.inline.push(word);
        if (spec.chdirShort?.includes(c)) out.chdir = word;
        if (!glued) next += 1;
        j = text.length;
      }
      i = next;
      continue;
    }
    if (positionals > 0) {
      positionals -= 1;
      i += 1;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function splitLong(text: string): [string, string | null] {
  const eq = text.indexOf("=");
  return eq < 0 ? [text, null] : [text.slice(0, eq), text.slice(eq + 1)];
}

/** The part of a word after its first `cut` characters, as a word of its own. */
export function valueWord(word: Word, cut: number): Word {
  const parts = [];
  let skip = cut;
  for (const part of word.parts) {
    if (skip > 0 && part.kind === "text") {
      if (part.text.length <= skip) {
        skip -= part.text.length;
        continue;
      }
      parts.push({ ...part, text: part.text.slice(skip) });
      skip = 0;
      continue;
    }
    skip = 0;
    parts.push(part);
  }
  return { raw: word.raw.slice(Math.min(cut, word.raw.length)), start: word.start + cut, end: word.end, parts };
}

/** The program names that the simple commands of a script call, in order. */
export function programNames(script: Script): string[] {
  const out: string[] = [];
  for (const sequence of script)
    for (const pipeline of sequence.pipelines)
      for (const command of pipeline.commands)
        if (command.kind === "simple") out.push(invocationOf(command).name ?? "");
  return out;
}
