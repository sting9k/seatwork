import config from "../../shared/work.json";
import type { Dependency, Issue } from "./store";

/** A project's open issues as a graph: what to do next, what runs side by side, what blocks. */

/** `ready`: the issues the store lets a seat claim now; without it the graph judges itself. */
export interface Work {
  issues: readonly Issue[];
  dependencies: readonly Dependency[];
  ready: ReadonlySet<string>;
}

const { weights, urgentLabels, impactShare, unblockBoost, readyBoost, exactBetweennessUpTo, sampledSources } =
  config.triage;
const URGENT = new Set(urgentLabels);

/** Open issues by number: blockers[i] is what i waits for, inWay[i] how many stand in its way. */
interface Graph {
  issues: Issue[];
  at: Map<string, number>;
  blockers: number[][];
  dependents: number[][];
  parent: Int32Array;
  children: number[][];
  inWay: Int32Array;
}

function build({ issues, dependencies }: Work): Graph {
  const open = issues.filter((issue) => issue.status !== "closed");
  const n = open.length;
  const at = new Map(open.map((issue, index) => [issue.id, index]));
  const blockers: number[][] = Array.from({ length: n }, () => []);
  const dependents: number[][] = Array.from({ length: n }, () => []);
  const children: number[][] = Array.from({ length: n }, () => []);
  const parent = new Int32Array(n).fill(-1);
  for (const dep of dependencies) {
    const [from, to] = [at.get(dep.issue_id), at.get(dep.depends_on_id)];
    if (from === undefined || to === undefined) continue;
    if (dep.type === "blocks") {
      blockers[from].push(to);
      dependents[to].push(from);
    } else if (dep.type === "parent-child") {
      parent[from] = to;
      children[to].push(from);
    }
  }
  // what a parent waits for, its children wait for: summed down the tree once
  const above = new Int32Array(n).fill(-1);
  const inherited = (start: number): number => {
    const path: number[] = [];
    let node = start;
    while (node >= 0 && above[node] < 0 && path.length <= n) {
      path.push(node);
      node = parent[node];
    }
    let sum = node >= 0 && above[node] >= 0 ? above[node] + blockers[node].length : 0;
    for (let i = path.length - 1; i >= 0; i -= 1) {
      above[path[i]] = sum;
      sum += blockers[path[i]].length;
    }
    return above[start];
  };
  const inWay = new Int32Array(n);
  for (let i = 0; i < n; i += 1) inWay[i] = blockers[i].length + children[i].length + inherited(i);
  return { issues: open, at, blockers, dependents, parent, children, inWay };
}

/** The ids in an issue's way: its blockers, its open children, what blocks its parents. */
function inTheWay(graph: Graph, i: number): string[] {
  const found = new Set([...graph.blockers[i], ...graph.children[i]]);
  for (let up = graph.parent[i], hops = 0; up >= 0 && hops <= graph.issues.length; up = graph.parent[up], hops += 1)
    for (const blocker of graph.blockers[up]) found.add(blocker);
  return [...found].map((index) => graph.issues[index].id);
}

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
    // the array is the queue: `head` reads where `tail` wrote
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

/** Tarjan's components, without recursion: the issues that wait for each other in a ring. */
function rings(graph: Graph): number[][] {
  const n = graph.issues.length;
  const [low, seen, onStack] = [new Int32Array(n), new Int32Array(n).fill(-1), new Uint8Array(n)];
  const stack: number[] = [];
  const found: number[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root += 1) {
    if (seen[root] >= 0) continue;
    const walk: [node: number, edge: number][] = [[root, 0]];
    while (walk.length > 0) {
      const frame = walk[walk.length - 1];
      const [node] = frame;
      if (frame[1] === 0) {
        seen[node] = low[node] = counter++;
        stack.push(node);
        onStack[node] = 1;
      }
      const next = graph.blockers[node][frame[1]];
      if (next !== undefined) {
        frame[1] += 1;
        if (seen[next] < 0) walk.push([next, 0]);
        else if (onStack[next]) low[node] = Math.min(low[node], seen[next]);
        continue;
      }
      walk.pop();
      if (walk.length > 0) low[walk[walk.length - 1][0]] = Math.min(low[walk[walk.length - 1][0]], low[node]);
      if (low[node] !== seen[node]) continue;
      const ring: number[] = [];
      for (let member = -1; member !== node;) {
        member = stack.pop()!;
        onStack[member] = 0;
        ring.push(member);
      }
      if (ring.length > 1) found.push(ring);
    }
  }
  return found;
}

/** Per issue, 1 plus the longest chain waiting behind it: Kahn's order, then one pass. */
function depths(graph: Graph): Int32Array {
  const n = graph.issues.length;
  const waiting = Int32Array.from(graph.blockers, (list) => list.length);
  const order = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i += 1) if (waiting[i] === 0) order[tail++] = i;
  for (let head = 0; head < tail; head += 1)
    for (const next of graph.dependents[order[head]]) if ((waiting[next] -= 1) === 0) order[tail++] = next;
  // an issue on a ring never reaches the order: it keeps depth 1
  const depth = new Int32Array(n).fill(1);
  for (let i = tail - 1; i >= 0; i -= 1) {
    const node = order[i];
    for (const next of graph.dependents[node]) depth[node] = Math.max(depth[node], 1 + depth[next]);
  }
  return depth;
}

