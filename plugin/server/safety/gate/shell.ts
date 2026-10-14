/** Reads a POSIX or bash command line into a tree; words keep literal and run-time parts. */

export type Quote = "none" | "single" | "double" | "ansi";

/** One piece of a word: literal text, or what the shell only knows when it runs the line. */
export type Part =
  | { kind: "text"; text: string; quote: Quote }
  | { kind: "tilde"; user: string }
  | { kind: "param"; name: string; raw: string; quoted: boolean; scripts: Script[] }
  | { kind: "command"; script: Script; raw: string; quoted: boolean }
  | { kind: "arith"; raw: string; scripts: Script[] }
  | { kind: "process"; script: Script; raw: string; direction: "<" | ">" };

export interface Word {
  raw: string;
  start: number;
  end: number;
  parts: Part[];
}

export interface Heredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
  body: string;
  parts: Part[];
  terminated: boolean;
}

export type RedirectOp = "<" | ">" | ">>" | ">|" | "<>" | "&>" | "&>>" | ">&" | "<&" | "<<" | "<<-" | "<<<";

export interface Redirect {
  op: RedirectOp;
  fd: string | null;
  target: Word | null;
  heredoc: Heredoc | null;
}

export interface Assignment {
  name: string;
  append: boolean;
  value: Word | null;
  items: Word[] | null;
}

export interface Simple {
  kind: "simple";
  assigns: Assignment[];
  words: Word[];
  redirects: Redirect[];
  start: number;
  end: number;
}

export interface Compound {
  kind: "group" | "subshell" | "if" | "while" | "until" | "for" | "select" | "case" | "arith" | "cond";
  bodies: Script[];
  words: Word[];
  redirects: Redirect[];
  start: number;
  end: number;
}

export interface FunctionDef {
  kind: "function";
  name: string;
  body: Command;
  start: number;
  end: number;
}

export type Command = Simple | Compound | FunctionDef;

export interface Pipeline {
  negated: boolean;
  commands: Command[];
  pipes: ("|" | "|&")[];
}

/** Pipelines joined by && and ||, ended by `;`, `&` or a newline. */
export interface Sequence {
  pipelines: Pipeline[];
  ops: ("&&" | "||")[];
  background: boolean;
}

export type Script = Sequence[];

export interface Parsed {
  script: Script;
  error: { at: number; message: string; costly?: true } | null;
}

export class ShellSyntaxError extends Error {
  constructor(
    readonly at: number,
    message: string,
  ) {
    super(message);
  }
}

/** A command line too costly to read: the reading stops, whatever try was under way. */
export class ShellLimitError extends Error {}

