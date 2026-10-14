/** Scripts given to an interpreter (`python -c`, a heredoc): their shell lines and deletes. */

export type Language = "python" | "javascript" | "ruby" | "perl" | "php" | "lua";

export interface Embedded {
  shell: string[];
  deletes: { path: string; recursive: boolean; how: string }[];
  writes: { path: string; append: boolean; how: string }[];
  /** a call that runs a shell line built at run time */
  dynamicExec: string[];
}

/** shell: a backtick or qx/%x literal, which runs its text; template: a JS template literal. */
type Token = { kind: "word" | "string" | "punct" | "shell" | "template"; text: string; dynamic?: boolean };

const INTERPRETERS: [RegExp, Language][] = [
  [/^(python|pypy)(\d+(\.\d+)*)?$/, "python"],
  [/^(node|nodejs)(\d+)?$|^bun$|^deno$/, "javascript"],
  [/^(ruby|irb)(\d+(\.\d+)*)?$/, "ruby"],
  [/^perl(\d+(\.\d+)*)?$/, "perl"],
  [/^php(\d+(\.\d+)*)?$/, "php"],
  [/^lua(jit|\d+(\.\d+)*)?$/, "lua"],
];

export function languageOf(name: string): Language | null {
  return INTERPRETERS.find(([test]) => test.test(name))?.[1] ?? null;
}

/** The flags that hand an interpreter its program inline. */
export const INLINE_FLAGS: Record<Language, string[]> = {
  python: ["-c"],
  javascript: ["-e", "-p", "--eval", "--print"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  php: ["-r", "--run"],
  lua: ["-e"],
};

const EXEC: Record<Language, Set<string>> = {
  python: new Set([
    "system",
    "popen",
    "run",
    "call",
    "Popen",
    "check_call",
    "check_output",
    "getoutput",
    "getstatusoutput",
    "spawn",
    "execl",
    "execlp",
    "execv",
    "execvp",
    "execvpe",
  ]),
  javascript: new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "Command"]),
  ruby: new Set([
    "system",
    "exec",
    "spawn",
    "popen",
    "capture2",
    "capture2e",
    "capture3",
    "popen2",
    "popen3",
    "pipeline",
  ]),
  perl: new Set(["system", "exec"]),
  php: new Set(["exec", "shell_exec", "system", "passthru", "popen", "proc_open"]),
  lua: new Set(["execute", "popen"]),
};

const RECURSIVE_DELETE: Record<Language, Set<string>> = {
  python: new Set(["rmtree"]),
  javascript: new Set(["rmSync", "rm", "rmdirSync", "rmdir", "remove", "removeSync"]),
  ruby: new Set(["rm_rf", "rm_r", "remove_dir", "remove_entry", "remove_entry_secure", "rmtree"]),
  perl: new Set(["rmtree", "remove_tree"]),
  php: new Set([]),
  lua: new Set([]),
};

const FILE_DELETE: Record<Language, Set<string>> = {
  python: new Set(["remove", "unlink", "rmdir"]),
  javascript: new Set(["unlinkSync", "unlink"]),
  ruby: new Set(["delete", "unlink", "rm", "rm_f"]),
  perl: new Set(["unlink"]),
  php: new Set(["unlink", "rmdir"]),
  lua: new Set(["remove"]),
};

const WRITE: Record<Language, Set<string>> = {
  python: new Set(["open", "write_text", "write_bytes"]),
  javascript: new Set(["writeFileSync", "writeFile", "appendFileSync", "appendFile", "createWriteStream"]),
  ruby: new Set(["write", "binwrite"]),
  perl: new Set([]),
  php: new Set(["file_put_contents"]),
  lua: new Set([]),
};

const MAX_SOURCE = 256 * 1024;

