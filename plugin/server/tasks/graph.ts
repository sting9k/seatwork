import config from "../../shared/work.json";
import { CHILD_OPEN, PARENT_BLOCKED, refIssue, type Dependency, type Issue } from "./store";

/** A project's open issues as a graph: what to do next, what runs side by side, what blocks. */

/** `ready` and `blocked` come from the store: the graph judges no issue's way itself. */
export interface Work {
  issues: readonly Issue[];
  dependencies: readonly Dependency[];
  ready: ReadonlySet<string>;
  blocked: ReadonlyMap<string, readonly string[]>;
}

const {
  weights,
  urgentLabels,
  impactShare,
  unblockBoost,
  readyBoost,
  exactBetweennessUpTo,
  sampledSources,
  overlapsShown,
  overlapsCounted,
} = config.triage;
const URGENT = new Set(urgentLabels);

/** Open issues by number: blockers[i] is what i waits for, dependents[i] what waits for i, parent[i] its parent. */
interface Graph {
  issues: Issue[];
  at: Map<string, number>;
  blockers: number[][];
  dependents: number[][];
  parent: Int32Array;
}

/** The open issues numbered, with the edges that block among them in both directions and each issue's parent. */
function build({ issues, dependencies }: Work): Graph {
  const open = issues.filter((issue) => issue.status !== "closed");
  const n = open.length;
  const at = new Map(open.map((issue, index) => [issue.id, index]));
  const blockers: number[][] = Array.from({ length: n }, () => []);
  const dependents: number[][] = Array.from({ length: n }, () => []);
  const parent = new Int32Array(n).fill(-1);
  for (const dep of dependencies) {
    const [from, to] = [at.get(dep.issue_id), at.get(dep.depends_on_id)];
    if (from === undefined || to === undefined) continue;
    if (dep.type === "parent-child") parent[from] = to;
    if (dep.type !== "blocks") continue;
    blockers[from].push(to);
    dependents[to].push(from);
  }
  return { issues: open, at, blockers, dependents, parent };
}

/** A blocker ref of br's that only holds an issue back from `ready`, never from being started. */
const holdsOnly = (ref: string) => ref.endsWith(PARENT_BLOCKED) || ref.endsWith(CHILD_OPEN);

/** PageRank by power iteration: rank flows from an issue to what it waits for. */
function pagerank(graph: Graph): Float64Array {
  const n = graph.issues.length;
  let rank = new Float64Array(n).fill(1 / Math.max(1, n));
  for (let round = 0; round < 100; round += 1) {
    let dangling = 0;
    for (let i = 0; i < n; i += 1) if (graph.blockers[i].length === 0) dangling += rank[i];
    const next = new Float64Array(n).fill(0.15 / n + (0.85 * dangling) / n);
    for (let i = 0; i < n; i += 1) {
      const share = (0.85 * rank[i]) / graph.blockers[i].length;
      for (const target of graph.blockers[i]) next[target] += share;
    }
    let moved = 0;
    for (let i = 0; i < n; i += 1) moved += Math.abs(next[i] - rank[i]);
    rank = next;
    if (moved < 1e-6) break;
  }
  return rank;
}

/** Brandes' betweenness: how often an issue lies between two others; sampled when large. */
function betweenness(graph: Graph): Float64Array {
  const n = graph.issues.length;
  const score = new Float64Array(n);
  const step = n > exactBetweennessUpTo ? Math.ceil(n / sampledSources) : 1;
  const [order, far, paths, share] = [new Int32Array(n), new Int32Array(n), new Float64Array(n), new Float64Array(n)];
  const before: number[][] = Array.from({ length: n }, () => []);
  for (let source = 0; source < n; source += step) {
    far.fill(-1);
    paths.fill(0);
    share.fill(0);
    for (const list of before) list.length = 0;
    far[source] = 0;
    paths[source] = 1;
    order[0] = source;
    let tail = 1;
    for (let head = 0; head < tail; head += 1) {
      const node = order[head];
      for (const next of graph.dependents[node]) {
        if (far[next] < 0) {
          far[next] = far[node] + 1;
          order[tail++] = next;
        }
        if (far[next] === far[node] + 1) {
          paths[next] += paths[node];
          before[next].push(node);
        }
      }
    }
    for (let i = tail - 1; i > 0; i -= 1) {
      const node = order[i];
      for (const prior of before[node]) share[prior] += (paths[prior] / paths[node]) * (1 + share[node]);
      score[node] += share[node] * step;
    }
  }
  return score;
}

