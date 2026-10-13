import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const PLUGIN = join(__dirname, "..");
const SIDES = ["client", "server", "shared"];

/** The side Paseo's compiler puts a file on; null for a file it refuses to bundle. */
function sideOf(file: string): string | null {
  const path = relative(PLUGIN, file);
  const top = path.split(sep)[0];
  if (SIDES.includes(top)) return top;
  return /^index\.(client|server)\.tsx?$/.exec(path)?.[1] ?? null;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("every file the plugin's code imports is one Paseo's compiler bundles: in client/, server/ or shared/, on its own side", () => {
  const files = [
    ...SIDES.flatMap((side) => sources(join(PLUGIN, side))),
    join(PLUGIN, "index.server.ts"),
    join(PLUGIN, "index.client.tsx"),
  ];
  const refused: string[] = [];
  for (const file of files) {
    const own = sideOf(file);
    // a type-only import leaves nothing in the bundle
    const imports = readFileSync(file, "utf8").matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm);
    for (const [, specifier] of imports) {
      const side = sideOf(resolve(dirname(file), specifier));
      if (side === null || (side !== "shared" && side !== own))
        refused.push(`${relative(PLUGIN, file)} imports ${specifier}`);
    }
  }
  assert.deepEqual(refused, []);
});
