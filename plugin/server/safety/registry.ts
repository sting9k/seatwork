/** When a package was first published, from its public registry; read only, bounded in time and size. */

export type Manager = "npm" | "pypi" | "go" | "cargo" | "maven" | "rubygems" | "packagist" | "nuget" | "swift";

const TIMEOUT_MS = 4000;
const MOST_BYTES = 4 << 20;
const KEPT_MOST = 500;
const kept = new Map<string, Promise<string | null>>();

/** A body read up to a size, or null past it. */
async function bounded(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MOST_BYTES) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** A registry document as JSON, or null when it cannot be read in time or in size. */
async function get(url: string): Promise<any> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "agent-room-handin" },
  });
  const text = response.ok ? await bounded(response) : null;
  return text ? JSON.parse(text) : null;
}

/** The earliest of some dates, as ISO text; null for none. */
function earliest(dates: unknown[]): string | null {
  const times = dates
    .map((date) => (typeof date === "number" ? date : typeof date === "string" ? Date.parse(date) : NaN))
    // NuGet dates an unlisted version 1900
    .filter((time) => Number.isFinite(time) && time > Date.UTC(1971, 0, 1));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/** Each registry's way to its first release; a manager missing here has no registry to ask. */
const READERS: Partial<Record<Manager, (name: string) => Promise<string | null>>> = {
  npm: async (name) =>
    (await get(`https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, "@")}`))?.time?.created ?? null,
  pypi: async (name) => {
    const doc = await get(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    return earliest(
      Object.values((doc?.releases ?? {}) as Record<string, { upload_time_iso_8601?: string }[]>)
        .flat()
        .map((file) => file.upload_time_iso_8601),
    );
  },
  cargo: async (name) =>
    (await get(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`))?.crate?.created_at ?? null,
  maven: async (name) => {
    const [group, artifact] = name.split(":");
    if (!group || !artifact) return null;
    const q = encodeURIComponent(`g:"${group}" AND a:"${artifact}"`);
    const doc = await get(`https://search.maven.org/solrsearch/select?q=${q}&core=gav&rows=200&wt=json`);
    return earliest(((doc?.response?.docs ?? []) as { timestamp?: number }[]).map((one) => one.timestamp));
  },
  rubygems: async (name) =>
    earliest(
      ((await get(`https://rubygems.org/api/v1/versions/${encodeURIComponent(name)}.json`)) ?? []).map(
        (one: { created_at?: string }) => one.created_at,
      ),
    ),
  packagist: async (name) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) return null;
    const doc = await get(`https://repo.packagist.org/p2/${name}.json`);
    return earliest(((doc?.packages?.[name] ?? []) as { time?: string }[]).map((one) => one.time));
  },
  nuget: async (name) => {
    const index = await get(
      `https://api.nuget.org/v3/registration5-semver1/${encodeURIComponent(name.toLowerCase())}/index.json`,
    );
    const first = index?.items?.[0];
    const page = first?.items ? first : first?.["@id"] ? await get(first["@id"]) : null;
    return earliest(
      ((page?.items ?? []) as { catalogEntry?: { published?: string } }[]).map((one) => one.catalogEntry?.published),
    );
  },
};

/** A package's first release as its registry gives it, or null when it cannot say in time; dates are kept. */
export function firstRelease(manager: Manager, name: string): Promise<string | null> {
  const key = `${manager}:${name}`;
  const known = kept.get(key);
  if (known) return known;
  const read = READERS[manager];
  const asked = read
    ? read(name)
        .catch(() => null)
        .then((first) => {
          // a registry that could not say is asked again next time
          if (first === null) kept.delete(key);
          return first;
        })
    : Promise.resolve(null);
  if (kept.size >= KEPT_MOST) kept.delete(kept.keys().next().value!);
  kept.set(key, asked);
  return asked;
}