/** The issues nothing would hold back once this one closed. */
function freedBy(graph: Graph, i: number): number[] {
  const freed = graph.dependents[i].filter((other) => graph.inWay[other] === 1);
  const up = graph.parent[i];
  if (up >= 0 && graph.inWay[up] === 1) freed.push(up);
  return freed;
}

const peak = (values: ArrayLike<number>) => {
  let top = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] > top) top = values[i];
  return top;
};

export interface Scored {
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

function scoreAll(work: Work, now: Date): { graph: Graph; scored: Scored[] } {
  const graph = build(work);
  const n = graph.issues.length;
  const [rank, bridge, depth] = [pagerank(graph), betweenness(graph), depths(graph)];
  const [topRank, topBridge] = [peak(rank), peak(bridge)];
  const freed = graph.issues.map((_, i) => freedBy(graph, i));
  const mostHeld = Math.max(1, ...graph.dependents.map((list) => list.length));
  const mostFreed = Math.max(5, ...freed.map((list) => list.length));
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
      blocked_by: graph.inWay[i] > 0 ? inTheWay(graph, i) : [],
      ready,
      claimable: ready && !issue.assignee && issue.issue_type !== "epic",
    });
  }
  scored.sort((a, b) => b.score - a.score || a.priority - b.priority || a.id.localeCompare(b.id));
  return { graph, scored };
}

const actionable = (scored: readonly Scored[]) =>
  scored.filter((one) => one.ready || (one.status === "in_progress" && one.blocked_by.length === 0));

export interface Triage {
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
      blocked: scored.filter((one) => one.blocked_by.length > 0).length,
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

/** A word that names a file without a folder: a name, a dot, a lettered extension. */
const FILE_NAME = /^[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]*$/;

/** The paths a write scope names, `./` and line numbers dropped; a glob counts from its folder. */
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

/** Pairs of issues whose write scopes share a path or hold one inside the other. */
function collisions(issues: readonly Issue[]): { a: string; b: string; paths: string[] }[] {
  const owners = new Map<string, Set<string>>();
  const scopes = issues.map((issue) => [issue.id, scopeOf(issue)] as const);
  for (const [id, paths] of scopes) for (const path of paths) owners.set(path, (owners.get(path) ?? new Set()).add(id));
  const pairs = new Map<string, Set<string>>();
  for (const [id, paths] of scopes)
    for (const path of paths)
      for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
        const outer = path.slice(0, end);
        for (const other of owners.get(outer) ?? []) {
          if (other === id) continue;
          const key = id < other ? `${id}|${other}` : `${other}|${id}`;
          pairs.set(key, (pairs.get(key) ?? new Set()).add(outer));
        }
      }
  return [...pairs].map(([key, paths]) => ({ a: key.split("|")[0], b: key.split("|")[1], paths: [...paths].sort() }));
}

export interface Plan {
  tracks: {
    track: string;
    items: { id: string; title: string; priority: number; status: string; unblocks: string[] }[];
  }[];
  ready: number;
  blocked: number;
  overlaps: { a: string; b: string; paths: string[] }[];
}

/** Groups no dependency joins, which can run side by side, and the scopes that collide. */
export function plan(work: Work, now: Date): Plan {
  const { graph, scored } = scoreAll(work, now);
  const n = graph.issues.length;
  // union-find, halving paths on the way up and hanging the smaller tree under the larger
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
    byRoot.set(key, [...(byRoot.get(key) ?? []), one]);
  }
  const tracks = [...byRoot.values()]
    .map((items) => items.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)))
    .sort((a, b) => a[0].priority - b[0].priority || a[0].id.localeCompare(b[0].id))
    .map((items, index) => ({
      track: `track-${index + 1}`,
      items: items.map(({ id, title, priority, status, unblocks }) => ({ id, title, priority, status, unblocks })),
    }));
  return {
    tracks,
    ready: can.filter((one) => one.status === "open").length,
    blocked: scored.length - can.length,
    overlaps: collisions(can.map((one) => graph.issues[graph.at.get(one.id)!])),
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
  for (let level = inTheWay(graph, start); level.length > 0;) {
    const fresh = level.filter((one) => !seen.has(one));
    if (fresh.length === 0) break;
    for (const one of fresh) seen.add(one);
    chain.push(fresh);
    level = [...new Set(fresh.flatMap((one) => inTheWay(graph, graph.at.get(one)!)))];
  }
  return chain.map((level) =>
    level.map((one) => {
      const issue = graph.issues[graph.at.get(one)!];
      return { id: one, title: issue.title, status: issue.status, assignee: issue.assignee };
    }),
  );
}

export interface Alert {
  type: "stale_claim" | "blocking_cascade" | "cycle";
  id: string;
  message: string;
}

/** What needs a look: a stale claim, an issue holding many back, a ring of waits. */
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
  for (const ring of rings(graph)) {
    const ids = ring.map((index) => graph.issues[index].id).sort();
    found.push({ type: "cycle", id: ids[0], message: `these wait for each other: ${ids.join(", ")}` });
  }
  return found;
}
