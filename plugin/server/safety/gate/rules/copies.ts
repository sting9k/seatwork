import { posix } from "node:path";
import { sensitive, tempPath, valueOf } from "../paths";
import { literal } from "../shell";
import type { Scene } from "../types";

/** A sensitive tree copied into temp, then removed there: each step passes alone, the pair does not. */
export class CopyTrail {
  private readonly copies: { rule: string; dest: string; text: string }[] = [];

  /** Notes a `cp -a`, `ln -s` or `rsync -a` from a sensitive path into temp. */
  note(scene: Scene): void {
    const name = scene.call.name;
    const texts = scene.call.args.map(literal);
    const archive = texts.some((t) => t === "--archive" || (t !== null && /^-[a-zA-Z]*a/.test(t)));
    const rule =
      name === "cp" && archive
        ? "cp-sensitive-then-delete"
        : name === "ln" && texts.some((t) => t !== null && /^-[a-zA-Z]*s/.test(t))
          ? "ln-symlink-sensitive-then-delete"
          : name === "rsync" && archive
            ? "rsync-sensitive-then-delete"
            : null;
    if (!rule) return;
    const files = scene.call.args.filter((_, i) => !(texts[i] ?? "x").startsWith("-")).map((w) => valueOf(w, scene));
    if (files.length < 2) return;
    const dest = files[files.length - 1];
    if (!dest.text || !tempPath(dest.text)) return;
    if (files.slice(0, -1).some((v) => sensitive(v, scene, false)))
      this.copies.push({ rule, dest: posix.normalize(dest.text), text: scene.text });
  }

  /** The noted copies that a recursive `rm` on this line removes, with the text to report for each. */
  removed(scene: Scene): { rule: string; text: string }[] {
    if (!this.copies.length) return [];
    const texts = scene.call.args.map(literal);
    if (!texts.some((t) => t !== null && (/^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive"))) return [];
    const out: { rule: string; text: string }[] = [];
    for (const w of scene.call.args) {
      const v = valueOf(w, scene).text;
      if (!v || !tempPath(v)) continue;
      const path = posix.normalize(v);
      const copy = this.copies.find(
        (c) => path === c.dest || path.startsWith(`${c.dest}/`) || c.dest.startsWith(`${path}/`),
      );
      if (copy) out.push({ rule: copy.rule, text: `${copy.text}; ${scene.text}` });
    }
    return out;
  }
}