/** Reads a script for calls that run shell lines, delete trees or write files with literals. */
export function scanEmbedded(language: Language, source: string): Embedded {
  const out: Embedded = { shell: [], deletes: [], writes: [], dynamicExec: [] };
  if (source.length > MAX_SOURCE) return out;
  const tokens = tokenize(language, source);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.kind === "shell") {
      if (t.dynamic) out.dynamicExec.push("a shell line built at run time");
      else out.shell.push(t.text);
      continue;
    }
    if (t.kind !== "word") continue;
    const method = t.text.split(".").pop()!;
    const open = tokens[i + 1];
    if (open?.kind === "template" && /^(\$|Bun\.\$|sh|zx)$/.test(t.text)) {
      if (open.dynamic) out.dynamicExec.push(t.text);
      else out.shell.push(open.text);
      continue;
    }
    if (open?.text !== "(") continue;
    const args = argumentsAt(tokens, i + 2);
    const first = args[0];
    if (EXEC[language].has(method) && execOwner(language, t.text, method)) {
      if (!first) continue;
      if (first.kind === "string" && !first.dynamic) {
        const rest = args.slice(1).filter((a) => a.kind === "list" || (a.kind === "string" && !a.dynamic));
        const argv = rest.find((a) => a.kind === "list");
        if (
          (method === "execFile" ||
            method === "execFileSync" ||
            method === "spawn" ||
            method === "spawnSync" ||
            method === "Command") &&
          argv
        )
          out.shell.push([first.value, ...argv.items].map(quote).join(" "));
        else if (
          language === "perl" || language === "ruby"
            ? args.length > 1 && args.every((a) => a.kind === "string" && !a.dynamic)
            : false
        )
          out.shell.push(args.map((a) => quote((a as { value: string }).value)).join(" "));
        else out.shell.push(first.value);
      } else if (first.kind === "list" && first.items.length) out.shell.push(first.items.map(quote).join(" "));
      else out.dynamicExec.push(t.text);
      continue;
    }
    if (RECURSIVE_DELETE[language].has(method) && first?.kind === "string" && !first.dynamic) {
      const recursive =
        language !== "javascript" ||
        method === "remove" ||
        method === "removeSync" ||
        args.some((a) => a.kind === "options" && /recursive\s*:\s*true/.test(a.text));
      out.deletes.push({ path: first.value, recursive, how: t.text });
      continue;
    }
    if (
      FILE_DELETE[language].has(method) &&
      first?.kind === "string" &&
      !first.dynamic &&
      deleteOwner(language, t.text)
    ) {
      out.deletes.push({ path: first.value, recursive: false, how: t.text });
      continue;
    }
    if (WRITE[language].has(method) && first?.kind === "string" && !first.dynamic) {
      const mode = args[1]?.kind === "string" ? args[1].value : "";
      if (method === "open" && !/[wax+]/.test(mode)) continue;
      out.writes.push({ path: first.value, append: /^a/.test(mode) || /append/i.test(method), how: t.text });
    }
  }
  return out;
}

/** Calls named like exec sinks that are not: `re.run`, a list's `.call` in JS. */
function execOwner(language: Language, path: string, method: string): boolean {
  if (
    language === "python" &&
    ["run", "call", "Popen", "check_call", "check_output", "getoutput", "getstatusoutput"].includes(method)
  )
    return /(^|\.)(subprocess|sp|commands)\.[A-Za-z_]+$/.test(path) || path === method;
  if (
    language === "python" &&
    (method === "system" || method === "popen" || method.startsWith("exec") || method === "spawn")
  )
    return /(^|\.)(os|pty|posix)\.[A-Za-z_]+$/.test(path) || path === method;
  if (language === "javascript" && method === "Command") return /Deno\.Command$/.test(path);
  if (language === "javascript" && method === "exec")
    return path !== "exec" ? /(child_process|cp|childProcess)\.exec$/.test(path) : true;
  if (language === "ruby" && ["capture2", "capture2e", "capture3", "popen2", "popen3", "pipeline"].includes(method))
    return /Open3\./.test(path);
  if (language === "ruby" && method === "popen") return /IO\.popen$/.test(path);
  if (language === "lua") return /^(os|io)\./.test(path);
  return true;
}

function deleteOwner(language: Language, path: string): boolean {
  if (language === "python") return /(^|\.)(os|Path\([^)]*\))\.[a-z]+$/.test(path) || /^os\./.test(path);
  if (language === "ruby") return /(File|FileUtils)\.[a-z_]+$/.test(path);
  if (language === "lua") return /^os\./.test(path);
  return true;
}

type Arg =
  | { kind: "string"; value: string; dynamic: boolean }
  | { kind: "list"; items: string[] }
  | { kind: "options"; text: string }
  | { kind: "other" };

/** A call's arguments, top level only: literal strings, lists, option objects, anything else. */
function argumentsAt(tokens: Token[], start: number): Arg[] {
  const out: Arg[] = [];
  let depth = 0;
  let current: Token[] = [];
  const flush = () => {
    if (!current.length) return;
    const [a] = current;
    if (current.length === 1 && (a.kind === "string" || a.kind === "template"))
      out.push({ kind: "string", value: a.text, dynamic: !!a.dynamic });
    else if (a.text === "[" || a.text === "(") {
      const inner = current.slice(1, -1).filter((x) => x.text !== ",");
      if (inner.length && inner.every((x) => x.kind === "string" && !x.dynamic))
        out.push({ kind: "list", items: inner.map((x) => x.text) });
      else out.push({ kind: "other" });
    } else if (a.text === "{") out.push({ kind: "options", text: current.map((x) => x.text).join(" ") });
    else out.push({ kind: "other" });
    current = [];
  };
  for (let i = start; i < tokens.length && i < start + 400; i += 1) {
    const t = tokens[i];
    if (t.kind === "punct" && (t.text === "(" || t.text === "[" || t.text === "{")) depth += 1;
    if (t.kind === "punct" && (t.text === ")" || t.text === "]" || t.text === "}")) {
      if (depth === 0) break;
      depth -= 1;
    }
    if (depth === 0 && t.text === ",") {
      flush();
      continue;
    }
    current.push(t);
  }
  flush();
  return out;
}

