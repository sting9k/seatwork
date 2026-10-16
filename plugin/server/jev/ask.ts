import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DecisionError, isRecord, type Answer, type Questions } from "./contract";
import type { Jev } from "./index";

/** A seat's question about files it need not read itself: the room reads them, the decision model answers, the seat gets the probabilities. */

const ROOM_FOLDER = ".seatwork";
const ASK = {
  paths: 20,
  stateChars: 8000,
  fileBytes: 256 * 1024,
  partChars: 6000,
  totalChars: 120_000,
  sniffBytes: 8192,
};

/** A call the seat can fix: what is wrong with its question. */
export class AskRefused extends Error {
  readonly code = "BAD_REQUEST";
  readonly retryable = false;
}

/** What a seat gets back: the answers, the model, the files read and those skipped with why, and the cost. */
export interface AskAnswer {
  answers: Record<string, Answer>;
  model: string;
  read: string[];
  skipped: { path: string; why: string }[];
  usd: number | null;
  cached: boolean;
}

/** The first bytes of a file hold a NUL: it is no text. */
function binary(file: string): boolean {
  const handle = openSync(file, "r");
  try {
    const head = Buffer.alloc(ASK.sniffBytes);
    const got = readSync(handle, head, 0, head.length, 0);
    return head.subarray(0, got).includes(0);
  } finally {
    closeSync(handle);
  }
}

/** A text cut at line ends into parts of at most `most` characters. */
function parts(text: string, most: number): string[] {
  const out: string[] = [];
  let part = "";
  for (const line of text.split(/(?<=\n)/)) {
    for (let at = 0; at < line.length; at += most) {
      const piece = line.slice(at, at + most);
      if (part.length + piece.length > most) {
        out.push(part);
        part = "";
      }
      part += piece;
    }
  }
  if (part || out.length === 0) out.push(part);
  return out;
}

/** The files a seat names, read inside its project: each a text file of bounded size, in parts the decision model takes whole. */
function readFiles(
  paths: readonly string[],
  root: string,
  cwd: string,
): { files: Record<string, string>; read: string[]; skipped: { path: string; why: string }[] } {
  const files: Record<string, string> = {};
  const read: string[] = [];
  const skipped: { path: string; why: string }[] = [];
  const home = realpathSync.native(root);
  let total = 0;
  for (const path of paths) {
    let real: string;
    try {
      real = realpathSync.native(isAbsolute(path) ? path : resolve(cwd, path));
    } catch {
      skipped.push({ path, why: "no such file" });
      continue;
    }
    const inside = relative(home, real);
    const steps = inside.split(sep);
    if (inside.startsWith("..") || isAbsolute(inside) || steps.includes(".git") || steps[0] === ROOM_FOLDER) {
      skipped.push({ path, why: "outside the project, or in its .git or the room's folder" });
      continue;
    }
    const stat = statSync(real);
    if (!stat.isFile()) {
      skipped.push({ path, why: "not a file" });
      continue;
    }
    if (stat.size > ASK.fileBytes) {
      skipped.push({ path, why: `${stat.size} bytes; ${ASK.fileBytes} at most` });
      continue;
    }
    if (binary(real)) {
      skipped.push({ path, why: "not text" });
      continue;
    }
    const text = readFileSync(real, "utf8");
    total += text.length;
    if (total > ASK.totalChars)
      throw new AskRefused(`the files come to more than ${ASK.totalChars} characters: ask about fewer at a time`);
    const pieces = parts(text, ASK.partChars);
    pieces.forEach((piece, at) => (files[pieces.length === 1 ? inside : `${inside}#${at + 1}`] = piece));
    read.push(inside);
  }
  return { files, read, skipped };
}

/** Asks the decision model a seat's typed questions about its note and the files it names, as `caller`. */
export async function askJev(
  jev: Pick<Jev, "decide">,
  caller: string,
  args: Record<string, unknown>,
  place: { root: string; cwd: string },
): Promise<AskAnswer> {
  if (!isRecord(args.questions)) throw new AskRefused("`questions` is an object of typed questions by id");
  const note = args.state === undefined ? "" : typeof args.state === "string" ? args.state : JSON.stringify(args.state);
  if (note.length > ASK.stateChars)
    throw new AskRefused(`\`state\` is ${note.length} characters; ${ASK.stateChars} at most: name files instead`);
  const paths = args.paths === undefined ? [] : args.paths;
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
    throw new AskRefused("`paths` is a list of file paths");
  if (paths.length > ASK.paths) throw new AskRefused(`\`paths\` names ${paths.length} files; ${ASK.paths} at most`);
  if (!note.trim() && paths.length === 0)
    throw new AskRefused("give `state`, `paths`, or both: what the questions are about");
  const { files, read, skipped } = readFiles(paths as string[], place.root, place.cwd);
  if (paths.length > 0 && read.length === 0 && !note.trim())
    throw new AskRefused(`no file could be read: ${skipped.map((one) => `${one.path} (${one.why})`).join(", ")}`);
  const decision = await jev.decide(
    caller,
    { ...(note.trim() ? { note } : {}), ...(read.length ? { files } : {}) },
    args.questions as Questions,
  );
  return {
    answers: decision.answers,
    model: decision.model,
    read,
    skipped,
    usd: decision.usd,
    cached: decision.cached,
  };
}

/** Whether a decision that failed may pass if asked again soon. */
export const retryable = (error: DecisionError): boolean => ["TIMEOUT", "NETWORK", "DOWN", "BUSY"].includes(error.code);
