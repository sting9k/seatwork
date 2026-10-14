import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { McpHttpServer } from "../server/mcp-http";

const server = new McpHttpServer("tok3n", "seatwork-test", "1.2.3");
let port = 0;
const output = { error: console.error };

before(async () => {
  console.error = () => {};
  server.register(
    { name: "echo", description: "Echoes.", inputSchema: { type: "object" } },
    async (args, context) => `${context.nonce}:${String(args.word)}`,
  );
  server.register({ name: "break", description: "Fails.", inputSchema: { type: "object" } }, async () => {
    throw new Error("it broke");
  });
  server.route("gate", async (body, request) => ({
    type: "text/plain",
    text: `${body}|${request.query.get("cli")}|${request.header("x-seat")}`,
  }));
  port = await server.listen(0);
});

after(async () => {
  await server.close();
  Object.assign(console, output);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const rpc = (id: number, method: string, params?: object) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
const mcp = `/mcp/tok3n/seat-1`;
const json = (answer: Response) => answer.json() as Promise<any>;

test("a seat's MCP calls reach its tools with its own nonce, and a tool that throws answers as an error the seat can read", async () => {
  const called = await json(await post(mcp, rpc(1, "tools/call", { name: "echo", arguments: { word: "hi" } })));
  assert.deepEqual(called.result, { content: [{ type: "text", text: "seat-1:hi" }], isError: false });

  const broke = await json(await post(mcp, rpc(2, "tools/call", { name: "break" })));
  assert.deepEqual(broke.result, { content: [{ type: "text", text: "it broke" }], isError: true });

  const unknown = await json(await post(mcp, rpc(3, "tools/call", { name: "nope" })));
  assert.equal(unknown.error.code, -32602);

  const listed = await json(await post(mcp, rpc(4, "tools/list")));
  assert.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    ["echo", "break"],
  );
  const hello = await json(await post(mcp, rpc(5, "initialize", { protocolVersion: "2025-01-01" })));
  assert.deepEqual(
    [hello.result.protocolVersion, hello.result.serverInfo],
    ["2025-01-01", { name: "seatwork-test", version: "1.2.3" }],
  );
  assert.equal((await json(await post(mcp, rpc(6, "no/such")))).error.code, -32601);
});

test("a batch is answered in order, and notifications alone are answered with nothing", async () => {
  const both = await json(
    await post(mcp, [rpc(1, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc(2, "ping")]),
  );
  assert.deepEqual(
    both.map((answer: { id: number }) => answer.id),
    [1, 2],
  );
  const quiet = await post(mcp, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(quiet.status, 202);
  assert.equal((await post(mcp, "{not json")).status, 400);
});

test("a request that does not carry the room's token, or is not a POST, is refused", async () => {
  assert.equal((await post("/mcp/wrong/seat-1", rpc(1, "ping"))).status, 404);
  assert.equal((await post("/gate/wrong", "{}")).status, 404);
  assert.equal((await post("/elsewhere/tok3n", "{}")).status, 404);
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal((await get(mcp)).status, 405);
  assert.equal((await get("/gate/tok3n")).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}${mcp}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}${mcp}`, { method: "PUT" })).status, 405);
});

test("a plain route answers with its own type, its query and headers; a body past the cap is refused without being read", async () => {
  const answer = await post("/gate/tok3n?cli=codex", "payload", { "x-seat": "lead-1" });
  assert.deepEqual(
    [answer.status, answer.headers.get("content-type"), await answer.text()],
    [200, "text/plain", "payload|codex|lead-1"],
  );
  const huge = await post(mcp, Buffer.alloc(33 * 1024 * 1024, "a").toString("latin1")).catch(() => null);
  assert.ok(huge === null || huge.status === 413, `status ${huge?.status}`);
  assert.equal(
    (await json(await post(mcp, rpc(1, "ping")))).result !== undefined,
    true,
    "the server went on answering after a refused body",
  );
});