/** Per issue, 1 plus the longest chain waiting behind it (1 for an issue on a ring): Kahn's order, then one pass. */
function depths(graph: Graph): Int32Array {
  const n = graph.issues.length;
  const waiting = Int32Array.from(graph.blockers, (list) => list.length);
  const order = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i += 1) if (waiting[i] === 0) order[tail++] = i;
  for (let head = 0; head < tail; head += 1)
    for (const next of graph.dependents[order[head]]) if ((waiting[next] -= 1) === 0) order[tail++] = next;
  const depth = new Int32Array(n).fill(1);
  for (let i = tail - 1; i >= 0; i -= 1) {
    const node = order[i];
    for (const next of graph.dependents[node]) depth[node] = Math.max(depth[node], 1 + depth[next]);
  }
  return depth;
}

/** For each issue, the issues nothing would hold back once it closed: those it alone holds; one pass over what is blocked. */
function freedByEach(work: Work, graph: Graph): number[][] {
  const freed: number[][] = graph.issues.map(() => []);
  for (const [other, refs] of work.blocked) {
    const at = graph.at.get(other);
    if (at === undefined || refs.length === 0) continue;
    const holder = refIssue(refs[0]);
    if (!refs.every((ref) => refIssue(ref) === holder)) continue;
    const by = graph.at.get(holder);
    if (by !== undefined) freed[by].push(at);
  }
  return freed;
}

/** The largest of the values, 0 when none is above it; a loop, since a spread of many thousand values overflows the call stack. */
const peak = (values: ArrayLike<number>) => {
  let top = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] > top) top = values[i];
  return top;
};

/** An open issue with its score, the reasons for it and what it frees. */
interface Scored {
  id: string;
  title: string;
  status: string;
  priority: number;
  assignee: string | null;
  score: number;
  reasons: string[];
  unblocks: string[];
  blocked_by: string[];
  ready: boolean;
  claimable: boolean;
}

/** Every open issue scored: its weight in the work, what closing it frees, whether it is ready. */
function scoreAll(work: Work, now: Date): { graph: Graph; scored: Scored[] } {
  const graph = build(work);
  const n = graph.issues.length;
  const [rank, bridge, depth] = [pagerank(graph), betweenness(graph), depths(graph)];
  const [topRank, topBridge] = [peak(rank), peak(bridge)];
  const freed = freedByEach(work, graph);
  const mostHeld = Math.max(1, peak(graph.dependents.map((list) => list.length)));
  const mostFreed = Math.max(5, peak(freed.map((list) => list.length)));
  const scored: Scored[] = [];
  for (let i = 0; i < n; i += 1) {
    const issue = graph.issues[i];
    const held = graph.dependents[i].length;
    const ready = work.ready.has(issue.id);
    const days = Math.max(0, (now.getTime() - Date.parse(issue.updated_at)) / 86_400_000);
    const impact =
      weights.pagerank * (topRank > 0 ? rank[i] / topRank : 0) +
      weights.betweenness * (topBridge > 0 ? bridge[i] / topBridge : 0) +
      weights.blocks * (held / mostHeld) +
      weights.priority * ((4 - issue.priority) / 4) +
      weights.depth * Math.min(1, (depth[i] - 1) / 10) +
      weights.urgency * (issue.labels.some((label) => URGENT.has(label.toLowerCase())) ? 1 : 0) +
      weights.staleness * Math.min(1, days / 30);
    const score = impactShare * impact + (freed[i].length / mostFreed) * unblockBoost + (ready ? readyBoost : 0);
    const frees = freed[i].map((index) => graph.issues[index].id);
    scored.push({
      id: issue.id,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assignee: issue.assignee,
      score: Math.round(score * 1000) / 1000,
      reasons: [
        ...(ready ? ["nothing is in its way"] : []),
        ...(frees.length > 0 ? [`closing it frees ${frees.length}: ${frees.slice(0, 3).join(", ")}`] : []),
        ...(held > frees.length ? [`${held} issue${held === 1 ? "" : "s"} wait for it`] : []),
        ...(depth[i] > 2 ? [`a chain of ${depth[i] - 1} waits behind it`] : []),
        ...(issue.priority <= 1 ? [`priority ${issue.priority}`] : []),
      ],
      unblocks: frees,
      blocked_by: [...(work.blocked.get(issue.id) ?? [])],
      ready,
      claimable: ready && !issue.assignee && issue.issue_type !== "epic",
    });
  }
  scored.sort((a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id));
  return { graph, scored };
}