const MAX_DEPTH = 64;
const MAX_STEPS = 100_000;
const WORD_END = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL_PARAM = new Set(["@", "*", "#", "?", "-", "$", "!", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const REDIRECT = /(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(<<<|<<-|<<|<>|<&|>>|>&|>\||&>>|&>|<|>)/y;
const BARE = /[^\s;&|<>()'"\\$`]+/y;
const ANSI_NAMED: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

interface Pending {
  heredoc: Heredoc;
}

class Parser {
  pos = 0;
  private pending: Pending[] = [];

  constructor(
    readonly src: string,
    private depth: number,
    private readonly budget: { steps: number } = { steps: 0 },
  ) {}

  /** Counts work toward the budget every parser of one line shares; past it the reading stops. */
  private spend(steps: number): void {
    if ((this.budget.steps += steps) > MAX_STEPS) throw new ShellLimitError("the line is too costly to read");
  }

  /** Lists of commands until the end, a closing `)`, or one of `ends` at command position. */
  script(ends: ReadonlySet<string>, closer: ")" | null, caseBody = false): Script {
    if (this.depth > MAX_DEPTH) throw new ShellSyntaxError(this.pos, "nested too deep");
    this.spend(1);
    const out: Script = [];
    for (;;) {
      this.space(true);
      if (this.eof()) {
        if (closer) throw new ShellSyntaxError(this.pos, `missing ${closer}`);
        return out;
      }
      if (closer && this.peek() === closer) return out;
      if (caseBody && (this.at(";;") || this.at(";&"))) return out;
      if (this.reservedAhead(ends)) return out;
      const sequence = this.sequence();
      out.push(sequence);
      this.blanks();
      if (this.at(";;") || this.at(";&")) {
        if (!caseBody) throw new ShellSyntaxError(this.pos, "unexpected ;;");
        return out;
      }
      const c = this.peek();
      if (c === ";") this.pos += 1;
      else if (c === "&") {
        sequence.background = true;
        this.pos += 1;
      } else if (c === "\n") this.newline();
      else if (this.eof() || (closer && c === closer)) continue;
      else if (!this.reservedAhead(ends)) throw new ShellSyntaxError(this.pos, `unexpected ${c}`);
    }
  }

  private sequence(): Sequence {
    const sequence: Sequence = { pipelines: [this.pipeline()], ops: [], background: false };
    for (;;) {
      this.blanks();
      const op = this.at("&&") ? "&&" : this.at("||") ? "||" : null;
      if (!op) return sequence;
      this.pos += 2;
      this.space(true);
      sequence.ops.push(op);
      sequence.pipelines.push(this.pipeline());
    }
  }

  private pipeline(): Pipeline {
    this.blanks();
    let negated = false;
    if (this.peek() === "!" && /[\s]/.test(this.src[this.pos + 1] ?? " ")) {
      negated = true;
      this.pos += 1;
    }
    const pipeline: Pipeline = { negated, commands: [this.command()], pipes: [] };
    for (;;) {
      this.blanks();
      if (this.peek() !== "|" || this.at("||")) return pipeline;
      const op = this.at("|&") ? "|&" : "|";
      this.pos += op.length;
      this.space(true);
      pipeline.pipes.push(op);
      pipeline.commands.push(this.command());
    }
  }

  private command(): Command {
    this.blanks();
    const start = this.pos;
    if (this.at("((")) {
      const arith = this.tryArithCommand(start);
      if (arith) return this.withRedirects(arith);
    }
    if (this.peek() === "(") {
      this.pos += 1;
      const body = this.nested(() => this.script(new Set(), ")"));
      this.expect(")");
      return this.withRedirects({ kind: "subshell", bodies: [body], words: [], redirects: [], start, end: this.pos });
    }
    const bare = this.bareAhead();
    switch (bare) {
      case "{": {
        this.pos += 1;
        const body = this.nested(() => this.script(new Set(["}"]), null));
        this.expectWord("}");
        return this.withRedirects({ kind: "group", bodies: [body], words: [], redirects: [], start, end: this.pos });
      }
      case "if":
        return this.withRedirects(this.ifCommand(start));
      case "while":
      case "until":
        return this.withRedirects(this.loop(bare, start));
      case "for":
      case "select":
        return this.withRedirects(this.forCommand(bare, start));
      case "case":
        return this.withRedirects(this.caseCommand(start));
      case "[[":
        return this.withRedirects(this.cond(start));
      case "function":
        return this.functionKeyword(start);
    }
    const simple = this.simple();
    const name =
      simple.words.length === 1 && !simple.assigns.length && !simple.redirects.length ? simple.words[0] : null;
    if (name && /^[^\s$`'"\\]+$/.test(name.raw)) {
      const save = this.pos;
      this.blanks();
      if (this.peek() === "(") {
        this.pos += 1;
        this.blanks();
        if (this.peek() === ")") {
          this.pos += 1;
          this.space(true);
          const body = this.command();
          return { kind: "function", name: name.raw, body, start, end: this.pos };
        }
      }
      this.pos = save;
    }
    return simple;
  }

  private simple(): Simple {
    const start = this.pos;
    const simple: Simple = { kind: "simple", assigns: [], words: [], redirects: [], start, end: start };
    for (;;) {
      this.blanks();
      if (this.eof()) break;
      const c = this.peek();
      if ((c === "<" || c === ">") && this.src[this.pos + 1] === "(") {
        simple.words.push(this.word());
        continue;
      }
      if (this.redirectAhead()) {
        simple.redirects.push(this.redirect());
        continue;
      }
      if (WORD_END.has(c)) break;
      const word = this.word();
      const assign = simple.words.length === 0 ? /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/.exec(word.raw) : null;
      if (assign) {
        const append = assign[3] === "+";
        if (word.raw.length === assign[0].length && this.peek() === "(") {
          this.pos += 1;
          const items: Word[] = [];
          for (;;) {
            this.space(true);
            if (this.peek() === ")") break;
            if (this.eof()) throw new ShellSyntaxError(this.pos, "missing ) in array");
            items.push(this.word());
          }
          this.pos += 1;
          simple.assigns.push({ name: assign[1], append, value: null, items });
        } else {
          simple.assigns.push({ name: assign[1], append, value: valueAfter(word, assign[0].length), items: null });
        }
        continue;
      }
      simple.words.push(word);
    }
    simple.end = this.pos;
    if (!simple.words.length && !simple.assigns.length && !simple.redirects.length)
      throw new ShellSyntaxError(this.pos, `unexpected ${this.eof() ? "end" : this.peek()}`);
    return simple;
  }

  private withRedirects<T extends Compound>(compound: T): T {
    for (;;) {
      this.blanks();
      if (!this.redirectAhead()) break;
      compound.redirects.push(this.redirect());
    }
    compound.end = this.pos;
    return compound;
  }

  private ifCommand(start: number): Compound {
    this.pos += 2;
    const bodies: Script[] = [];
    bodies.push(this.nested(() => this.script(new Set(["then"]), null)));
    this.expectWord("then");
    bodies.push(this.nested(() => this.script(new Set(["elif", "else", "fi"]), null)));
    for (;;) {
      const next = this.bareAhead();
      if (next === "elif") {
        this.pos += 4;
        bodies.push(this.nested(() => this.script(new Set(["then"]), null)));
        this.expectWord("then");
        bodies.push(this.nested(() => this.script(new Set(["elif", "else", "fi"]), null)));
      } else if (next === "else") {
        this.pos += 4;
        bodies.push(this.nested(() => this.script(new Set(["fi"]), null)));
      } else break;
    }
    this.expectWord("fi");
    return { kind: "if", bodies, words: [], redirects: [], start, end: this.pos };
  }

  private loop(kind: "while" | "until", start: number): Compound {
    this.pos += kind.length;
    const condition = this.nested(() => this.script(new Set(["do"]), null));
    this.expectWord("do");
    const body = this.nested(() => this.script(new Set(["done"]), null));
    this.expectWord("done");
    return { kind, bodies: [condition, body], words: [], redirects: [], start, end: this.pos };
  }

  private forCommand(kind: "for" | "select", start: number): Compound {
    this.pos += kind.length;
    this.blanks();
    const words: Word[] = [];
    if (this.at("((")) {
      this.pos += 2;
      const raw = this.arithBody();
      words.push({ raw, start: this.pos, end: this.pos, parts: [{ kind: "arith", raw, scripts: [] }] });
    } else {
      words.push(this.word());
      this.space(true);
      if (this.bareAhead() === "in") {
        this.pos += 2;
        for (;;) {
          this.blanks();
          const c = this.peek();
          if (this.eof() || c === ";" || c === "\n") break;
          words.push(this.word());
        }
      }
    }
    this.blanks();
    if (this.peek() === ";") this.pos += 1;
    this.space(true);
    this.expectWord("do");
    const body = this.nested(() => this.script(new Set(["done"]), null));
    this.expectWord("done");
    return { kind, bodies: [body], words, redirects: [], start, end: this.pos };
  }

  private caseCommand(start: number): Compound {
    this.pos += 4;
    this.blanks();
    const words: Word[] = [this.word()];
    this.space(true);
    this.expectWord("in");
    const bodies: Script[] = [];
    for (;;) {
      this.space(true);
      if (this.bareAhead() === "esac") {
        this.pos += 4;
        break;
      }
      if (this.eof()) throw new ShellSyntaxError(this.pos, "missing esac");
      if (this.peek() === "(") this.pos += 1;
      for (;;) {
        this.blanks();
        words.push(this.word());
        this.blanks();
        if (this.peek() !== "|") break;
        this.pos += 1;
      }
      this.expect(")");
      bodies.push(this.nested(() => this.script(new Set(["esac"]), null, true)));
      this.blanks();
      for (const end of [";;&", ";;", ";&"]) {
        if (this.at(end)) {
          this.pos += end.length;
          break;
        }
      }
    }
    return { kind: "case", bodies, words, redirects: [], start, end: this.pos };
  }

  private cond(start: number): Compound {
    this.pos += 2;
    const words: Word[] = [];
    for (;;) {
      this.space(true);
      if (this.eof()) throw new ShellSyntaxError(this.pos, "missing ]]");
      if (this.bareAhead() === "]]") {
        this.pos += 2;
        break;
      }
      const op = ["&&", "||", "(", ")", "!", "<", ">", "|", "&"].find((o) => this.at(o));
      if (op) {
        words.push({
          raw: op,
          start: this.pos,
          end: this.pos + op.length,
          parts: [{ kind: "text", text: op, quote: "none" }],
        });
        this.pos += op.length;
        continue;
      }
      words.push(this.word());
    }
    return { kind: "cond", bodies: [], words, redirects: [], start, end: this.pos };
  }

  private functionKeyword(start: number): FunctionDef {
    this.pos += 8;
    this.blanks();
    const name = this.word().raw;
    this.blanks();
    if (this.at("()")) this.pos += 2;
    else if (this.peek() === "(") {
      this.pos += 1;
      this.blanks();
      this.expect(")");
    }
    this.space(true);
    const body = this.command();
    return { kind: "function", name, body, start, end: this.pos };
  }

  private tryArithCommand(start: number): Compound | null {
    const save = this.pos;
    this.pos += 2;
    try {
      const raw = this.arithBody();
      if (readsAsCommands(raw)) throw new ShellSyntaxError(start, "not arithmetic");
      return {
        kind: "arith",
        bodies: substitutionsIn(raw, this.depth + 1, this.budget),
        words: [],
        redirects: [],
        start,
        end: this.pos,
      };
    } catch (error) {
      // only a syntax error means "not arithmetic": a limit stops the whole reading
      if (!(error instanceof ShellSyntaxError)) throw error;
      this.pos = save;
      return null;
    }
  }

  /** The text up to the `))` that closes an arithmetic expression; throws when none does. */
  private arithBody(): string {
    const from = this.pos;
    let depth = 0;
    while (!this.eof()) {
      const c = this.peek();
      if (c === "(") depth += 1;
      else if (c === ")") {
        if (depth === 0 && this.src[this.pos + 1] === ")") {
          const raw = this.src.slice(from, this.pos);
          this.spend(raw.length);
          this.pos += 2;
          return raw;
        }
        if (depth === 0) throw new ShellSyntaxError(this.pos, "not arithmetic");
        depth -= 1;
      } else if (c === "'" || c === '"') {
        const close = this.src.indexOf(c, this.pos + 1);
        if (close < 0) throw new ShellSyntaxError(this.pos, "unterminated quote");
        this.pos = close;
      }
      this.pos += 1;
    }
    throw new ShellSyntaxError(this.pos, "missing ))");
  }

  private redirectAhead(): boolean {
    const match = this.sticky(REDIRECT);
    if (!match) return false;
    const after = this.src[this.pos + match[0].length];
    // `<(` and `>(` open a process substitution, which is a word
    return !(after === "(" && (match[2] === "<" || match[2] === ">") && !match[1]);
  }

  private redirect(): Redirect {
    const match = this.sticky(REDIRECT)!;
    this.pos += match[0].length;
    const op = match[2] as RedirectOp;
    const fd = match[1] ?? null;
    this.blanks();
    if (op === "<<" || op === "<<-") {
      const word = this.word();
      const heredoc: Heredoc = {
        delimiter: literalOf(word.parts) ?? word.raw,
        quoted: /['"\\]/.test(word.raw),
        stripTabs: op === "<<-",
        body: "",
        parts: [],
        terminated: false,
      };
      this.pending.push({ heredoc });
      return { op, fd, target: word, heredoc };
    }
    if (this.eof() || WORD_END.has(this.peek())) throw new ShellSyntaxError(this.pos, `missing target for ${op}`);
    return { op, fd, target: this.word(), heredoc: null };
  }

  /** One word up to an unquoted blank or operator. */
  word(): Word {
    const start = this.pos;
    const parts: Part[] = [];
    const text = (value: string, quote: Quote) => {
      const last = parts[parts.length - 1];
      if (last?.kind === "text" && last.quote === quote) last.text += value;
      else parts.push({ kind: "text", text: value, quote });
    };
    while (!this.eof()) {
      const c = this.peek();
      if ((c === "<" || c === ">") && this.src[this.pos + 1] === "(" && this.pos === start) {
        const direction = c;
        const from = this.pos;
        this.pos += 2;
        const script = this.nested(() => this.script(new Set(), ")"));
        this.expect(")");
        parts.push({ kind: "process", script, raw: this.src.slice(from, this.pos), direction });
        continue;
      }
      if ("@!?*+".includes(c) && this.src[this.pos + 1] === "(") {
        text(this.balanced(), "none");
        continue;
      }
      if (WORD_END.has(c)) break;
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        this.pos += 2;
        if (next === undefined) text("\\", "none");
        else if (next !== "\n") text(next, "single");
        continue;
      }
      if (c === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close < 0) throw new ShellSyntaxError(this.pos, "unterminated '");
        text(this.src.slice(this.pos + 1, close), "single");
        this.pos = close + 1;
        continue;
      }
      if (c === '"') {
        this.pos += 1;
        for (const part of this.doubleQuoted('"')) {
          if (part.kind === "text") text(part.text, "double");
          else parts.push(part);
        }
        continue;
      }
      if (c === "$") {
        const part = this.dollar(false);
        if (part.kind === "text") text(part.text, part.quote);
        else parts.push(part);
        continue;
      }
      if (c === "`") {
        parts.push(this.backtick(false));
        continue;
      }
      if (c === "~" && tildeAllowed(parts, this.pos === start)) {
        const user = /^~([A-Za-z0-9._-]*)/.exec(this.src.slice(this.pos))![1];
        const after = this.src[this.pos + 1 + user.length];
        if (after === undefined || after === "/" || after === ":" || WORD_END.has(after)) {
          parts.push({ kind: "tilde", user });
          this.pos += 1 + user.length;
          continue;
        }
      }
      text(c, "none");
      this.pos += 1;
    }
    if (this.pos === start) throw new ShellSyntaxError(this.pos, "expected a word");
    return { raw: this.src.slice(start, this.pos), start, end: this.pos, parts };
  }

  /** Text and expansions inside double quotes, up to `close` (or the end of a heredoc body). */
  private doubleQuoted(close: '"' | null): Part[] {
    const parts: Part[] = [];
    const text = (value: string) => {
      const last = parts[parts.length - 1];
      if (last?.kind === "text") last.text += value;
      else parts.push({ kind: "text", text: value, quote: "double" });
    };
    for (;;) {
      if (this.eof()) {
        if (close) throw new ShellSyntaxError(this.pos, 'unterminated "');
        return parts;
      }
      const c = this.peek();
      if (close && c === close) {
        this.pos += 1;
        return parts;
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === "\n") this.pos += 2;
        else if (next !== undefined && '$`\\"'.includes(next) && (next !== '"' || close)) {
          text(next);
          this.pos += 2;
        } else {
          text("\\");
          this.pos += 1;
        }
        continue;
      }
      if (c === "$") {
        const part = this.dollar(true);
        if (part.kind === "text") text(part.text);
        else parts.push(part);
        continue;
      }
      if (c === "`") {
        parts.push(this.backtick(true));
        continue;
      }
      text(c);
      this.pos += 1;
    }
  }

  dollar(quoted: boolean): Part {
    this.spend(1);
    const from = this.pos;
    const next = this.src[this.pos + 1];
    if (next === "'" && !quoted) {
      this.pos += 2;
      return { kind: "text", text: this.ansi(), quote: "ansi" };
    }
    if (next === '"' && !quoted) {
      this.pos += 2;
      const parts = this.doubleQuoted('"');
      if (parts.every((p) => p.kind === "text"))
        return { kind: "text", text: parts.map((p) => (p as { text: string }).text).join(""), quote: "double" };
      return { kind: "param", name: "", raw: this.src.slice(from, this.pos), quoted: true, scripts: scriptsIn(parts) };
    }
    if (next === "(" && this.src[this.pos + 2] === "(") {
      const save = this.pos;
      this.pos += 3;
      try {
        const raw = this.arithBody();
        if (readsAsCommands(raw)) throw new ShellSyntaxError(save, "not arithmetic");
        return { kind: "arith", raw, scripts: substitutionsIn(raw, this.depth + 1, this.budget) };
      } catch (error) {
        if (!(error instanceof ShellSyntaxError)) throw error;
        this.pos = save;
      }
    }
    if (next === "(") {
      this.pos += 2;
      const script = this.nested(() => this.script(new Set(), ")"));
      this.expect(")");
      return { kind: "command", script, raw: this.src.slice(from, this.pos), quoted };
    }
    if (next === "{") {
      this.pos += 2;
      const scripts: Script[] = [];
      let depth = 0;
      for (;;) {
        if (this.eof()) throw new ShellSyntaxError(from, "unterminated ${");
        const c = this.peek();
        if (c === "}" && depth === 0) {
          this.pos += 1;
          break;
        }
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        if (c === "\\") this.pos += 2;
        else if (c === "'" && !quoted) {
          const close = this.src.indexOf("'", this.pos + 1);
          if (close < 0) throw new ShellSyntaxError(this.pos, "unterminated '");
          this.pos = close + 1;
        } else if (c === '"') {
          this.pos += 1;
          scripts.push(...scriptsIn(this.doubleQuoted('"')));
        } else if (c === "$") {
          const part = this.dollar(true);
          if (part.kind !== "text") scripts.push(...scriptsIn([part]));
        } else if (c === "`") scripts.push(...scriptsIn([this.backtick(true)]));
        else this.pos += 1;
      }
      const raw = this.src.slice(from, this.pos);
      const name = /^\$\{[#!]?([A-Za-z_][A-Za-z0-9_]*|[@*#?$!0-9-])/.exec(raw)?.[1] ?? "";
      return { kind: "param", name, raw, quoted, scripts };
    }
    const name = NAME.exec(this.src.slice(this.pos + 1))?.[0] ?? (next && SPECIAL_PARAM.has(next) ? next : "");
    if (!name) {
      this.pos += 1;
      return { kind: "text", text: "$", quote: quoted ? "double" : "none" };
    }
    this.pos += 1 + name.length;
    return { kind: "param", name, raw: this.src.slice(from, this.pos), quoted, scripts: [] };
  }

  /** The value of `$'...'` with its escapes decoded; the opening `$'` is already read. */
  private ansi(): string {
    let out = "";
    for (;;) {
      if (this.eof()) throw new ShellSyntaxError(this.pos, "unterminated $'");
      const c = this.peek();
      if (c === "'") {
        this.pos += 1;
        return out;
      }
      if (c !== "\\") {
        out += c;
        this.pos += 1;
        continue;
      }
      const e = this.src[this.pos + 1] ?? "";
      this.pos += 2;
      if (e in ANSI_NAMED) out += ANSI_NAMED[e];
      else if (e === "c") {
        const ch = this.src[this.pos] ?? "";
        out += String.fromCharCode(ch.toUpperCase().charCodeAt(0) ^ 0x40);
        this.pos += 1;
      } else if (e === "x" || e === "u" || e === "U") {
        const max = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = /^[0-9a-fA-F]+/.exec(this.src.slice(this.pos, this.pos + max))?.[0] ?? "";
        if (!hex) out += `\\${e}`;
        else {
          const code = parseInt(hex, 16);
          out += code <= 0x10ffff ? String.fromCodePoint(code) : "";
          this.pos += hex.length;
        }
      } else if (/[0-7]/.test(e)) {
        const oct = e + (/^[0-7]{0,2}/.exec(this.src.slice(this.pos))?.[0] ?? "");
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        this.pos += oct.length - 1;
      } else out += `\\${e}`;
    }
  }

  backtick(quoted: boolean): Part {
    const from = this.pos;
    let inner = "";
    this.pos += 1;
    for (;;) {
      if (this.eof()) throw new ShellSyntaxError(from, "unterminated `");
      const c = this.peek();
      if (c === "`") {
        this.pos += 1;
        break;
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1] ?? "";
        inner += "$`\\".includes(next) || (quoted && next === '"') ? next : `\\${next}`;
        this.pos += 2;
        continue;
      }
      inner += c;
      this.pos += 1;
    }
    this.spend(inner.length);
    const script = parseScriptAt(inner, this.depth + 1, this.budget);
    return { kind: "command", script, raw: this.src.slice(from, this.pos), quoted };
  }

  /** Text with balanced parentheses, for extended globs such as `@(a|b)`. */
  private balanced(): string {
    const from = this.pos;
    this.pos += 2;
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const c = this.peek();
      if (c === "\\") this.pos += 1;
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      this.pos += 1;
    }
    if (depth > 0) throw new ShellSyntaxError(from, "unterminated pattern");
    return this.src.slice(from, this.pos);
  }

  private nested<T>(read: () => T): T {
    this.depth += 1;
    try {
      return read();
    } finally {
      this.depth -= 1;
    }
  }

  /** Blanks, line continuations and comments; newlines too when `lines` is set. */
  space(lines: boolean): void {
    for (;;) {
      this.blanks();
      if (lines && this.peek() === "\n") this.newline();
      else return;
    }
  }

  private blanks(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") this.pos += 1;
      else if (c === "\\" && this.src[this.pos + 1] === "\n") this.pos += 2;
      else if (c === "#") {
        const end = this.src.indexOf("\n", this.pos);
        this.pos = end < 0 ? this.src.length : end;
      } else return;
    }
  }

  /** Consumes a newline, then the bodies of the heredocs its line opened. */
  private newline(): void {
    this.pos += 1;
    const pending = this.pending.splice(0);
    for (const { heredoc } of pending) this.readBody(heredoc);
  }

  private readBody(heredoc: Heredoc): void {
    let body = "";
    while (!this.eof()) {
      const end = this.src.indexOf("\n", this.pos);
      const line = this.src.slice(this.pos, end < 0 ? this.src.length : end);
      this.pos = end < 0 ? this.src.length : end + 1;
      const content = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (content === heredoc.delimiter) {
        heredoc.terminated = true;
        break;
      }
      body += `${content}\n`;
    }
    heredoc.body = body;
    if (!heredoc.quoted) {
      const reader = new Parser(body, this.depth + 1, this.budget);
      heredoc.parts = reader.doubleQuoted(null);
    }
  }

  private reservedAhead(ends: ReadonlySet<string>): boolean {
    const bare = this.bareAhead();
    return bare !== null && ends.has(bare);
  }

  /** The next word when it is plain text that ends at a blank or operator; null otherwise. */
  private bareAhead(): string | null {
    const match = this.sticky(BARE);
    if (!match) return null;
    const after = this.src[this.pos + match[0].length];
    return after === undefined || WORD_END.has(after) ? match[0] : null;
  }

  /** A sticky pattern tried at the current position, without cutting the source. */
  private sticky(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.pos;
    return pattern.exec(this.src);
  }

  private expectWord(word: string): void {
    this.space(true);
    if (this.bareAhead() !== word) throw new ShellSyntaxError(this.pos, `expected ${word}`);
    this.pos += word.length;
  }

  private expect(c: string): void {
    this.blanks();
    if (this.peek() !== c) throw new ShellSyntaxError(this.pos, `expected ${c}`);
    this.pos += 1;
  }

  private at(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  /** What was read before a syntax error: the lists that ended before it. */
  partial(): Script {
    const out: Script = [];
    const copy = new Parser(this.src, this.depth, this.budget);
    try {
      for (;;) {
        copy.space(true);
        if (copy.eof()) return out;
        const sequence = copy.sequence();
        copy.blanks();
        const c = copy.peek();
        if (c !== ";" && c !== "&" && c !== "\n" && !copy.eof()) return out;
        if (c === "&") sequence.background = true;
        if (c === "\n") copy.newline();
        else if (!copy.eof()) copy.pos += 1;
        out.push(sequence);
      }
    } catch {
      return out;
    }
  }
}

/** `((rm -rf x))` is two subshells once it fails as arithmetic; a `;` or a flag says so. */
function readsAsCommands(raw: string): boolean {
  return /[;\n]/.test(raw) || /[A-Za-z_][\w.-]*\s+-{1,2}[A-Za-z]/.test(raw);
}

function tildeAllowed(parts: Part[], atStart: boolean): boolean {
  if (atStart) return true;
  const last = parts[parts.length - 1];
  if (last?.kind !== "text" || last.quote !== "none" || parts.length !== 1) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=([^=]*:)?$/.test(last.text);
}

/** The value word of `NAME=value`, as the parts after the `=`. */
function valueAfter(word: Word, cut: number): Word | null {
  if (word.raw.length === cut) return null;
  const parts: Part[] = [];
  let skip = cut;
  for (const part of word.parts) {
    if (skip > 0 && part.kind === "text" && part.quote === "none") {
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
  return { raw: word.raw.slice(cut), start: word.start + cut, end: word.end, parts };
}

function scriptsIn(parts: Part[]): Script[] {
  const out: Script[] = [];
  for (const part of parts) {
    if (part.kind === "command" || part.kind === "process") out.push(part.script);
    else if (part.kind === "param" || part.kind === "arith") out.push(...part.scripts);
  }
  return out;
}

/** The command substitutions inside text that is not shell, such as an arithmetic body. */
function substitutionsIn(text: string, depth: number, budget: { steps: number }): Script[] {
  if (depth > MAX_DEPTH) throw new ShellSyntaxError(0, "nested too deep");
  const reader = new Parser(text, depth, budget);
  const out: Script[] = [];
  while (reader.pos < text.length) {
    const c = text[reader.pos];
    if (c === "$" && text[reader.pos + 1] === "(") out.push(...scriptsIn([reader.dollar(true)]));
    else if (c === "`") out.push(...scriptsIn([reader.backtick(true)]));
    else reader.pos += 1;
  }
  return out;
}

function parseScriptAt(text: string, depth: number, budget: { steps: number }): Script {
  const parser = new Parser(text, depth, budget);
  return parser.script(new Set(), null);
}

/** A command line read whole, or as far as it goes before a syntax error. */
export function parseShell(text: string): Parsed {
  const parser = new Parser(text, 0);
  try {
    return { script: parser.script(new Set(), null), error: null };
  } catch (error) {
    if (error instanceof ShellLimitError) return { script: [], error: { at: 0, message: error.message, costly: true } };
    if (!(error instanceof ShellSyntaxError)) {
      if (error instanceof RangeError)
        return { script: parser.partial(), error: { at: 0, message: "nested too deep" } };
      throw error;
    }
    return { script: parser.partial(), error: { at: error.at, message: error.message } };
  }
}

/** A word's text when nothing in it waits for run time; tildes read as `~user`. */
function literalOf(parts: readonly Part[]): string | null {
  let out = "";
  for (const part of parts) {
    if (part.kind === "text") out += part.text;
    else if (part.kind === "tilde") out += `~${part.user}`;
    else return null;
  }
  return out;
}

export const literal = (word: Word): string | null => literalOf(word.parts);
