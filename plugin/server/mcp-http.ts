import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** A minimal MCP server over HTTP POST, no SSE (GET answers 405); each seat's URL `/mcp/<token>/<nonce>` names the caller. */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpCallContext {
  nonce: string;
}

export type McpToolHandler = (args: Record<string, unknown>, context: McpCallContext) => Promise<string>;

/** A plain POST endpoint beside MCP, at `/<name>/<token>`: the guard's hooks call one. */
export type Route = (
  body: string,
  request: { query: URLSearchParams; header(name: string): string | undefined },
) => Promise<{ type: string; text: string }>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY = 4 * 1024 * 1024;

/** A request's body as text, joined as bytes so a letter split between two chunks stays one; past the cap, or if the client goes away first, it is answered 413 and null is returned. */
async function bodyOf(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      if ((size += chunk.length) > MAX_BODY) throw new RangeError("body past the cap");
      chunks.push(chunk);
    }
  } catch {
    res.writeHead(413).end();
    req.destroy();
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The room's loopback server: MCP for the seats' tools, plain routes for the guard's hooks; `visible` picks the tools a session is listed. */
export class McpHttpServer {
  private server: Server | null = null;
  private readonly tools = new Map<string, { tool: McpTool; handler: McpToolHandler }>();
  private readonly routes = new Map<string, Route>();
  visible: ((tool: string, context: McpCallContext) => boolean) | null = null;

  constructor(
    private readonly token: string,
    private readonly serverName: string,
    private readonly version: string,
  ) {}

  /** Offers a tool to every seat that connects. */
  register(tool: McpTool, handler: McpToolHandler): void {
    this.tools.set(tool.name, { tool, handler });
  }

  /** Answers POSTs to `/<name>/<token>`. */
  route(name: string, handler: Route): void {
    this.routes.set(name, handler);
  }

  routeUrl(port: number, name: string): string {
    return `http://127.0.0.1:${port}/${name}/${this.token}`;
  }

  /** Listens on 127.0.0.1:port (0 = random) and resolves the bound port; a request that fails where nothing caught it ends in a 500, never as an unhandled rejection. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) =>
        this.handle(req, res).catch((error) => {
          console.error("seatwork: a request to the room's server failed", error);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }),
      );
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        this.server = server;
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }

  /** The MCP URL of the seat that holds `nonce`. */
  urlFor(port: number, nonce: string): string {
    return `http://127.0.0.1:${port}/mcp/${this.token}/${nonce}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const plain = /^\/([a-z]+)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    const route = plain && plain[1] !== "mcp" ? this.routes.get(plain[1]) : undefined;
    if (plain && route) await this.handleRoute(req, res, url, plain[1], plain[2], route);
    else await this.handleMcp(req, res);
  }

  private async handleRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    name: string,
    token: string,
    route: Route,
  ): Promise<void> {
    if (token !== this.token || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const body = await bodyOf(req, res);
    if (body === null) return;
    try {
      const answer = await route(body, {
        query: url.searchParams,
        header: (header) => [req.headers[header.toLowerCase()]].flat()[0],
      });
      res.writeHead(200, { "Content-Type": answer.type }).end(answer.text);
    } catch (error) {
      console.error(`seatwork: /${name} failed`, error);
      res.writeHead(500).end();
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(req.url ?? "");
    if (!match || match[1] !== this.token) {
      res.writeHead(404).end();
      return;
    }
    const nonce = match[2];
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = await bodyOf(req, res);
    if (body === null) return;
    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify(rpcError(null, -32700, "Parse error")));
      return;
    }
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    const responses: unknown[] = [];
    for (const request of requests) {
      const response = await this.dispatch(request, { nonce });
      if (response !== undefined) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202).end();
      return;
    }
    const payload = Array.isArray(parsed) ? responses : responses[0];
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  }

  /** One JSON-RPC request answered; undefined for a notification, which takes no answer. */
  private async dispatch(request: JsonRpcRequest, context: McpCallContext): Promise<unknown> {
    const id = request.id ?? null;
    const method = request.method ?? "";
    const isNotification = request.id === undefined;
    try {
      switch (method) {
        case "initialize": {
          const requested =
            typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : PROTOCOL_VERSION;
          return rpcResult(id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.serverName, version: this.version },
            instructions:
              "The room's own tools, each named seatwork_*: mail and wake-ups between seats, the project's work store and its graph, the room's record and decisions, its checks on the work, and the seats under you.",
          });
        }
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, {
            tools: [...this.tools.values()]
              .filter((entry) => this.visible?.(entry.tool.name, context) ?? true)
              .map((entry) => entry.tool),
          });
        case "tools/call": {
          const name = typeof request.params?.name === "string" ? request.params.name : "";
          const entry = this.tools.get(name);
          if (!entry) return rpcError(id, -32602, `Unknown tool: ${name}`);
          const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
          try {
            const text = await entry.handler(args, context);
            return rpcResult(id, { content: [{ type: "text", text }], isError: false });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
          }
        }
        default:
          if (isNotification || method.startsWith("notifications/")) return undefined;
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (isNotification) return undefined;
      return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }
}

function rpcResult(id: string | number | null, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
