import table from "./workflow.json";

/** The orchestration in force, from shared/workflow.json: code asks a role's traits, never its name; the room's role is the first at home in the room. */

/** What a role is and does: how the setup screen shows it, and which behaviors the code gives its seats. */
export interface RoleTraits {
  label: string;
  profile: string;
  icon: string;
  count: string;
  job: string;
  home?: "room";
  models: "one" | "tiers";
  progress?: boolean;
  briefs?: boolean;
  briefed?: boolean;
  writes?: boolean;
  reviews?: boolean;
  decides?: ("room" | "project")[];
  rotate?: string;
  tableNote?: { one: string; several: string };
}

type Note = keyof typeof table.notes;

const TRAITS = table.roles as Record<string, RoleTraits>;
const NONE: RoleTraits = { label: "", profile: "", icon: "", count: "", job: "", models: "one" };

export const ROLES: readonly string[] = Object.keys(TRAITS);
export const ROOM_PROJECT: string = table.roomProject;
export const ROOM_ROLE: string | undefined = ROLES.find((role) => TRAITS[role].home === "room");
const ROUTES: Readonly<Record<string, boolean>> = table.routes;
export const SPAWN: Readonly<Record<string, readonly string[]>> = table.spawn;
export const RETIRED: readonly string[] = table.retired;
export const REVIEW_STALL: string = table.reviewers.stall;

/** Whether the workflow has a role of this name. */
export const isRole = (name: string): boolean => Object.hasOwn(TRAITS, name);
/** A role's traits; none at all for a name that is no role. */
export const traits = (role: string | undefined): RoleTraits =>
  role && Object.hasOwn(TRAITS, role) ? TRAITS[role] : NONE;
/** The roles whose traits satisfy `pick`, in the workflow's order. */
export const rolesWhere = (pick: (traits: RoleTraits) => unknown): string[] =>
  ROLES.filter((role) => pick(TRAITS[role]));

export const ROOTS: readonly string[] = (() => {
  const home = ROLES.filter((role) => TRAITS[role].home === "room");
  return home.length ? home : ROLES.filter((role) => !ROLES.some((parent) => (SPAWN[parent] ?? []).includes(role)));
})();

/** Whether a seat of this role sits above every project, in the room's own. */
export const inRoom = (role: string | undefined): boolean => traits(role).home === "room";
/** Whether mail goes from `from` to `to` by the route table. */
export const routeOpen = (from: string, to: string): boolean => ROUTES[`${from}>${to}`] === true;
/** Whether a role may create seats: such a seat owns the seats under it. */
export const owns = (role: string | undefined): boolean => (SPAWN[role ?? ""] ?? []).length > 0;
/** The roles a role creates without a specialization: the tree the setup screen draws. */
export const childrenOf = (role: string): string[] => (SPAWN[role] ?? []).filter((entry) => !entry.includes(":"));

/** Whether `parent` may create `child` with this title; a spawn entry is `role` or `role:spec`. */
export function maySpawn(parent: string, child: string, title: string | null | undefined): boolean {
  const allowed = SPAWN[parent] ?? [];
  if (allowed.includes(child)) return true;
  const spec = specFromTitle(title);
  return spec !== undefined && allowed.includes(`${child}:${spec}`);
}

/** `role:spec` from a title that opens with `[role:spec]`. */
export function specFromTitle(title: string | null | undefined): string | undefined {
  const m = /^\s*\[([a-z-]+):([a-z0-9-]+)\]/i.exec(title ?? "");
  return m && isRole(m[1].toLowerCase()) ? m[2].toLowerCase() : undefined;
}

const REVIEW_TITLE = new RegExp(table.reviewers.titles, "i");

/** A seat that reads and reports: by its role, its spec or its title. */
export function reviews(role: string, title: string | null | undefined): boolean {
  const spec = specFromTitle(title);
  return (
    traits(role).reviews === true ||
    (spec !== undefined && table.reviewers.specs.includes(spec)) ||
    REVIEW_TITLE.test(title ?? "")
  );
}

/** A text with its `{{name}}` placeholders filled from `vars`; one without a value stays as written. */
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));

/** One of the room's lines about a task's rounds, filled. */
export const note = (name: Note, vars: Record<string, string | number>): string => fill(table.notes[name], vars);

/** The line under a report past the rotation mark; null for a role that has none. */
export function rotateNote(role: string, held: string): string | null {
  const text = traits(role).rotate;
  return text ? fill(text, { held }) : null;
}

/** The line under a role's table of models in prompts, for one model or several. */
export function tableNote(role: string, models: number): string {
  const lines = traits(role).tableNote;
  return lines ? (models > 1 ? lines.several : lines.one) : "";
}
