import { posix } from "node:path";

/** Glob tests that read a text once, left to right, so no pattern or path can make them backtrack. */

export type GlobTest = (text: string) => boolean;

type Token =
  | { kind: "lit"; text: string }
  | { kind: "one" }
  | { kind: "set"; test: RegExp }
  | { kind: "alt"; options: string[] }
  | { kind: "run"; across: boolean };

const PATTERN_CHARS = 1000;

/** True when the tokens span the whole text, or in `tree` mode the text up to a `/` or its end. */
function spans(tokens: readonly Token[], text: string, tree: boolean): boolean {
  const end = text.length;
  let now = new Uint8Array(end + 1);
  now[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(end + 1);
    let live = false;
    if (token.kind === "run") {
      let on = false;
      for (let at = 0; at <= end; at += 1) {
        if (now[at]) on = true;
        if (on) {
          next[at] = 1;
          live = true;
        }
        if (!token.across && text[at] === "/") on = false;
      }
    } else {
      for (let at = 0; at <= end; at += 1) {
        if (!now[at]) continue;
        if (token.kind === "one" || token.kind === "set") {
          if (at < end && (token.kind === "one" || token.test.test(text[at]))) next[at + 1] = 1;
        } else if (token.kind === "lit") {
          if (text.startsWith(token.text, at)) next[at + token.text.length] = 1;
        } else {
          for (const option of token.options) if (text.startsWith(option, at)) next[at + option.length] = 1;
        }
      }
      live = next.includes(1);
    }
    if (!live) return false;
    now = next;
  }
  if (!tree) return now[end] === 1;
  for (let at = 0; at <= end; at += 1) if (now[at] && (at === end || text[at] === "/")) return true;
  return false;
}

/** A shell pattern for one name: `*`, `?`, `[set]`, `{a,b}`, case ignored; one it cannot read matches any name. */
export function componentGlob(pattern: string): GlobTest {
  if (pattern.length > PATTERN_CHARS) return () => true;
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "lit", text: text.toLowerCase() });
    text = "";
  };
  try {
    for (let i = 0; i < pattern.length; i += 1) {
      const c = pattern[i];
      const close = c === "[" ? pattern.indexOf("]", i + 1) : c === "{" ? pattern.indexOf("}", i + 1) : -1;
      if (c === "*") {
        flush();
        if (tokens[tokens.length - 1]?.kind !== "run") tokens.push({ kind: "run", across: true });
      } else if (c === "?") {
        flush();
        tokens.push({ kind: "one" });
      } else if (c === "[" && close >= 0) {
        flush();
        const set = pattern
          .slice(i + 1, close)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        tokens.push({ kind: "set", test: new RegExp(`^[${set}]$`, "i") });
        i = close;
      } else if (c === "{" && close >= 0) {
        flush();
        tokens.push({
          kind: "alt",
          options: pattern
            .slice(i + 1, close)
            .toLowerCase()
            .split(","),
        });
        i = close;
      } else text += c;
    }
  } catch {
    // a range out of order, or anything else bash may read its own way
    return () => true;
  }
  flush();
  return (name) => spans(tokens, name.toLowerCase(), false);
}

/** An owner's path glob: `*` stays in one folder, `**` crosses folders; it holds for a path and everything under it. */
export function treeGlob(glob: string, home: string): GlobTest {
  const tokens: Token[] = [];
  const expanded = glob.startsWith("~/") ? posix.join(home, glob.slice(2)) : glob;
  const add = (token: Token) => {
    const last = tokens[tokens.length - 1];
    if (token.kind === "run" && last?.kind === "run") last.across = last.across || token.across;
    else tokens.push(token);
  };
  expanded.split("**").forEach((piece, i) => {
    if (i > 0) add({ kind: "run", across: true });
    piece.split("*").forEach((text, j) => {
      if (j > 0) add({ kind: "run", across: false });
      if (text) add({ kind: "lit", text });
    });
  });
  return (path) => spans(tokens, path, true);
}
