import { absolute, valueOf } from "./paths";
import { stdinText } from "./programs";
import { literal, type Word } from "./shell";
import type { Known, Scene } from "./types";

/** The text a command writes to files, from the literals the line shows: a redirect of echo, printf or cat, tee's input, a copy of a file written earlier. */

/** A file a command writes and the text it gets. */
export interface Written {
  target: Word;
  text: string;
}

const operands = (words: Word[]): Word[] => words.filter((w) => !(literal(w) ?? "x").startsWith("-"));

/** Every file this command writes whose text is known. */
export function writtenTexts(scene: Scene, known: Known, written: ReadonlyMap<string, string>): Written[] {
  const name = scene.call.name;
  const args = scene.call.args;
  const out: Written[] = [];
  const redirect = scene.simple.redirects.find((r) => r.target && (r.op === ">" || r.op === ">>" || r.op === ">|"));
  const to = redirect?.target;
  if (name === "cat" && to) {
    const files = operands(args);
    const text = files.length
      ? files.length === 1
        ? written.get(absolute(valueOf(files[0], known), known.cwd) ?? "")
        : undefined
      : stdinText(scene, known, written);
    if (typeof text === "string") out.push({ target: to, text });
  } else if ((name === "echo" || name === "printf") && to && redirect!.op !== ">|") {
    const words = args.map((w) => valueOf(w, known).text);
    if (words.every((w) => w !== null))
      out.push({
        target: to,
        text: (words as string[]).filter((w, i) => !(i === 0 && /^-[neE]+$/.test(w))).join(" "),
      });
  } else if (name === "tee") {
    const text = stdinText(scene, known, written);
    if (typeof text === "string") for (const file of operands(args)) out.push({ target: file, text });
  } else if (name === "cp" || name === "mv") {
    const files = operands(args);
    if (files.length === 2) {
      const text = written.get(absolute(valueOf(files[0], known), known.cwd) ?? "");
      if (text !== undefined) out.push({ target: files[1], text });
    }
  }
  return out;
}
