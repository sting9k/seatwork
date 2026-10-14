import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** A JSON file the room keeps across restarts: unreadable or absent, it starts as `empty`. */
export function readJson<T>(file: string, empty: T): T {
  if (!existsSync(file)) return empty;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return empty;
  }
}

/** Writes the whole file by a rename: a reader sees the old one or the new one. */
export function writeJson(file: string, value: unknown, mode?: number): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 1)}\n`, mode === undefined ? {} : { mode });
  renameSync(`${file}.tmp`, file);
}
