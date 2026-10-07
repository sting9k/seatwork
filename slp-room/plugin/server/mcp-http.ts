import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A minimal MCP server over HTTP (JSON-RPC 2.0 POST, stateless), enough for
 * the harnesses Paseo drives: initialize, ping, tools/list, tools/call.
 * No dependency: the MCP SDK is not available to plugin code at runtime.
 *
 * Every seat gets its own URL `/mcp/<token>/<nonce>`; the nonce identifies the
 * caller (see mail.ts). GET is answered 405 so clients that probe for an SSE
 * stream fall back to plain request/response.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallContext {
  nonce: string;
}

export type McpToolHandler = (args: Record<string, unknown>, context: McpCallContext) => Promise<string>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpHttpServer {
  private server: Server | null = null;
  private readonly tools = new Map<string, { tool: McpTool; handler: McpToolHandler }>();

  constructor(
    private readonly token: string,
    private readonly serverName: string,
    private readonly version: string,
  ) {}

  register(tool: McpTool, handler: McpToolHandler): void {
    this.tools.set(tool.name, { tool, handler });
  }

  /** Listens on 127.0.0.1:port (0 = random) and resolves the bound port. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
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

  urlFor(port: number, nonce: string): string {
    return `http://127.0.0.1:${port}/mcp/${this.token}/${nonce}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify(rpcError(null, -32700, "Parse error")));
      return;
    }
    const requests = Array.isArray(parsed) ? parsed : [parsed];
    const responses: unknown[] = [];
    for (const request of requests) {
      const response = await this.dispatch(request, { nonce });
      if (response !== undefined) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202).end(); // notifications only
      return;
    }
    const payload = Array.isArray(parsed) ? responses : responses[0];
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  }

  private async dispatch(request: JsonRpcRequest, context: McpCallContext): Promise<unknown> {
    const id = request.id ?? null;
    const method = request.method ?? "";
    const isNotification = request.id === undefined;
    try {
      switch (method) {
        case "initialize": {
          const requested = typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : PROTOCOL_VERSION;
          return rpcResult(id, {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.serverName, version: this.version },
            instructions:
              "SLP room mail. slp_mail writes to the Owner (the seat that launched you) or to a seat you launched; the room delivers it between the recipient's turns. slp_inbox reads the mail held for you.",
          });
        }
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: [...this.tools.values()].map((entry) => entry.tool) });
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