const quote = (s: string) => (/^[\w./=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Words, strings with values and punctuation; comments dropped, shell literals tagged. */
function tokenize(language: Language, src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const hashComment = language === "python" || language === "ruby" || language === "perl" || language === "php";
  const slashComment = language === "javascript" || language === "php";
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (
      (hashComment && c === "#") ||
      (slashComment && src.startsWith("//", i)) ||
      (language === "lua" && src.startsWith("--", i) && !src.startsWith("--[[", i))
    ) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if ((slashComment && src.startsWith("/*", i)) || (language === "lua" && src.startsWith("--[[", i))) {
      const close = language === "lua" ? "]]" : "*/";
      const end = src.indexOf(close, i + 2);
      i = end < 0 ? src.length : end + close.length;
      continue;
    }
    if (language === "python" && /[rRbBuUfF]/.test(c) && /['"]/.test(src[i + 1] ?? "")) {
      const raw = /[rR]/.test(c);
      const f = /[fF]/.test(c);
      const read = pythonString(src, i + 1, raw);
      out.push({ kind: "string", text: read.value, dynamic: f && /\{[^{]/.test(read.value) });
      i = read.end;
      continue;
    }
    if (language === "python" && /[rRbBfF]{2}/.test(src.slice(i, i + 2)) && /['"]/.test(src[i + 2] ?? "")) {
      const read = pythonString(src, i + 2, /[rR]/.test(src.slice(i, i + 2)));
      out.push({
        kind: "string",
        text: read.value,
        dynamic: /[fF]/.test(src.slice(i, i + 2)) && /\{[^{]/.test(read.value),
      });
      i = read.end;
      continue;
    }
    if (c === "'" || c === '"') {
      const read = language === "python" ? pythonString(src, i, false) : quoted(src, i, c);
      const dynamic =
        language === "ruby"
          ? c === '"' && /#\{/.test(read.value)
          : language === "perl" || language === "php"
            ? c === '"' && /[$@][\w{]/.test(read.value)
            : false;
      out.push({ kind: "string", text: read.value, dynamic });
      i = read.end;
      continue;
    }
    if (c === "`") {
      const read = quoted(src, i, "`");
      const dynamic =
        language === "javascript"
          ? /\$\{/.test(read.value)
          : language === "ruby"
            ? /#\{/.test(read.value)
            : /[$@][\w{]/.test(read.value);
      out.push({ kind: language === "javascript" ? "template" : "shell", text: read.value, dynamic });
      i = read.end;
      continue;
    }
    if (
      (language === "ruby" && src.startsWith("%x", i)) ||
      (language === "perl" && src.startsWith("qx", i) && !/\w/.test(src[i - 1] ?? " "))
    ) {
      const open = src[i + 2];
      const close = { "(": ")", "{": "}", "[": "]", "<": ">" }[open] ?? open;
      const end = src.indexOf(close, i + 3);
      if (open && end > 0) {
        const body = src.slice(i + 3, end);
        out.push({ kind: "shell", text: body, dynamic: /#\{|[$@][\w{]/.test(body) });
        i = end + 1;
        continue;
      }
    }
    if (language === "lua" && src.startsWith("[[", i)) {
      const end = src.indexOf("]]", i + 2);
      out.push({ kind: "string", text: src.slice(i + 2, end < 0 ? src.length : end) });
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    const word = /^[A-Za-z_$\\][\w$\\]*(?:\s*(?:\.|->|::)\s*[A-Za-z_$][\w$]*)*/.exec(src.slice(i, i + 200));
    if (word) {
      out.push({ kind: "word", text: word[0].replace(/\s+/g, "").replace(/->|::/g, ".").replace(/^\\/, "") });
      i += word[0].length;
      continue;
    }
    out.push({ kind: "punct", text: c });
    i += 1;
  }
  return out;
}

function pythonString(src: string, at: number, raw: boolean): { value: string; end: number } {
  const q = src[at];
  const triple = src.startsWith(q.repeat(3), at);
  const close = triple ? q.repeat(3) : q;
  let i = at + close.length;
  let value = "";
  while (i < src.length && !src.startsWith(close, i)) {
    if (src[i] === "\\" && !raw) {
      value += unescape(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (!triple && src[i] === "\n") break;
    value += src[i];
    i += 1;
  }
  return { value, end: Math.min(src.length, i + close.length) };
}

function quoted(src: string, at: number, q: string): { value: string; end: number } {
  let i = at + 1;
  let value = "";
  while (i < src.length && src[i] !== q) {
    if (src[i] === "\\") {
      value += unescape(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    value += src[i];
    i += 1;
  }
  return { value, end: Math.min(src.length, i + 1) };
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
const unescape = (c: string) => ESCAPES[c] ?? c;
