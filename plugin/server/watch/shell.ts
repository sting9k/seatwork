/** A shell command line split as the shell would, into simple commands; a reader, not an interpreter: nothing runs. */

/** How a command hands over to the next one in its list. */
export type Joiner = "&&" | "||" | ";" | "|" | "&";

export interface Redirect {
  op: ">" | ">>" | "<";
  target: string;
  fd?: number;
}

/** One simple command: `argv` has quotes removed and wrappers (`sudo`, `env X=1`, `timeout 60`) peeled off. */
export interface SimpleCommand {
  argv: string[];
  redirects: Redirect[];
  joiner: Joiner | null;
  inLoop: boolean;
  substituted: boolean;
  viaXargs: boolean;
  script?: string;
}

export interface ShellLine {
  commands: SimpleCommand[];
  complete: boolean;
}

/** Longest command line read in full; agents paste whole files into heredocs. */
const MAX_CHARS = 20_000;
/** `bash -c "bash -c '...'"` and friends. */
const MAX_DEPTH = 6;

type Token =
  | { t: "word"; value: string; subs: string[] }
  | { t: "op"; value: Joiner | "(" | ")" | "\n" }
  | { t: "redirect"; op: Redirect["op"]; target: string; subs: string[]; fd?: number }
  | { t: "heredoc"; body: string };

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Reserved words that open a loop, close one, or only separate commands. */
const LOOP_OPEN = new Set(["while", "until", "for", "select"]);
const SEPARATORS = new Set(["if", "then", "else", "elif", "fi", "do", "{", "}", "!", "time", "function", "esac"]);
/** Wrapper → its flags that take a value. */
const WRAPPERS: Record<string, readonly string[]> = {
  sudo: ["-u", "-g", "-C", "-h", "-p", "-U"],
  doas: ["-u"],
  nohup: [],
  command: [],
  builtin: [],
  exec: ["-a"],
  nice: ["-n"],
  ionice: ["-c", "-n", "-p"],
  stdbuf: ["-i", "-o", "-e"],
  caffeinate: ["-t", "-w"],
  chronic: [],
  unbuffer: [],
};
const XARGS_VALUE_FLAGS = ["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a", "-J", "-R"];
const TIMEOUT_VALUE_FLAGS = ["-s", "--signal", "-k", "--kill-after"];

export function parseShell(source: string): ShellLine {
  const cut = source.length > MAX_CHARS;
  const state = { complete: !cut };
  const commands = parse(cut ? source.slice(0, MAX_CHARS) : source, 0, state);
  return { commands, complete: state.complete };
}

/* ---------- lexer ---------- */

/** Index just past the `)` that closes the `(` at `open`, quotes and nesting respected; -1 when none. */
function closingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      const end = closingDoubleQuote(src, i);
      if (end < 0) return -1;
      i = end;
    } else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Index of the `"` that closes the one at `open`; -1 when it never closes. */
function closingDoubleQuote(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === '"') return i;
    else if (c === "$" && src[i + 1] === "(") {
      const end = closingParen(src, i + 1);
      if (end < 0) return -1;
      i = end - 1;
    }
  }
  return -1;
}

