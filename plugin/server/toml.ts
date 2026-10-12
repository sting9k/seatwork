/**
 * Enough TOML to edit a config file. Tables become one tree however they are
 * spelled (headers, array tables, dotted keys, inline tables); every other
 * value is kept exactly as written. Comments are not kept.
 */

/** A value as written (`"x"`, `[1, 2]`, `true`), a table, or an array of tables. */
type TomlValue = string | TomlTable | TomlTable[];
export type TomlTable = Map<string, TomlValue>;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function parseToml(text: string): TomlTable {
  const root: TomlTable = new Map();
  const end = text.length;
  let at = 0;

  const fail = (what: string): never => {
    throw new Error(`line ${text.slice(0, at).split("\n").length}: ${what}`);
  };
  const skipBlanks = () => {
    while (text[at] === " " || text[at] === "\t") at += 1;
  };
  const skipComment = () => {
    while (at < end && text[at] !== "\n") at += 1;
  };
  /** Everything that may sit between two lines, two array items or two inline pairs. */
  const skipGap = () => {
    for (;;) {
      skipBlanks();
      if (text[at] === "#") skipComment();
      else if (text[at] === "\n" || text[at] === "\r") at += 1;
      else return;
    }
  };

  const skipString = () => {
    const quote = text[at];
    const long = text.startsWith(quote.repeat(3), at);
    at += long ? 3 : 1;
    while (long ? !text.startsWith(quote.repeat(3), at) : text[at] !== quote) {
      if (at >= end || (!long && text[at] === "\n")) fail("a string is not closed");
      at += quote === '"' && text[at] === "\\" ? 2 : 1;
    }
    at += long ? 3 : 1;
    if (long) while (text[at] === quote) at += 1; // a long string may end in one or two quotes of its own
  };

  /** One key. A quoted key that needs no quotes is stored bare, so `"a"` and `a` are one key. */
  const readKey = (): string => {
    const start = at;
    if (text[at] === '"' || text[at] === "'") {
      skipString();
      const inner = text.slice(start + 1, at - 1);
      return BARE_KEY.test(inner) ? inner : text.slice(start, at);
    }
    while (at < end && BARE_KEY.test(text[at])) at += 1;
    if (at === start) fail("a key is expected");
    return text.slice(start, at);
  };
  const readPath = (): string[] => {
    const path: string[] = [];
    for (;;) {
      skipBlanks();
      path.push(readKey());
      skipBlanks();
      if (text[at] !== ".") return path;
      at += 1;
    }
  };

  /** The table at `path` under `from`, made on the way. An array of tables stands for its last table. */
  const tableAt = (from: TomlTable, path: string[]): TomlTable => {
    let table = from;
    for (const key of path) {
      let next = table.get(key);
      if (next === undefined) table.set(key, (next = new Map()));
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next === "string") return fail(`${key} is a value, not a table`);
      table = next;
    }
    return table;
  };

  const readPair = (into: TomlTable) => {
    const path = readPath();
    if (text[at] !== "=") fail("= is expected");
    at += 1;
    skipBlanks();
    tableAt(into, path.slice(0, -1)).set(path[path.length - 1], readValue());
  };

  const readValue = (): TomlValue => {
    if (text[at] === "{") {
      at += 1;
      const table: TomlTable = new Map();
      for (skipGap(); text[at] !== "}"; skipGap()) {
        if (at >= end) fail("an inline table is not closed");
        readPair(table);
        skipGap();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "}") fail(", or } is expected");
      }
      at += 1;
      return table;
    }
    const start = at;
    if (text[at] === "[") {
      // an array is kept as written; only where it ends matters
      let depth = 0;
      do {
        if (at >= end) fail("an array is not closed");
        const char = text[at];
        if (char === '"' || char === "'") skipString();
        else if (char === "#") skipComment();
        else {
          if (char === "[" || char === "{") depth += 1;
          if (char === "]" || char === "}") depth -= 1;
          at += 1;
        }
      } while (depth > 0);
    } else if (text[at] === '"' || text[at] === "'") {
      skipString();
    } else {
      // a number, a boolean or a date (a date may hold a space)
      while (at < end && !"\n\r#,}".includes(text[at])) at += 1;
      while (at > start && (text[at - 1] === " " || text[at - 1] === "\t")) at -= 1;
    }
    if (at === start) fail("a value is expected");
    return text.slice(start, at);
  };

  let table = root;
  for (skipGap(); at < end; skipGap()) {
    if (text[at] === "[") {
      const array = text[at + 1] === "[";
      const close = array ? "]]" : "]";
      at += close.length;
      const path = readPath();
      if (!text.startsWith(close, at)) fail(`${close} is expected`);
      at += close.length;
      const parent = tableAt(root, path.slice(0, -1));
      const key = path[path.length - 1];
      if (array) {
        const list = parent.get(key) ?? [];
        if (!Array.isArray(list)) return fail(`${key} is not an array of tables`);
        list.push((table = new Map()));
        parent.set(key, list);
      } else {
        table = tableAt(parent, [key]);
      }
    } else {
      readPair(table);
    }
    skipBlanks();
    if (at < end && !"#\n\r".includes(text[at])) fail("the line goes on after its value");
  }
  return root;
}

/** The tree as TOML: in each table its own values first, then its tables under `[a.b]` and `[[a.b]]` headers. */
export function formatToml(root: TomlTable): string {
  const lines: string[] = [];
  const write = (table: TomlTable, path: string[]) => {
    for (const [key, value] of table) if (typeof value === "string") lines.push(`${key} = ${value}`);
    for (const [key, value] of table) {
      if (typeof value === "string") continue;
      const name = [...path, key].join(".");
      for (const item of Array.isArray(value) ? value : [value]) {
        lines.push("", Array.isArray(value) ? `[[${name}]]` : `[${name}]`);
        write(item, [...path, key]);
      }
    }
  };
  write(root, []);
  return `${lines.join("\n").trim()}\n`;
}
