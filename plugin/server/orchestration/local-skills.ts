import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { notEnglish } from "../english";
import { LOCAL_SKILLS_DIR, ROOM_DIR } from "../paths";
import { stamp } from "../gc";
import { ROLES } from "../../shared/workflow";

/** Skills the room's own seat adds for a role, beside the room's files so an update leaves them. */

const NAME = /^[a-z][a-z0-9-]{1,48}$/;
const FILE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.(md|txt)$/i;
const FILES_MOST = 16;
const BYTES_MOST = 64 * 1024;
const PROVENANCE = "provenance.json";

/** Where a skill came from: its license, and for one taken from elsewhere its repository and commit. */
export interface SkillSource {
  license: string;
  repo?: string;
  commit?: string;
}

/** A local skill as its record keeps it: the sha-256 of each file, its source, why it was added, by whom and when. */
export interface SkillRecord {
  files: Record<string, string>;
  source: SkillSource;
  why: string;
  by: string;
  at: string;
}

/** A refusal the adding seat can fix. */
export class SkillRefused extends Error {}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The records of every local skill, by `role/name`. */
function records(): Record<string, SkillRecord> {
  const file = join(LOCAL_SKILLS_DIR, PROVENANCE);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, SkillRecord>;
}

/** Writes the records whole, through a file beside them, so a crash leaves the old ones. */
function keep(all: Record<string, SkillRecord>): void {
  mkdirSync(LOCAL_SKILLS_DIR, { recursive: true });
  const file = join(LOCAL_SKILLS_DIR, PROVENANCE);
  writeFileSync(`${file}.next`, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(`${file}.next`, file);
}

/** The names of the skills the room ships, for every role. */
function shipped(): Set<string> {
  const dirs = [...ROLES, "shared"].map((role) => join(ROOM_DIR, "skills", role));
  return new Set(dirs.flatMap((dir) => (existsSync(dir) ? readdirNames(dir) : [])));
}

/** The folders of a directory that hold a SKILL.md. */
function readdirNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md")));
}

/** The local skills of a role, by name. */
export function localSkills(role: string): string[] {
  const dir = join(LOCAL_SKILLS_DIR, role);
  return existsSync(dir) ? readdirNames(dir).sort() : [];
}

/** The folder a role's local skills sit in. */
export const localSkillsOf = (role: string): string => join(LOCAL_SKILLS_DIR, role);

/** Adds or replaces a role's local skill; its files are checked first and its record kept. */
export function addSkill(input: {
  role: string;
  name: string;
  files: Record<string, string>;
  source: SkillSource;
  why: string;
  by: string;
}): { added: string; files: string[] } {
  const { role, name, files, source, why, by } = input;
  if (!(ROLES as readonly string[]).includes(role))
    throw new SkillRefused(`no role ${role}; roles: ${ROLES.join(", ")}`);
  if (!NAME.test(name))
    throw new SkillRefused("a skill's name is lowercase words joined by dashes, 2 to 49 characters");
  if (shipped().has(name)) throw new SkillRefused(`the room ships a skill named ${name}; choose another name`);
  const paths = Object.keys(files ?? {});
  if (!paths.includes("SKILL.md")) throw new SkillRefused("a skill has a SKILL.md");
  if (paths.length > FILES_MOST) throw new SkillRefused(`a skill has ${FILES_MOST} files at most`);
  const bad = paths.find((path) => !FILE.test(path) || path.split("/").includes(".."));
  if (bad) throw new SkillRefused(`${bad}: a skill holds .md and .txt files under its own folder, no scripts`);
  const bytes = paths.reduce((sum, path) => sum + Buffer.byteLength(String(files[path])), 0);
  if (bytes > BYTES_MOST)
    throw new SkillRefused(`a skill is ${BYTES_MOST / 1024} KB at most; this one is ${Math.ceil(bytes / 1024)} KB`);
  const head = /^---\n([\s\S]*?)\n---\n/.exec(String(files["SKILL.md"]));
  if (!head || !new RegExp(`^name:\\s*${name}\\s*$`, "m").test(head[1]) || !/^description:\s*\S/m.test(head[1]))
    throw new SkillRefused(`SKILL.md opens with front matter naming ${name} and its description`);
  for (const path of paths) {
    const why = notEnglish(String(files[path]));
    if (why) throw new SkillRefused(`${path} ${why}; a skill is written in English`);
  }
  if (!source?.license) throw new SkillRefused("source.license: the skill's license, or own for one you wrote");
  if (source.license !== "own" && (!source.repo || !source.commit))
    throw new SkillRefused("a skill taken from elsewhere names source.repo and source.commit");
  if (!why?.trim()) throw new SkillRefused("why: the failure the skill answers, in English");
  const folder = join(LOCAL_SKILLS_DIR, role, name);
  if (existsSync(folder)) setAside(role, name);
  for (const path of paths) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), String(files[path]));
  }
  const all = records();
  all[`${role}/${name}`] = {
    files: Object.fromEntries(paths.map((path) => [path, sha(String(files[path]))])),
    source,
    why: why.trim(),
    by,
    at: new Date().toISOString(),
  };
  keep(all);
  return { added: `${role}/${name}`, files: paths.sort() };
}

/** Moves a local skill to `removed/<stamp>/`, where GC clears it after its keep. */
function setAside(role: string, name: string): void {
  const to = join(LOCAL_SKILLS_DIR, "removed", stamp(), role, name);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(join(LOCAL_SKILLS_DIR, role, name), to);
}

/** Takes a role's local skill out; it is set aside, not deleted. */
export function removeSkill(role: string, name: string): { removed: string } {
  const all = records();
  if (!all[`${role}/${name}`] || !existsSync(join(LOCAL_SKILLS_DIR, role, name)))
    throw new SkillRefused(`no local skill ${role}/${name}`);
  setAside(role, name);
  delete all[`${role}/${name}`];
  keep(all);
  return { removed: `${role}/${name}` };
}

/** Every local skill with its record, and whether its files are still the ones recorded. */
export function listSkills(): (SkillRecord & { skill: string; intact: boolean })[] {
  return Object.entries(records()).map(([skill, record]) => ({
    skill,
    ...record,
    intact: Object.entries(record.files).every(([path, hash]) => {
      const file = join(LOCAL_SKILLS_DIR, skill, path);
      return existsSync(file) && sha(readFileSync(file, "utf8")) === hash;
    }),
  }));
}