function lex(src: string, state: { complete: boolean }): Token[] {
  const tokens: Token[] = [];
  /** Heredoc delimiters seen on the current line, bodies start after its newline. */
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  let i = 0;

  const readWord = (): { value: string; subs: string[] } => {
    let value = "";
    const subs: string[] = [];
    const substitution = (open: number): number => {
      const end = closingParen(src, open);
      if (end < 0) {
        state.complete = false;
        return src.length;
      }
      // $(( … )) is arithmetic, not a command
      if (src[open + 1] !== "(") subs.push(src.slice(open + 1, end - 1));
      value += "$()";
      return end;
    };
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        if (src[i + 1] === "\n") i += 2;
        else {
          value += src[i + 1] ?? "";
          i += 2;
        }
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) {
          state.complete = false;
          value += src.slice(i + 1);
          i = src.length;
        } else {
          value += src.slice(i + 1, end);
          i = end + 1;
        }
      } else if (c === '"') {
        const end = closingDoubleQuote(src, i);
        const stop = end < 0 ? src.length : end;
        if (end < 0) state.complete = false;
        let j = i + 1;
        while (j < stop) {
          if (src[j] === "\\" && j + 1 < stop) {
            value += src[j + 1];
            j += 2;
          } else if (src[j] === "$" && src[j + 1] === "(") {
            j = substitution(j + 1);
          } else if (src[j] === "`") {
            const close = src.indexOf("`", j + 1);
            const until = close < 0 || close > stop ? stop : close;
            subs.push(src.slice(j + 1, until));
            value += "$()";
            j = until + 1;
          } else {
            value += src[j];
            j += 1;
          }
        }
        i = stop + 1;
      } else if (c === "$" && src[i + 1] === "(") {
        i = substitution(i + 1);
      } else if (c === "$" && src[i + 1] === "'") {
        const end = src.indexOf("'", i + 2);
        const stop = end < 0 ? src.length : end;
        if (end < 0) state.complete = false;
        value += src.slice(i + 2, stop);
        i = stop + 1;
      } else if (c === "`") {
        const end = src.indexOf("`", i + 1);
        const stop = end < 0 ? src.length : end;
        if (end < 0) state.complete = false;
        subs.push(src.slice(i + 1, stop));
        value += "$()";
        i = stop + 1;
      } else if (/[\s;&|()<>]/.test(c)) {
        break;
      } else {
        value += c;
        i += 1;
      }
    }
    return { value, subs };
  };

  const skipBlanks = () => {
    while (i < src.length && (src[i] === " " || src[i] === "\t" || (src[i] === "\\" && src[i + 1] === "\n"))) i += src[i] === "\\" ? 2 : 1;
  };

  /** Reads the redirection whose operator starts at `at`; returns the index after it. */
  const lexRedirect = (at: number, fd?: number): number => {
    i = at;
    if (src.startsWith("<<<", i)) {
      // a here-string is data for the command, not a file
      i += 3;
      skipBlanks();
      readWord();
      return i;
    }
    if (src.startsWith("<<", i)) {
      const stripTabs = src[i + 2] === "-";
      i += stripTabs ? 3 : 2;
      skipBlanks();
      const delimiter = readWord().value;
      if (delimiter) pending.push({ delimiter, stripTabs });
      return i;
    }
    const op: Redirect["op"] = src[i] === "<" ? "<" : src[i + 1] === ">" ? ">>" : ">";
    i += op === ">>" ? 2 : 1;
    if (src[i] === "|") i += 1; // >| overrides noclobber
    if (src[i] === "&") {
      // >&2, 2>&1, <&3: a copy of a descriptor; `>&file` is the old spelling of &>file
      i += 1;
      skipBlanks();
      const word = readWord();
      if (!/^[0-9]+-?$|^-$/.test(word.value) && op !== "<") tokens.push({ t: "redirect", op, target: word.value, subs: word.subs, ...(fd === undefined ? {} : { fd }) });
      return i;
    }
    skipBlanks();
    const word = readWord();
    if (word.value) tokens.push({ t: "redirect", op, target: word.value, subs: word.subs, ...(fd === undefined ? {} : { fd }) });
    return i;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
    } else if (c === "\n") {
      i += 1;
      tokens.push({ t: "op", value: "\n" });
      // the bodies of this line's heredocs follow, in the order their delimiters were written
      for (const doc of pending.splice(0)) {
        const lines: string[] = [];
        let closed = false;
        while (i < src.length) {
          const end = src.indexOf("\n", i);
          const line = src.slice(i, end < 0 ? src.length : end);
          i = end < 0 ? src.length : end + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            closed = true;
            break;
          }
          lines.push(line);
        }
        if (!closed) state.complete = false;
        tokens.push({ t: "heredoc", body: lines.join("\n") });
      }
    } else if (c === "#" && (i === 0 || /[\s;&|(]/.test(src[i - 1]))) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "&" && src[i + 1] === "&") {
      tokens.push({ t: "op", value: "&&" });
      i += 2;
    } else if (c === "|" && src[i + 1] === "|") {
      tokens.push({ t: "op", value: "||" });
      i += 2;
    } else if (c === "&" && src[i + 1] === ">") {
      // &> and &>> send both streams to a file
      const append = src[i + 2] === ">";
      i += append ? 3 : 2;
      skipBlanks();
      const word = readWord();
      tokens.push({ t: "redirect", op: append ? ">>" : ">", target: word.value, subs: word.subs });
    } else if (c === "|") {
      tokens.push({ t: "op", value: "|" });
      i += src[i + 1] === "&" ? 2 : 1;
    } else if (c === "&") {
      tokens.push({ t: "op", value: "&" });
      i += 1;
    } else if (c === ";") {
      tokens.push({ t: "op", value: ";" });
      i += src[i + 1] === ";" ? 2 : 1;
    } else if (c === "(" || c === ")") {
      tokens.push({ t: "op", value: c });
      i += 1;
    } else if (c === "<" || c === ">") {
      i = lexRedirect(i);
    } else if (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(src.slice(i, i + 4))) {
      // a descriptor number glued to a redirection: 2>file, 2>&1
      const from = i;
      while (/[0-9]/.test(src[i])) i += 1;
      i = lexRedirect(i, Number(src.slice(from, i)));
    } else {
      const word = readWord();
      tokens.push({ t: "word", value: word.value, subs: word.subs });
    }
  }
  if (pending.length > 0) state.complete = false;
  return tokens;

}

