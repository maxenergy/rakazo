import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A tool as the model sees it: name, description and JSON Schema parameters. */
export type BridgeTool = { name: string; description?: string; parameters?: unknown };
export type BridgeCall = { id: string; name: string; arguments: Record<string, unknown> };
export type BridgeResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A local, single-client MCP endpoint (streamable HTTP, JSON responses) that lets a Codex
 * process call the tools of one Rakazo run. It never runs a tool itself: each `tools/call`
 * is held open and handed to Rakazo, which runs it through its normal tool path and
 * answers with `resolve`. Only loopback connections with the run's bearer secret are served.
 */
export class CodexToolBridge {
  readonly token = randomBytes(32).toString("hex");
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private readonly pending = new Map<string, (result: BridgeResult) => void>();
  private readonly queued: BridgeCall[] = [];
  private waiter: ((calls: BridgeCall[]) => void) | undefined;
  private waitTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private tools: BridgeTool[]) {}

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  setTools(tools: BridgeTool[]) {
    this.tools = tools;
  }

  /** Ids of calls Codex is still waiting on. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * The next calls Codex makes. Calls that arrive together (parallel tool use) are
   * collected for a short moment so Rakazo can run them as one step.
   */
  nextCalls(): Promise<BridgeCall[]> {
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.flushSoon();
    });
  }

  resolve(id: string, result: BridgeResult): boolean {
    const respond = this.pending.get(id);
    if (!respond) return false;
    this.pending.delete(id);
    respond(result);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, respond] of this.pending) {
      this.pending.delete(id);
      respond({ content: [{ type: "text", text: "Rakazo stopped this run." }], isError: true });
    }
    clearTimeout(this.waitTimer);
    // Stop accepting now; let the answers above reach the client before dropping sockets.
    this.server.close();
    setTimeout(() => this.server.closeAllConnections?.(), 1_000).unref();
  }

  private flushSoon() {
    if (!this.waiter || this.queued.length === 0 || this.waitTimer) return;
    this.waitTimer = setTimeout(() => {
      this.waitTimer = undefined;
      const waiter = this.waiter;
      if (!waiter || this.queued.length === 0) return;
      this.waiter = undefined;
      waiter(this.queued.splice(0));
    }, 50);
  }

  private authorized(request: IncomingMessage): boolean {
    const remote = request.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return false;
    const header = request.headers.authorization ?? "";
    const expected = Buffer.from(`Bearer ${this.token}`);
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (!this.authorized(request)) return send(response, 401);
    if (request.method !== "POST") return send(response, 405);
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      return send(response, 400, rpcError(null, -32700, "Parse error"));
    }
    const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
    const replies = (await Promise.all(messages.map((message) => this.reply(message)))).filter(
      (reply) => reply !== undefined,
    );
    if (replies.length === 0) return send(response, 202);
    send(response, 200, Array.isArray(body) ? replies : replies[0]);
  }

  private async reply(message: JsonRpcRequest): Promise<unknown> {
    // Notifications (no id) need no answer.
    if (message.id === undefined || message.id === null) return undefined;
    const id = message.id;
    switch (message.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "rakazo", version: "1.0.0" },
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: objectSchema(tool.parameters),
          })),
        });
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        if (!this.tools.some((tool) => tool.name === name))
          return rpcResult(id, {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          });
        const args = message.params?.arguments;
        const call: BridgeCall = {
          id: `mcp_${randomUUID()}`,
          name,
          arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
        };
        const result = await new Promise<BridgeResult>((resolve) => {
          this.pending.set(call.id, resolve);
          this.queued.push(call);
          this.flushSoon();
        });
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  }
}

function objectSchema(parameters: unknown): unknown {
  if (parameters && typeof parameters === "object") return parameters;
  return { type: "object", properties: {} };
}

function rpcResult(id: string | number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function send(response: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