/** The issues to act on: those ready, and those in progress that nothing but a parent or a child holds back. */
const actionable = (scored: readonly Scored[]) =>
  scored.filter((one) => one.ready || (one.status === "in_progress" && one.blocked_by.every(holdsOnly)));

/** What triage answers: the counts, the issues to do first and the blockers to clear first. */
interface Triage {
  counts: { open: number; ready: number; blocked: number; in_progress: number };
  recommendations: Scored[];
  blockers_to_clear: { id: string; title: string; holds_up: number; assignee: string | null; status: string }[];
}

/** The issues worth doing first, scored, and the blockers worth clearing first. */
export function triage(work: Work, now: Date, limit = 10): Triage {
  const { graph, scored } = scoreAll(work, now);
  const holds = (one: Scored) => graph.dependents[graph.at.get(one.id)!].length;
  return {
    counts: {
      open: scored.length,
      ready: scored.filter((one) => one.ready).length,
      blocked: scored.filter((one) => one.blocked_by.some((ref) => !ref.endsWith(CHILD_OPEN))).length,
      in_progress: scored.filter((one) => one.status === "in_progress").length,
    },
    recommendations: actionable(scored).slice(0, limit),
    blockers_to_clear: scored
      .filter((one) => holds(one) > 0)
      .sort((a, b) => holds(b) - holds(a) || b.score - a.score)
      .slice(0, 5)
      .map((one) => ({
        id: one.id,
        title: one.title,
        holds_up: holds(one),
        assignee: one.assignee,
        status: one.status,
      })),
  };
}

/** The one issue to take now, or null; a pick reserves nothing, the claim does. */
export function next(work: Work, now: Date): Scored | null {
  return scoreAll(work, now).scored.find((one) => one.claimable) ?? null;
}

const FILE_NAME = /^[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]*$/;