/* ---------- parser ---------- */

interface Draft {
  words: string[];
  redirects: Redirect[];
  subs: string[];
}

function parse(source: string, depth: number, state: { complete: boolean }): SimpleCommand[] {
  if (depth > MAX_DEPTH) {
    state.complete = false;
    return [];
  }
  const out: SimpleCommand[] = [];
  let draft: Draft = { words: [], redirects: [], subs: [] };
  let loops = 0;
  /** Words of a `for x in a b c` header are data until its `do` or the end of the line. */
  let skippingHeader = false;
  /** A group just closed: the next operator joins its last command to what follows. */
  let groupClosed = false;

  const finish = (joiner: Joiner | null) => {
    const current = draft;
    draft = { words: [], redirects: [], subs: [] };
    for (const sub of current.subs) {
      for (const inner of parse(sub, depth + 1, state)) out.push({ ...inner, substituted: true, joiner: inner.joiner ?? ";" });
    }
    out.push(...build(current, joiner, loops > 0, depth, state));
  };

  for (const token of lex(source, state)) {
    if (token.t === "heredoc") {
      // belongs to the last command that was finished on this line
      const owner = out[out.length - 1];
      if (!owner) continue;
      if (isShell(owner.argv) && !owner.argv.some((a) => a === "-c")) {
        const body = parse(token.body, depth + 1, state);
        if (body.length > 0) {
          const joiner = owner.joiner;
          out.pop();
          body[body.length - 1] = { ...body[body.length - 1], joiner };
          out.push(...body);
        }
      } else if (owner.redirects.every((redirect) => redirect.op === "<")) {
        // `cat > file <<EOF` is file content; without an output file the heredoc is what the program reads
        out[out.length - 1] = { ...owner, script: token.body };
      }
      continue;
    }
    if (token.t === "op") {
      skippingHeader = false;
      const joiner: Joiner = token.value === "(" || token.value === ")" || token.value === "\n" ? ";" : token.value;
      const joinsGroup = groupClosed && joiner === token.value && draft.words.length === 0 && out.length > 0;
      if (joinsGroup) out[out.length - 1] = { ...out[out.length - 1], joiner };
      else finish(joiner);
      groupClosed = token.value === ")";
      continue;
    }
    groupClosed = false;
    if (token.t === "redirect") {
      draft.redirects.push({ op: token.op, target: token.target, ...(token.fd === undefined ? {} : { fd: token.fd }) });
      draft.subs.push(...token.subs);
      continue;
    }
    const atCommandStart = draft.words.length === 0;
    if (atCommandStart && LOOP_OPEN.has(token.value)) {
      loops += 1;
      skippingHeader = token.value === "for" || token.value === "select";
      continue;
    }
    if (skippingHeader) {
      if (token.value === "do") skippingHeader = false;
      continue;
    }
    if (atCommandStart && token.value === "done") {
      loops = Math.max(0, loops - 1);
      continue;
    }
    if (atCommandStart && SEPARATORS.has(token.value)) continue;
    draft.words.push(token.value);
    draft.subs.push(...token.subs);
  }
  finish(null);
  const last = out[out.length - 1];
  if (last && last.joiner !== "&") out[out.length - 1] = { ...last, joiner: null };
  return out;
}

