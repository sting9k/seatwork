export type Hook = (input: never, context: never) => unknown;

interface UsageSource {
  discover(scope: object): Promise<{ key: string }[]>;
  fetch(input: unknown): Promise<{ status: string; balances?: { limit?: number | null }[] }>;
}

/** Paseo's side of a plugin as far as the room uses it: what the plugin registered, and a way to fire it. */
export function fakeServer() {
  const registered = new Map<string, Hook[]>();
  let usage: UsageSource | undefined;
  const add = (key: string, hook: Hook) => {
    registered.set(key, [...(registered.get(key) ?? []), hook]);
    return () =>
      void registered.set(
        key,
        (registered.get(key) ?? []).filter((kept) => kept !== hook),
      );
  };
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "missing", values: {} }),
      subscribe: () => () => {},
    }),
    before: (name: string, hook: Hook) => add(`before ${name}`, hook),
    on: (name: string, hook: Hook) => add(`on ${name}`, hook),
    registerUsageSource: (source: UsageSource) => void (usage = source),
    handle: (contract: { name: string }, handler: Hook) => void registered.set(`rpc ${contract.name}`, [handler]),
  };
  return {
    server: server as never,
    usage: () => usage,
    /** Every hook the plugin still has registered, by name. */
    names: () =>
      [...registered]
        .filter(([, hooks]) => hooks.length > 0)
        .map(([name]) => name)
        .sort(),
    async call(name: string, input: unknown, context: unknown = {}): Promise<unknown> {
      const hooks = registered.get(name) ?? [];
      if (!name.startsWith("before ")) {
        let result: unknown;
        for (const hook of hooks) result = await hook(input as never, context as never);
        return result;
      }
      let request = (input as { request: unknown }).request;
      for (const hook of hooks) request = (await hook({ request } as never, context as never)) ?? request;
      return request;
    },
  };
}