/** The paths a write scope names, `./` and line numbers dropped; a glob counts from its folder; a word with no folder is a path when it reads as a file name. */
const scopeOf = (issue: Issue) =>
  issue.write_scope
    .split(/[\s,;]+/)
    .map((token) =>
      token
        .replace(/^[`'"(]+|[`'"),.:;]+$/g, "")
        .replace(/^\.\//, "")
        .replace(/:\d+(?::\d+)?$/, ""),
    )
    .filter((token) => token.includes("/") || FILE_NAME.test(token))
    .map((token) => (/[*?[{]/.test(token) ? token.replace(/\/?[^/]*[*?[{].*$/, "") : token.replace(/\/+$/, "")))
    .filter((token) => /[A-Za-z0-9]/.test(token));

/** Pairs of issues whose write scopes share a path or hold one inside the other: the `overlapsShown` sharing most paths, and how many more there are, counted up to `overlapsCounted` pairs (`cut` once a pair went uncounted). */
function collisions(issues: readonly Issue[]): { listed: Plan["overlaps"]; more: number; cut: boolean } {
  const n = issues.length;
  const scopes = issues.map(scopeOf);
  const owners = new Map<string, number[]>();
  scopes.forEach((paths, i) => {
    for (const path of paths) {
      const list = owners.get(path);
      if (!list) owners.set(path, [i]);
      else if (list.at(-1) !== i) list.push(i);
    }
  });
  const pairs = new Map<number, Set<string>>();
  let cut = false;
  counting: for (const [i, paths] of scopes.entries())
    for (const path of paths)
      for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
        const outer = path.slice(0, end);
        for (const j of owners.get(outer) ?? []) {
          if (j === i) continue;
          const key = i < j ? i * n + j : j * n + i;
          const shared = pairs.get(key);
          if (shared) shared.add(outer);
          else if (pairs.size < overlapsCounted) pairs.set(key, new Set([outer]));
          else {
            cut = true;
            break counting;
          }
        }
      }
  const best: { label: string; a: string; b: string; paths: Set<string> }[] = [];
  const first = (x: (typeof best)[number], y: (typeof best)[number]) =>
    y.paths.size - x.paths.size || x.label.localeCompare(y.label);
  for (const [key, paths] of pairs) {
    const [one, other] = [issues[Math.floor(key / n)].id, issues[key % n].id];
    const [a, b] = one < other ? [one, other] : [other, one];
    const pair = { label: `${a}|${b}`, a, b, paths };
    if (best.length === overlapsShown && first(pair, best[best.length - 1]) >= 0) continue;
    let at = best.length;
    while (at > 0 && first(pair, best[at - 1]) < 0) at -= 1;
    best.splice(at, 0, pair);
    if (best.length > overlapsShown) best.pop();
  }
  return {
    listed: best.map(({ a, b, paths }) => ({ a, b, paths: [...paths].sort() })),
    more: pairs.size - best.length,
    cut,
  };
}

/** What a plan answers: the tracks that can run side by side, the counts and the scopes that collide; `moreOverlaps` counts the pairs left unlisted, absent when none is, and is a floor where `overlapsCut` is set. */
export interface Plan {
  tracks: {
    track: string;
    items: { id: string; title: string; priority: number; status: string; unblocks: string[] }[];
  }[];
  ready: number;
  blocked: number;
  overlaps: { a: string; b: string; paths: string[]; read?: string }[];
  moreOverlaps?: number;
  overlapsCut?: true;
}

/** Pairs of a plan's issues whose overlap no path can tell, one side's scope naming none (a prose scope pairs with each later issue, a path scope with the later prose ones); none when there are more than `most`. */
export function unreadScopes(
  work: Work,
  plan: Plan,
  most: number,
): { a: string; b: string; scopes: [string, string] }[] {
  const byId = new Map(work.issues.map((issue) => [issue.id, issue]));
  const planned = plan.tracks
    .flatMap((track) => track.items.map((item) => byId.get(item.id)!))
    .filter((issue) => issue.write_scope.trim());
  const prose = planned.flatMap((issue, index) => (scopeOf(issue).length === 0 ? [index] : []));
  const isProse = new Set(prose);
  const pairs: { a: string; b: string; scopes: [string, string] }[] = [];
  const pair = (i: number, j: number): boolean => {
    if (pairs.length === most) return false;
    pairs.push({ a: planned[i].id, b: planned[j].id, scopes: [planned[i].write_scope, planned[j].write_scope] });
    return true;
  };
  let later = 0;
  for (let i = 0; i < planned.length; i += 1) {
    while (later < prose.length && prose[later] <= i) later += 1;
    if (isProse.has(i)) {
      for (let j = i + 1; j < planned.length; j += 1) if (!pair(i, j)) return [];
    } else for (let k = later; k < prose.length; k += 1) if (!pair(i, prose[k])) return [];
  }
  return pairs;
}

/** Groups no dependency joins (found by union-find), which can run side by side, and the scopes that collide. */
export function plan(work: Work, now: Date): Plan {
  const { graph, scored } = scoreAll(work, now);
  const n = graph.issues.length;
  const [group, size] = [Int32Array.from({ length: n }, (_, i) => i), new Int32Array(n).fill(1)];
  const root = (node: number) => {
    while (group[node] !== node) node = group[node] = group[group[node]];
    return node;
  };
  const join = (a: number, b: number) => {
    const [x, y] = [root(a), root(b)];
    if (x === y) return;
    const [small, large] = size[x] < size[y] ? [x, y] : [y, x];
    group[small] = large;
    size[large] += size[small];
  };
  for (let i = 0; i < n; i += 1) {
    for (const blocker of graph.blockers[i]) join(i, blocker);
    if (graph.parent[i] >= 0) join(i, graph.parent[i]);
  }
  const can = actionable(scored);
  const byRoot = new Map<number, Scored[]>();
  for (const one of can) {
    const key = root(graph.at.get(one.id)!);
    const items = byRoot.get(key);
    if (items) items.push(one);
    else byRoot.set(key, [one]);
  }
  const tracks = [...byRoot.values()]
    .map((items) => items.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)))
    .sort((a, b) => a[0].priority - b[0].priority || a[0].id.localeCompare(b[0].id))
    .map((items, index) => ({
      track: `track-${index + 1}`,
      items: items.map(({ id, title, priority, status, unblocks }) => ({ id, title, priority, status, unblocks })),
    }));
  const { listed, more, cut } = collisions(can.map((one) => graph.issues[graph.at.get(one.id)!]));
  return {
    tracks,
    ready: can.filter((one) => one.status === "open").length,
    blocked: scored.length - can.length,
    overlaps: listed,
    ...(more > 0 ? { moreOverlaps: more } : {}),
    ...(cut ? { overlapsCut: true as const } : {}),
  };
}

/** From an issue down to what must close first, level by level. */
export function blockerChain(
  work: Work,
  id: string,
): { id: string; title: string; status: string; assignee: string | null }[][] {
  const graph = build(work);
  const start = graph.at.get(id);
  if (start === undefined) return [];
  const seen = new Set([id]);
  const chain: string[][] = [];
  const way = (one: string) => (work.blocked.get(one) ?? []).map(refIssue);
  for (let level = way(id); level.length > 0;) {
    const fresh = level.filter((one) => !seen.has(one));
    if (fresh.length === 0) break;
    for (const one of fresh) seen.add(one);
    chain.push(fresh);
    level = [...new Set(fresh.flatMap(way))];
  }
  return chain.map((level) =>
    level.map((one) => {
      const issue = graph.issues[graph.at.get(one)!];
      return { id: one, title: issue.title, status: issue.status, assignee: issue.assignee };
    }),
  );
}

/** Something that needs a look. */
interface Alert {
  type: "stale_claim" | "blocking_cascade";
  id: string;
  message: string;
}

/** What needs a look: a stale claim, an issue holding many back. */
export function alerts(work: Work, now: Date, staleMinutes: number): Alert[] {
  const graph = build(work);
  const found: Alert[] = [];
  graph.issues.forEach((issue, i) => {
    const idle = Math.floor((now.getTime() - Date.parse(issue.updated_at)) / 60_000);
    if (issue.status === "in_progress" && idle >= staleMinutes)
      found.push({
        type: "stale_claim",
        id: issue.id,
        message: `claimed by ${issue.assignee ?? "nobody"}, untouched for ${idle} min`,
      });
    const held = graph.dependents[i].length;
    if (held >= 3)
      found.push({ type: "blocking_cascade", id: issue.id, message: `${held} issues wait for it (${issue.status})` });
  });
  return found;
}