function isShell(argv: readonly string[]): boolean {
  return SHELLS.has(basename(argv[0] ?? ""));
}

function basename(program: string): string {
  const slash = program.lastIndexOf("/");
  return slash < 0 ? program : program.slice(slash + 1);
}

/** Drops `count` leading words, then every flag after them, with the value of each flag in `valued`. */
function peel(words: string[], count: number, valued: readonly string[]): string[] {
  let i = count;
  while (i < words.length && words[i].startsWith("-") && words[i] !== "-" && words[i] !== "--") {
    i += valued.includes(words[i]) ? 2 : 1;
  }
  if (words[i] === "--") i += 1;
  return words.slice(i);
}

/** One drafted command → its simple commands (more than one when it wraps a `-c` script). */
function build(draft: Draft, joiner: Joiner | null, inLoop: boolean, depth: number, state: { complete: boolean }): SimpleCommand[] {
  let words = draft.words;
  let viaXargs = false;
  for (let guard = 0; guard < 12; guard += 1) {
    // FOO=bar assignments in front of the program
    let lead = 0;
    while (lead < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[lead])) lead += 1;
    if (lead > 0) words = words.slice(lead);
    const program = basename(words[0] ?? "");
    if (program in WRAPPERS) words = peel(words, 1, WRAPPERS[program]);
    else if (program === "env") words = peel(words, 1, ["-u", "-C", "-S"]);
    else if (program === "timeout" || program === "gtimeout") words = peel(words, 1, TIMEOUT_VALUE_FLAGS).slice(1);
    else if (program === "xargs") {
      words = peel(words, 1, XARGS_VALUE_FLAGS);
      viaXargs = true;
    } else break;
  }
  if (words.length === 0) return [];
  const program = basename(words[0]);
  // a script handed to a shell as text is read as if it had been typed
  const scriptAt = SHELLS.has(program) ? words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) : program === "eval" ? 0 : -1;
  if (scriptAt >= 0 && words[scriptAt + 1] !== undefined) {
    const script = program === "eval" ? words.slice(1).join(" ") : words[scriptAt + 1];
    const inner = parse(script, depth + 1, state);
    if (inner.length > 0) {
      const tail = inner[inner.length - 1];
      inner[inner.length - 1] = { ...tail, joiner, redirects: [...tail.redirects, ...draft.redirects] };
      return inLoop ? inner.map((command) => ({ ...command, inLoop: true })) : inner;
    }
  }
  return [{ argv: words, redirects: draft.redirects, joiner, inLoop, substituted: false, viaXargs }];
}

/* ---------- questions rules ask of a parsed line ---------- */

/** The commands whose exit status the line's own status depends on: not those inside `$(...)`. */
export function listed(line: ShellLine): SimpleCommand[] {
  return line.commands.filter((command) => !command.substituted);
}

/** Whether the line's exit status proves `command` succeeded: it is last, or only `&&` follows it. */
export function statusCovers(line: ShellLine, command: SimpleCommand): boolean {
  const chain = listed(line);
  const at = chain.indexOf(command);
  if (at < 0) return false;
  for (let i = at; i < chain.length; i += 1) {
    const joiner = chain[i].joiner;
    if (joiner === null) return true;
    if (joiner === "&&") continue;
    // `|| exit 1` runs only on failure and fails the line itself: a zero status still means success
    if (joiner === "||" && alwaysFails(chain[i + 1])) continue;
    return false;
  }
  return true;
}

function alwaysFails(command: SimpleCommand | undefined): boolean {
  if (!command) return false;
  const [program, code] = command.argv;
  if (program === "false") return true;
  return (program === "exit" || program === "return") && code !== undefined && /^[0-9]+$/.test(code) && Number(code) !== 0;
}
